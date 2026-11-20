/**
 * Multi-project serving, project isolation, evidence status, the SSE chat stream, request rate
 * limits and the project picker's index states. Real snapshots and indexes of small fixture
 * repositories (a TypeScript one and a Python one) with a fake embedding server and a stub
 * generation provider — no network, no real model.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnswerService, evidenceOf, type AnswerLimits } from '../src/answer/service.js';
import { PROJECT_CATALOG, projectStatuses, statusFile } from '../src/catalog.js';
import type { RuntimeConfig } from '../src/config.js';
import { LlamaCppEmbedding } from '../src/embedding/llamacpp.js';
import { embeddingRecipeFromLock, type ModelsLock } from '../src/embedding/models.js';
import type { EmbeddingRecipe } from '../src/embedding/recipe.js';
import { GenerationError, type GenerationProvider, type GenerationRequest } from '../src/generation/provider.js';
import { Registry } from '../src/registry.js';
import { keywordRag } from '../src/monitor/rag.js';
import { buildIndex } from '../src/retrieval/index.js';
import { clientId, createHttpServer, parsePublicPins, type PublicPin } from '../src/server/http.js';
import { createSnapshot } from '../src/snapshot.js';
import { FAKE_MODEL_FILE, FAKE_MODEL_SHA256, startFakeLlama, type FakeLlama } from './fake-llama.js';
import { makeRepo, tempDir } from './helpers.js';

const GOTRIP = {
	'src/timeout.ts': 'export function requestTimeout(ms: number) {\n\tconst timer = setTimeout(() => {\n\t\tthrow new TimeoutError("request timeout");\n\t}, ms);\n\treturn timer;\n}\n',
	'src/retry.ts': 'export const retryLimit = 2;\nexport function retryDelay(attempt: number) {\n\treturn 300 * 2 ** attempt;\n}\n',
};
const FINDIT = {
	'findit/detect.py':
		'"""Object detection."""\nimport math\n\n\n@lru_cache\ndef detect_objects(image, confidence=0.25):\n    """Find objects above the confidence threshold.\n\ndef not_a_function():\n    still inside the docstring\n    """\n    return [o for o in model(image) if o.score >= confidence]\n\n\nclass Detector:\n    def __init__(self, weights):\n        self.weights = weights\n\n    async def run(self, image):\n        return detect_objects(image)\n',
};
const KERVAN = { 'menu/order.ts': 'export function placeOrder(items: string[]) {\n\treturn items.length;\n}\n' };

const LIMITS: AnswerLimits = { maxOutputTokens: 2048, maxContextChars: 12000, concurrency: 2, ratePerMinute: 100, dailyLimit: 1000, cacheSize: 50 };

type Mode = 'answered' | 'insufficient' | 'partial' | 'fail';
let mode: Mode = 'answered';
const providerCalls: GenerationRequest[] = [];

/** Cites the first line of the first excerpt it was shown (a valid citation by construction). */
const stub: GenerationProvider = {
	model: 'stub-model',
	async generate(request) {
		providerCalls.push(request);
		if (mode === 'fail') throw new GenerationError('quota', 'quota');
		const head = /\[(S\d+)\][^\n]*\n(\d+)\|/.exec(request.input);
		const claims = mode === 'insufficient' || !head ? [] : [{ text: 'It is defined here.', source_id: head[1], lines: { start: Number(head[2]), end: Number(head[2]) } }];
		const answer = { status: mode === 'insufficient' ? 'insufficient_evidence' : 'answered', claims, partial: mode === 'partial' };
		return { text: JSON.stringify(answer), finishReason: 'stop', model: 'stub-model', usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0 } };
	},
};

let llama: FakeLlama;
let recipe: EmbeddingRecipe;
let cfg: RuntimeConfig;
let service: AnswerService;
let http: Server;
let base: string;
const snaps: Record<string, string> = {};
const pins: PublicPin[] = [];

