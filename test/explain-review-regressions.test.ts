/**
 * Regressions for the Codex review of 2545d8d..ed0f0cb:
 * P2 cache merged different questions (case / inner whitespace),
 * P2 a cancelled queued request still called the provider,
 * P3 a deadline hit while reading the response body was classified "provider".
 * Fake OpenAI (loopback) and fake embeddings only — no real API call.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AnswerService, type AnswerLimits } from '../src/answer/service.js';
import type { RuntimeConfig } from '../src/config.js';
import { LlamaCppEmbedding } from '../src/embedding/llamacpp.js';
import { embeddingRecipeFromLock, type ModelsLock } from '../src/embedding/models.js';
import type { EmbeddingRecipe } from '../src/embedding/recipe.js';
import { OpenAIResponsesProvider } from '../src/generation/openai.js';
import { Registry } from '../src/registry.js';
import { buildIndex } from '../src/retrieval/index.js';
import { createHttpServer } from '../src/server/http.js';
import { createSnapshot } from '../src/snapshot.js';
import { FAKE_MODEL_FILE, FAKE_MODEL_SHA256, startFakeLlama, type FakeLlama } from './fake-llama.js';
import { makeRepo, tempDir } from './helpers.js';

const KEY = ['fake', 'review', 'key', String(Date.now())].join('_');
const FILES = {
	'src/foo.ts': 'export function Foo() {\n\treturn 1;\n}\nexport function foo() {\n\treturn 2;\n}\nexport const label = "a  b";\nexport const other = "a b";\n',
};
type Reply = { status?: number; body?: unknown; delayMs?: number; bodyDelayMs?: number };

let llama: FakeLlama;
let recipe: EmbeddingRecipe;
let cfg: RuntimeConfig;
let openai: Server;
let openaiUrl: string;
let reply: () => Reply = () => ({ status: 500 });
let calls = 0;

const insufficient = (): Reply => ({ body: { status: 'completed', model: 'gpt-6-luna', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"status":"insufficient_evidence","claims":[]}' }] }] } });
const LIMITS: AnswerLimits = { maxOutputTokens: 2048, maxContextChars: 12000, concurrency: 1, ratePerMinute: 100, dailyLimit: 1000, cacheSize: 50 };

function service(timeoutMs = 3000): AnswerService {
	const s = new AnswerService({
		config: cfg,
		recipe,
		embedding: new LlamaCppEmbedding({ url: llama.url, allowedHosts: [], recipe, modelFile: FAKE_MODEL_FILE }),
		generation: new OpenAIResponsesProvider({ apiKey: KEY, model: 'gpt-6-luna', reasoningEffort: 'low', timeoutMs, baseUrl: openaiUrl }),
		limits: LIMITS,
	});
	s.load();
	return s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
	llama = await startFakeLlama();
	const lock: ModelsLock = {
		schema: 1,
		runtime: { name: 'fake', release: 't', commit: '0'.repeat(40), license: 'MIT', source: 't', assets: {} },
		embedding: { name: 'Fake', repo: 'f', revision: 'r', file: 'fake-embed.gguf', url: 'http://127.0.0.1/x', sha256: FAKE_MODEL_SHA256, size: 18, quant: 'Q8_0', license: 'MIT', dims: 64, maxTokens: 512 },
	};
	recipe = embeddingRecipeFromLock(lock);
	const root = tempDir('explain-review');
	cfg = { dataDir: join(root, 'data'), localRoots: [root] };
	const reg = new Registry(cfg.dataDir);
	const repo = makeRepo(root, 'alpha', FILES);
	reg.addProject('alpha', 'Alpha');
	reg.addSource('alpha', { id: 'main', kind: 'local', location: repo.dir, defaultRef: 'main' });
	const snap = (await createSnapshot(cfg, 'alpha')).report.snapshot_id;
	await buildIndex(cfg, 'alpha', snap, new LlamaCppEmbedding({ url: llama.url, allowedHosts: [], recipe, modelFile: FAKE_MODEL_FILE }));
	openai = createServer((req, res) => {
		req.resume();
		req.on('end', () => {
			calls++;
			const r = reply();
			const body = JSON.stringify(r.body ?? {});
			const send = (): void => {
				res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json' });
				if (r.bodyDelayMs) {
					res.flushHeaders(); // headers now, body later
					setTimeout(() => res.end(body), r.bodyDelayMs);
				} else res.end(body);
			};
			if (r.delayMs) setTimeout(send, r.delayMs);
			else send();
		});
	});
	await new Promise<void>((resolve) => void openai.listen(0, '127.0.0.1', () => resolve()));
	openaiUrl = `http://127.0.0.1:${(openai.address() as AddressInfo).port}`;
});

afterEach(() => {
	calls = 0;
	reply = () => ({ status: 500 });
});

afterAll(async () => {
	await llama.close();
	openai.closeAllConnections();
	await new Promise<void>((resolve) => void openai.close(() => resolve()));
});

describe('P2 — the answer cache keys on the exact question text', () => {
	it('Foo and foo are different questions', async () => {
		reply = insufficient;
		const s = service();
		try {
			await s.explain('alpha', 'What does Foo do?', 'c1');
			const second = await s.explain('alpha', 'What does foo do?', 'c1');
			expect(second.cached).toBe(false);
			expect(calls).toBe(2);
		} finally {
			s.close();
		}
	});

	it('inner whitespace (e.g. inside a string literal) is part of the question', async () => {
		reply = insufficient;
		const s = service();
		try {
			await s.explain('alpha', 'Where is "a b" used?', 'c1');
			const second = await s.explain('alpha', 'Where is "a  b" used?', 'c1');
			expect(second.cached).toBe(false);
			expect(calls).toBe(2);
			// control: the identical question is served from the cache
			expect((await s.explain('alpha', 'Where is "a  b" used?', 'c1')).cached).toBe(true);
			expect(calls).toBe(2);
		} finally {
			s.close();
		}
	});
});

describe('P2 — a cancelled request never reaches the provider', () => {
	it('service: aborting a queued explanation removes it from the queue (calls stay 1)', async () => {
		reply = () => ({ ...insufficient(), delayMs: 400 });
		const s = service();
		try {
			const first = s.explain('alpha', 'What does Foo return?', 'c1');
			await sleep(100); // first holds the only slot
			const ac = new AbortController();
			const second = s.explain('alpha', 'What does foo return?', 'c2', undefined, ac.signal);
			await sleep(50);
			ac.abort();
			await expect(second).rejects.toMatchObject({ name: 'RequestCancelledError' });
			await first;
			await sleep(200);
			expect(calls).toBe(1);
		} finally {
			s.close();
		}
	});

	it('service: an already-aborted signal does not call the provider', async () => {
		reply = insufficient;
		const s = service();
		try {
			const ac = new AbortController();
			ac.abort();
			await expect(s.explain('alpha', 'What does Foo return?', 'c1', undefined, ac.signal)).rejects.toMatchObject({ name: 'RequestCancelledError' });
			expect(calls).toBe(0);
		} finally {
			s.close();
		}
	});

	it('HTTP: a queued client that disconnects does not cause a provider call', async () => {
		reply = () => ({ ...insufficient(), delayMs: 500 });
		const s = service();
		const http = createHttpServer(s);
		await new Promise<void>((resolve) => void http.listen(0, '127.0.0.1', () => resolve()));
		const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
		const post = (question: string, signal?: AbortSignal) =>
			fetch(`${base}/api/explain`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_id: 'alpha', question }), ...(signal ? { signal } : {}) });
		try {
			const first = post('What does Foo return here?');
			await sleep(150);
			const ac = new AbortController();
			const second = post('What does foo return here?', ac.signal).catch((e: unknown) => e);
			await sleep(100);
			ac.abort();
			await second;
			expect((await first).status).toBe(200);
			await sleep(300);
			expect(calls).toBe(1);
		} finally {
			http.closeAllConnections();
			await new Promise<void>((resolve) => void http.close(() => resolve()));
			s.close();
		}
	});
});

describe('P3 — a deadline while reading the body is a timeout', () => {
	it('headers arrive, the body does not before the deadline → reason "timeout"', async () => {
		reply = () => ({ ...insufficient(), bodyDelayMs: 800 });
		const s = service(250);
		try {
			const r = await s.explain('alpha', 'What does Foo return?', 'c1');
			expect(r).toMatchObject({ mode: 'fallback', reason: 'timeout' });
			expect(r.hits.length).toBeGreaterThan(0);
			expect(calls).toBe(1);
		} finally {
			s.close();
		}
	});
});