const embedding = (): LlamaCppEmbedding => new LlamaCppEmbedding({ url: llama.url, allowedHosts: [], recipe, modelFile: FAKE_MODEL_FILE });

async function startHttp(svc: AnswerService, opts: Parameters<typeof createHttpServer>[1] = {}): Promise<{ server: Server; url: string }> {
	const server = createHttpServer(svc, opts);
	await new Promise<void>((resolve) => void server.listen(0, '127.0.0.1', () => resolve()));
	return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

beforeAll(async () => {
	llama = await startFakeLlama();
	const lock: ModelsLock = {
		schema: 1,
		runtime: { name: 'fake', release: 't', commit: '0'.repeat(40), license: 'MIT', source: 't', assets: {} },
		embedding: { name: 'Fake', repo: 'f', revision: 'r', file: 'fake-embed.gguf', url: 'http://127.0.0.1/x', sha256: FAKE_MODEL_SHA256, size: 18, quant: 'Q8_0', license: 'MIT', dims: 64, maxTokens: 512 },
	};
	recipe = embeddingRecipeFromLock(lock);
	const root = tempDir('multi');
	cfg = { dataDir: join(root, 'data'), localRoots: [root] };
	const reg = new Registry(cfg.dataDir);
	for (const [id, files, ref] of [['gotrip', GOTRIP, 'main'], ['findit', FINDIT, 'main'], ['kervan', KERVAN, 'main']] as const) {
		const repo = makeRepo(root, id, files);
		reg.addProject(id, PROJECT_CATALOG.find((p) => p.id === id)!.name);
		reg.addSource(id, { id: 'main', kind: 'local', location: repo.dir, defaultRef: ref });
		snaps[id] = (await createSnapshot(cfg, id)).report.snapshot_id;
		await buildIndex(cfg, id, snaps[id]!, embedding());
	}
	// registered but never snapshotted → NOT_INDEXED
	reg.addProject('food-lens', 'Food Lens');
	reg.addSource('food-lens', { id: 'main', kind: 'local', location: makeRepo(root, 'food-lens', { 'a.ts': 'export const a = 1;\n' }).dir, defaultRef: 'main' });
	// kervan is indexed but NOT pinned on the public server below
	pins.push({ project_id: 'gotrip', snapshot_id: snaps.gotrip! }, { project_id: 'findit', snapshot_id: snaps.findit! });
	service = new AnswerService({ config: cfg, recipe, embedding: embedding(), generation: stub, limits: LIMITS, serve: pins.map((p) => `${p.project_id}:${p.snapshot_id}`) });
	service.load();
	({ server: http, url: base } = await startHttp(service, { pinned: pins, catalog: () => projectStatuses(cfg.dataDir, service.list()) }));
});

afterAll(async () => {
	await new Promise<void>((resolve) => void http.close(() => resolve()));
	service.close();
	await llama.close();
});

const post = (path: string, body: unknown, url = base) => fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

interface SseEvent {
	event: string;
	data: Record<string, unknown>;
}
async function chat(body: unknown, url = base): Promise<{ status: number; type: string | null; events: SseEvent[]; text: string }> {
	const res = await post('/api/chat', body, url);
	const text = await res.text();
	const events = text
		.split('\n\n')
		.filter((b) => b.trim() && !b.startsWith(':'))
		.map((b) => {
			const event = /^event: (.*)$/m.exec(b)?.[1] ?? 'message';
			const data = /^data: (.*)$/m.exec(b)?.[1];
			return { event, data: data ? (JSON.parse(data) as Record<string, unknown>) : {} };
		});
	return { status: res.status, type: res.headers.get('content-type'), events, text };
}

describe('serving several projects', () => {
	it('lists exactly the pinned projects and the state of every catalog project', async () => {
		const body = (await (await fetch(`${base}/api/projects`)).json()) as { projects: { project_id: string }[]; catalog: { project_id: string; state: string; reason: string | null }[]; pinned: boolean };
		expect(body.pinned).toBe(true);
		expect(body.projects.map((p) => p.project_id).sort()).toEqual(['findit', 'gotrip']);
		expect(body.catalog.map((c) => c.project_id)).toEqual(PROJECT_CATALOG.map((p) => p.id));
		const by = Object.fromEntries(body.catalog.map((c) => [c.project_id, c]));
		expect(by.gotrip).toMatchObject({ state: 'ready', reason: null });
		expect(by.findit).toMatchObject({ state: 'ready' });
		// indexed but not served by this server
		expect(by.kervan).toMatchObject({ state: 'error', reason: 'NOT_INDEXED' });
		expect(by['food-lens']).toMatchObject({ state: 'error', reason: 'NOT_INDEXED' });
		expect(by['camera-studio']).toMatchObject({ state: 'error', reason: 'NOT_CONFIGURED' });
		expect(by.codetrail).toMatchObject({ state: 'error', reason: 'NOT_CONFIGURED' });
	});

	it('requires project_id with several pins and refuses projects or snapshots that are not pinned', async () => {
		expect((await post('/api/search', { question: 'timeout' })).status).toBe(400);
		const unknown = await post('/api/search', { project_id: 'kervan', question: 'order' });
		expect(unknown.status).toBe(403);
		expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe('PROJECT_NOT_ALLOWED');
		const wrongSnapshot = await post('/api/search', { project_id: 'gotrip', snapshot_id: snaps.findit, question: 'timeout' });
		expect(wrongSnapshot.status).toBe(403);
		expect(((await wrongSnapshot.json()) as { error: { code: string } }).error.code).toBe('SNAPSHOT_NOT_ALLOWED');
		expect((await post('/api/search', { project_id: ['gotrip'], question: 'timeout' })).status).toBe(403);
	});

	it('search and citations stay inside the selected project', async () => {
		const q = 'request timeout detect objects confidence retry order';
		const a = (await (await post('/api/search', { project_id: 'gotrip', question: q })).json()) as { project_id: string; hits: { path: string; source_id: string; commit: string }[] };
		const b = (await (await post('/api/search', { project_id: 'findit', question: q })).json()) as { project_id: string; hits: { path: string }[] };
		expect(a.project_id).toBe('gotrip');
		expect(b.project_id).toBe('findit');
		expect(a.hits.length).toBeGreaterThan(0);
		expect(b.hits.length).toBeGreaterThan(0);
		expect(a.hits.every((h) => /^src\/(timeout|retry)\.ts$/.test(h.path))).toBe(true);
		expect(b.hits.every((h) => h.path === 'findit/detect.py')).toBe(true);
		expect(a.hits.every((h) => /^[0-9a-f]{40}$/.test(h.commit))).toBe(true);
		expect(JSON.stringify(a)).not.toContain('menu/order.ts');
		expect(JSON.stringify(a)).not.toContain('detect_objects');
		expect(JSON.stringify(b)).not.toContain('requestTimeout');
	});

	it('the answer cache and the model input never cross projects', async () => {
		mode = 'answered';
		providerCalls.length = 0;
		const q = 'where is the timeout and the detect confidence';
		const g1 = (await (await post('/api/explain', { project_id: 'gotrip', question: q })).json()) as { cached: boolean; claims: { citation: { path: string } }[]; evidence: string };
		const f1 = (await (await post('/api/explain', { project_id: 'findit', question: q })).json()) as { cached: boolean; claims: { citation: { path: string } }[] };
		const g2 = (await (await post('/api/explain', { project_id: 'gotrip', question: q })).json()) as { cached: boolean };
		expect(providerCalls).toHaveLength(2); // gotrip, findit; the repeat was cached for gotrip only
		expect([g1.cached, f1.cached, g2.cached]).toEqual([false, false, true]);
		expect(g1.claims[0]!.citation.path).toMatch(/^src\//);
		expect(f1.claims[0]!.citation.path).toBe('findit/detect.py');
		const [gotripCall, finditCall] = providerCalls;
		expect(gotripCall!.input).toContain('Project: GoTrip (gotrip)');
		expect(gotripCall!.input).not.toContain('detect_objects');
		expect(finditCall!.input).toContain('Project: FindIt (findit)');
		expect(finditCall!.input).not.toContain('requestTimeout');
		expect(g1.evidence).toBe('grounded');
	});

	it('indexes and cites Python code (functions, methods, decorators) with exact lines', async () => {
		const res = (await (await post('/api/search', { project_id: 'findit', question: 'detect_objects confidence threshold' })).json()) as { hits: { symbol: string | null; language: string; start_line: number; end_line: number; code: string }[] };
		const hit = res.hits.find((h) => h.symbol === 'detect_objects')!;
		expect(hit.language).toBe('python');
		expect(hit.code.startsWith('@lru_cache\ndef detect_objects')).toBe(true); // decorator stays with its function
		expect(hit.code).toContain('def not_a_function'); // inside the docstring: not split off
		expect(hit.end_line - hit.start_line + 1).toBe(hit.code.split('\n').length);
	});
});

describe('root-cause evidence from a real index', () => {
	it('locates the chunk that holds the line a failure names, then falls back to keyword hits', async () => {
		const { rag, close } = keywordRag(cfg.dataDir, recipe);
		try {
			const at12 = await rag('findit', 'unrelated words', [{ path: 'findit/detect.py', line: 12 }]);
			expect(at12![0]).toMatchObject({ path: 'findit/detect.py', symbol: 'detect_objects' });
			expect(at12![0]!.citation).toMatch(/^main@[0-9a-f]{12}:findit\/detect\.py:L5-12$/);
			const at17 = await rag('findit', '', [{ path: '/srv/app/findit/detect.py', line: 17 }]); // absolute path from a log
			expect(at17![0]).toMatchObject({ symbol: 'Detector' });
			const keywordOnly = await rag('gotrip', 'request timeout');
			expect(keywordOnly!.some((h) => h.path === 'src/timeout.ts')).toBe(true);
			expect(await rag('food-lens', 'x')).toBeNull(); // registered but not indexed: no evidence, no crash
			expect(await rag('camera-studio', 'x')).toBeNull();
			// a project's evidence never contains another project's files
			expect((await rag('gotrip', 'detect_objects confidence', [{ path: 'findit/detect.py' }]))!.every((h) => h.path.startsWith('src/'))).toBe(true);
		} finally {
			close();
		}
	});
});

describe('evidence status and the SSE chat stream', () => {
	it('derives the evidence status from the validated result only', () => {
		expect(evidenceOf('answer', false)).toBe('grounded');
		expect(evidenceOf('answer', true)).toBe('partial');
		expect(evidenceOf('insufficient', false)).toBe('none');
		expect(evidenceOf('fallback', false)).toBe('unverified');
	});

	it('streams searching → analyzing → thinking → streaming, then the validated result', async () => {
		mode = 'answered';
		const r = await chat({ project_id: 'gotrip', question: 'sse order check one' });
		expect(r.status).toBe(200);
		expect(r.type).toContain('text/event-stream');
		expect(r.events.map((e) => (e.event === 'phase' ? `phase:${e.data.phase}` : e.event))).toEqual(['phase:searching', 'phase:analyzing', 'phase:thinking', 'phase:streaming', 'result']);
		const result = r.events.at(-1)!.data as { mode: string; evidence: string; project_id: string; claims: unknown[] };
		expect(result).toMatchObject({ mode: 'answer', evidence: 'grounded', project_id: 'gotrip' });
		expect(result.claims).toHaveLength(1);
	});

	it('reports Partial, No Evidence and sources-only states', async () => {
		mode = 'partial';
		expect((await chat({ project_id: 'gotrip', question: 'sse partial check' })).events.at(-1)!.data).toMatchObject({ mode: 'answer', evidence: 'partial' });
		mode = 'insufficient';
		expect((await chat({ project_id: 'gotrip', question: 'sse insufficient check' })).events.at(-1)!.data).toMatchObject({ mode: 'insufficient', evidence: 'none', claims: [] });
		mode = 'fail';
		const failed = await chat({ project_id: 'gotrip', question: 'sse failing provider check' });
		expect(failed.events.map((e) => (e.event === 'phase' ? e.data.phase : e.event))).toEqual(['searching', 'analyzing', 'thinking', 'streaming', 'result']);
		expect(failed.events.at(-1)!.data).toMatchObject({ mode: 'fallback', evidence: 'unverified', reason: 'quota', claims: [] });
		mode = 'answered';
	});

	it('without a provider there is no thinking phase', async () => {
		const bare = new AnswerService({ config: cfg, recipe, embedding: embedding(), generation: null, limits: LIMITS, serve: [`gotrip:${snaps.gotrip}`] });
		bare.load();
		const s = await startHttp(bare, { pinned: [pins[0]!] });
		try {
			const r = await chat({ question: 'no key at all' }, s.url);
			expect(r.events.map((e) => (e.event === 'phase' ? e.data.phase : e.event))).toEqual(['searching', 'analyzing', 'streaming', 'result']);
			expect(r.events.at(-1)!.data).toMatchObject({ mode: 'fallback', evidence: 'unverified', reason: 'not_configured' });
		} finally {
			await new Promise<void>((resolve) => void s.server.close(() => resolve()));
			bare.close();
		}
	});

	it('answers request errors with plain JSON before any stream starts', async () => {
		for (const [body, status] of [[{ project_id: 'gotrip', question: '   ' }, 400], [{ project_id: 'kervan', question: 'x' }, 403], [{ question: 'x' }, 400], [{ project_id: 'gotrip', question: 'x', language: 'de' }, 400]] as const) {
			const res = await post('/api/chat', body);
			expect(res.status).toBe(status);
			expect(res.headers.get('content-type')).toContain('application/json');
		}
		expect((await fetch(`${base}/api/chat`)).status).toBe(405);
	});

	it('a client that disconnects mid-stream does not break the server or leak a limiter slot', async () => {
		mode = 'answered';
		const slow: GenerationProvider = { model: 'slow', generate: (r) => new Promise((resolve, reject) => { const t = setTimeout(() => resolve({ text: JSON.stringify({ status: 'insufficient_evidence', claims: [], partial: false }), finishReason: 'stop', model: 'slow', usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } }), 400); r.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }); }) };
		const svc = new AnswerService({ config: cfg, recipe, embedding: embedding(), generation: slow, limits: { ...LIMITS, ratePerMinute: 1 }, serve: [`gotrip:${snaps.gotrip}`] });
		svc.load();
		const s = await startHttp(svc, { pinned: [pins[0]!] });
		try {
			const controller = new AbortController();
			const res = await fetch(`${s.url}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'disconnect while thinking' }), signal: controller.signal });
			const reader = res.body!.getReader();
			const first = new TextDecoder().decode((await reader.read()).value);
			expect(first).toContain('event: phase');
			controller.abort();
			await reader.cancel().catch(() => {});
			await new Promise((r) => setTimeout(r, 100));
			// the provider call had already started, so it is billed and its slot is used; the server itself stays healthy
			expect((await post('/api/search', { question: 'still alive' }, s.url)).status).toBe(200);
			expect((await fetch(`${s.url}/api/projects`)).status).toBe(200);
		} finally {
			await new Promise<void>((resolve) => void s.server.close(() => resolve()));
			svc.close();
		}
	});
});

describe('request limits', () => {
	it('limits requests per client per minute across search, explain and chat (429 RATE_LIMITED)', async () => {
		const s = await startHttp(service, { pinned: pins, requestsPerMinute: 3 });
		try {
			const ok = [];
			for (let i = 0; i < 3; i++) ok.push((await post('/api/search', { project_id: 'gotrip', question: `limit ${i}` }, s.url)).status);
			expect(ok).toEqual([200, 200, 200]);
			const limited = await post('/api/chat', { project_id: 'gotrip', question: 'limit 4' }, s.url);
			expect(limited.status).toBe(429);
			expect(((await limited.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
			expect((await post('/api/explain', { project_id: 'gotrip', question: 'limit 5' }, s.url)).status).toBe(429);
			expect((await fetch(`${s.url}/api/projects`)).status).toBe(200); // reading the list is not limited
		} finally {
			await new Promise<void>((resolve) => void s.server.close(() => resolve()));
		}
	});

	it('behind a trusted proxy the client is the LAST X-Forwarded-For entry (earlier ones can be forged)', () => {
		const req = (xff: string | undefined) => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: '10.0.0.9' } }) as never;
		expect(clientId(req('6.6.6.6, 203.0.113.7'), true)).toBe('203.0.113.7');
		expect(clientId(req('203.0.113.7'), true)).toBe('203.0.113.7');
		expect(clientId(req('6.6.6.6, 203.0.113.7'), false)).toBe('10.0.0.9'); // header ignored without a trusted proxy
		expect(clientId(req(undefined), true)).toBe('10.0.0.9');
		expect(clientId(req(' , '), true)).toBe('10.0.0.9');
	});

	it('parses the pin list', () => {
		const a = 'a'.repeat(24);
		const b = 'b'.repeat(24);
		expect(parsePublicPins(`gotrip:${a}, findit:${b}`)).toEqual([{ project_id: 'gotrip', snapshot_id: a }, { project_id: 'findit', snapshot_id: b }]);
		expect(() => parsePublicPins(`gotrip:${a},gotrip:${b}`)).toThrow(/twice/);
		expect(() => parsePublicPins('')).toThrow();
		expect(() => parsePublicPins('gotrip')).toThrow();
		expect(() => parsePublicPins(`gotrip:${a}:x`)).toThrow();
	});
});

describe('project index states', () => {
	it('shows Indexing for a live build, Error for a failed or interrupted one, never Ready without an index', () => {
		const dir = join(cfg.dataDir);
		const put = (id: string, v: unknown): void => {
			mkdirSync(join(dir, 'status'), { recursive: true });
			writeFileSync(statusFile(dir, id), JSON.stringify(v));
		};
		const base = { snapshot_id: 'c'.repeat(24), started_at: '2026-11-19T00:00:00Z', finished_at: null, error_code: null };
		put('codetrail', { ...base, state: 'indexing', pid: process.pid });
		put('camera-studio', { ...base, state: 'indexing', pid: 2_000_000_000 }); // no such process
		put('food-lens', { ...base, state: 'error', pid: 1, error_code: 'MODEL_MISMATCH', finished_at: '2026-11-19T00:01:00Z' });
		const by = Object.fromEntries(projectStatuses(dir, service.list()).map((s) => [s.project_id, s]));
		expect(by.codetrail).toMatchObject({ state: 'indexing', reason: null });
		expect(by['camera-studio']).toMatchObject({ state: 'error', reason: 'INDEX_INTERRUPTED' });
		expect(by['food-lens']).toMatchObject({ state: 'error', reason: 'MODEL_MISMATCH' });
		expect(by.gotrip).toMatchObject({ state: 'ready', chunks: expect.any(Number) });
		// skipped pins (unusable index) are reported with their code
		const skipped = projectStatuses(dir, [], { skipped: [{ project_id: 'gotrip', reason: 'INDEX_OUTDATED' }] }).find((s) => s.project_id === 'gotrip');
		expect(skipped).toMatchObject({ state: 'error', reason: 'INDEX_OUTDATED' });
	});
});
