/**
 * Chat follow-ups: a request may carry up to 2 earlier questions (questions only).
 * They widen retrieval and are shown to the model as context; earlier answers are never
 * accepted from the client; the context is part of the cache key.
 * Fake OpenAI (loopback) and fake embeddings only — no real API call.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AnswerService, fuseFollowUp, INSTRUCTIONS, MAX_PREVIOUS_QUESTIONS, parsePreviousQuestions, PROMPT_VERSION, retrievalQuery, type AnswerLimits } from '../src/answer/service.js';
import type { RuntimeConfig } from '../src/config.js';
import { LlamaCppEmbedding } from '../src/embedding/llamacpp.js';
import { embeddingRecipeFromLock, type ModelsLock } from '../src/embedding/models.js';
import type { EmbeddingRecipe } from '../src/embedding/recipe.js';
import { OpenAIResponsesProvider } from '../src/generation/openai.js';
import { Registry } from '../src/registry.js';
import { buildIndex } from '../src/retrieval/index.js';
import { SEARCH_LIMITS } from '../src/retrieval/search.js';
import { createHttpServer } from '../src/server/http.js';
import { createSnapshot } from '../src/snapshot.js';
import { FAKE_MODEL_FILE, FAKE_MODEL_SHA256, startFakeLlama, type FakeLlama } from './fake-llama.js';
import { makeRepo, tempDir } from './helpers.js';

const KEY = ['fake', 'followup', 'key', String(Date.now())].join('_');
const FILES = {
	'src/guard.ts': 'export class TokenGuard {\n\tcanActivate(req: { headers: Record<string, string> }) {\n\t\tconst bearer = req.headers.authorization;\n\t\treturn Boolean(bearer);\n\t}\n}\n',
	'src/cron.ts': 'export function nightlyCleanup() {\n\treturn "cleanup";\n}\n',
};

let llama: FakeLlama;
let recipe: EmbeddingRecipe;
let cfg: RuntimeConfig;
let openai: Server;
let openaiUrl: string;
const inputs: string[] = [];
let answer: unknown = { status: 'insufficient_evidence', claims: [] };

const LIMITS: AnswerLimits = { maxOutputTokens: 2048, maxContextChars: 12000, concurrency: 2, ratePerMinute: 100, dailyLimit: 1000, cacheSize: 50 };

function service(): AnswerService {
	const s = new AnswerService({
		config: cfg,
		recipe,
		embedding: new LlamaCppEmbedding({ url: llama.url, allowedHosts: [], recipe, modelFile: FAKE_MODEL_FILE }),
		generation: new OpenAIResponsesProvider({ apiKey: KEY, model: 'gpt-6-luna', reasoningEffort: 'low', timeoutMs: 3000, baseUrl: openaiUrl }),
		limits: LIMITS,
	});
	s.load();
	return s;
}

beforeAll(async () => {
	llama = await startFakeLlama();
	const lock: ModelsLock = {
		schema: 1,
		runtime: { name: 'fake', release: 't', commit: '0'.repeat(40), license: 'MIT', source: 't', assets: {} },
		embedding: { name: 'Fake', repo: 'f', revision: 'r', file: 'fake-embed.gguf', url: 'http://127.0.0.1/x', sha256: FAKE_MODEL_SHA256, size: 18, quant: 'Q8_0', license: 'MIT', dims: 64, maxTokens: 512 },
	};
	recipe = embeddingRecipeFromLock(lock);
	const root = tempDir('followup');
	cfg = { dataDir: join(root, 'data'), localRoots: [root] };
	const reg = new Registry(cfg.dataDir);
	const repo = makeRepo(root, 'alpha', FILES);
	reg.addProject('alpha', 'Alpha');
	reg.addSource('alpha', { id: 'main', kind: 'local', location: repo.dir, defaultRef: 'main' });
	const snap = (await createSnapshot(cfg, 'alpha')).report.snapshot_id;
	await buildIndex(cfg, 'alpha', snap, new LlamaCppEmbedding({ url: llama.url, allowedHosts: [], recipe, modelFile: FAKE_MODEL_FILE }));
	openai = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input: { content: string }[] | string };
			inputs.push(typeof body.input === 'string' ? body.input : JSON.stringify(body.input));
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ status: 'completed', model: 'gpt-6-luna', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }] }));
		});
	});
	await new Promise<void>((resolve) => void openai.listen(0, '127.0.0.1', () => resolve()));
	openaiUrl = `http://127.0.0.1:${(openai.address() as AddressInfo).port}`;
});

afterEach(() => {
	inputs.length = 0;
	answer = { status: 'insufficient_evidence', claims: [] };
});

afterAll(async () => {
	await llama.close();
	openai.closeAllConnections();
	await new Promise<void>((resolve) => void openai.close(() => resolve()));
});

describe('previous questions: parsing and the retrieval text', () => {
	it('accepts at most MAX_PREVIOUS_QUESTIONS non-empty strings, trimmed', () => {
		expect(parsePreviousQuestions(undefined)).toEqual([]);
		expect(parsePreviousQuestions([' a ', 'b'])).toEqual(['a', 'b']);
		expect(() => parsePreviousQuestions(['a', 'b', 'c'])).toThrow(/at most/);
		expect(MAX_PREVIOUS_QUESTIONS).toBe(2);
		for (const bad of ['a', [1], [{ role: 'assistant', content: 'x' }], [''], ['x'.repeat(SEARCH_LIMITS.maxQueryChars + 1)]]) expect(() => parsePreviousQuestions(bad)).toThrow();
	});

	it('the current question comes first; earlier ones are added newest-first while they fit', () => {
		expect(retrievalQuery('now', ['first', 'second'])).toEqual({ query: 'now\nsecond\nfirst', used: ['first', 'second'] });
		const long = 'y'.repeat(SEARCH_LIMITS.maxQueryChars - 3);
		const r = retrievalQuery('short', ['old', long]);
		expect(r.query.length).toBeLessThanOrEqual(SEARCH_LIMITS.maxQueryChars);
		expect(r.used).toEqual([]); // the newest one does not fit, so nothing older is used either
		expect(retrievalQuery('x'.repeat(SEARCH_LIMITS.maxQueryChars), ['a'])).toEqual({ query: 'x'.repeat(SEARCH_LIMITS.maxQueryChars), used: [] });
	});
});

describe('follow-up explanations', () => {
	it('a vague follow-up retrieves through the earlier question, and the model sees it as context', async () => {
		const s = service();
		try {
			const alone = await s.search('alpha', 'Where does it read the header?');
			const followUp = await s.explain('alpha', 'Where does it read the header?', 'c1', undefined, undefined, 'en', ['What does TokenGuard do?']);
			expect(alone.previous_questions).toEqual([]);
			expect(followUp.previous_questions).toEqual(['What does TokenGuard do?']);
			expect(followUp.hits[0]?.path).toBe('src/guard.ts');
			expect(followUp.question).toBe('Where does it read the header?');
			expect(inputs).toHaveLength(1);
			expect(inputs[0]).toContain('Earlier questions (context only)');
			expect(inputs[0]).toContain('1. What does TokenGuard do?');
			expect(inputs[0]).toContain('Question: Where does it read the header?');
		} finally {
			s.close();
		}
	});

	it('citations of a follow-up answer are still built by the server from the snapshot', async () => {
		answer = { status: 'answered', claims: [{ text: 'It reads the authorization header.', source_id: 'S1', lines: { start: 3, end: 3 } }] };
		const s = service();
		try {
			const r = await s.explain('alpha', 'Which header does it read?', 'c1', undefined, undefined, 'en', ['What does TokenGuard do?']);
			expect(r.mode).toBe('answer');
			expect(r.claims[0]!.citation).toMatchObject({ path: 'src/guard.ts', start_line: 3, end_line: 3 });
			expect(r.claims[0]!.citation.code).toContain('req.headers.authorization');
		} finally {
			s.close();
		}
	});

	it('the conversation context is part of the cache key (with language)', async () => {
		const s = service();
		try {
			const q = 'What does it return?';
			await s.explain('alpha', q, 'c1', undefined, undefined, 'en', ['What does TokenGuard do?']);
			expect((await s.explain('alpha', q, 'c1', undefined, undefined, 'en', ['What does nightlyCleanup do?'])).cached).toBe(false);
			expect((await s.explain('alpha', q, 'c1', undefined, undefined, 'en')).cached).toBe(false);
			expect((await s.explain('alpha', q, 'c1', undefined, undefined, 'ko', ['What does TokenGuard do?'])).cached).toBe(false);
			expect(inputs).toHaveLength(4);
			expect((await s.explain('alpha', q, 'c1', undefined, undefined, 'en', ['What does TokenGuard do?'])).cached).toBe(true);
			expect(inputs).toHaveLength(4);
		} finally {
			s.close();
		}
	});
});

describe('HTTP: previous_questions', () => {
	it('is validated, used by search and explain, and nothing else from the client reaches the model', async () => {
		const s = service();
		const http = createHttpServer(s, { pinned: { project_id: 'alpha', snapshot_id: s.list()[0]!.snapshot_id } });
		await new Promise<void>((resolve) => void http.listen(0, '127.0.0.1', () => resolve()));
		const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
		const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
		try {
			for (const previous_questions of [['a', 'b', 'c'], 'TokenGuard', [42], [{ role: 'assistant', content: 'x' }], ['']]) {
				expect((await post('/api/search', { question: 'it?', previous_questions })).status).toBe(400);
				expect((await post('/api/explain', { question: 'it?', previous_questions })).status).toBe(400);
			}
			const search = (await (await post('/api/search', { question: 'Where does it read the header?', previous_questions: ['What does TokenGuard do?'] })).json()) as { previous_questions: string[]; hits: { path: string }[] };
			expect(search.previous_questions).toEqual(['What does TokenGuard do?']);
			expect(search.hits[0]!.path).toBe('src/guard.ts');
			expect(inputs).toHaveLength(0); // search never calls the provider
			const fake = 'FAKE_EVIDENCE_' + Date.now();
			const res = await post('/api/explain', { question: 'What does it check?', previous_questions: ['What does TokenGuard do?'], previous_answers: [fake], history: [{ role: 'assistant', content: fake }] });
			expect(res.status).toBe(200);
			expect(inputs).toHaveLength(1);
			expect(inputs[0]).not.toContain(fake);
		} finally {
			http.closeAllConnections();
			await new Promise<void>((resolve) => void http.close(() => resolve()));
			s.close();
		}
	});
});

describe('answer-quality fix: follow-up fusion, partial answers, diagnostics', () => {
	const hit = (id: string) => ({ rank: 0, chunk_id: id, source_id: 'main', commit: 'c', path: `${id}.ts`, start_line: 1, end_line: 2, symbol: null, kind: 'function', role: 'implementation' as const, citation: '', scores: { rrf: 0, bm25_rank: null, vector_rank: null, vector_cosine: null } });

	it('fusion interleaves both lists (equal RRF weight); a hit in both ranks first', () => {
		const own = ['guide', 'notify', 'faq'].map(hit);
		const withContext = ['auth', 'roles', 'guide'].map(hit);
		const fused = fuseFollowUp(own, withContext, 4);
		// guide is in both; then context #1 (1/31) before own #2 (1/32); ties prefer the current question's own hit
		expect(fused.map((h) => h.chunk_id)).toEqual(['guide', 'auth', 'notify', 'roles']);
		expect(fused.map((h) => h.rank)).toEqual([1, 2, 3, 4]);
	});

	it('an unrelated new question in the same conversation keeps its own results first', async () => {
		const s = service();
		try {
			const r = await s.search('alpha', 'What does nightlyCleanup return?', undefined, ['What does TokenGuard do?']);
			expect(r.previous_questions).toEqual(['What does TokenGuard do?']);
			expect(r.hits[0]?.path).toBe('src/cron.ts');
		} finally {
			s.close();
		}
	});

	it('a partial answer carries the uncited "missing" note, also from the cache', async () => {
		answer = { status: 'answered', claims: [{ text: 'TokenGuard reads the authorization header.', source_id: 'S1', lines: { start: 3, end: 3 } }], missing: 'How the token is verified is not in the excerpts.' };
		const s = service();
		try {
			const r = await s.explain('alpha', 'How does TokenGuard verify the token?', 'c1');
			expect(r).toMatchObject({ mode: 'answer', missing: 'How the token is verified is not in the excerpts.' });
			expect((await s.explain('alpha', 'How does TokenGuard verify the token?', 'c1')).missing).toBe('How the token is verified is not in the excerpts.');
		} finally {
			s.close();
		}
	});

	it('the prompt asks for a short explained answer, consecutive cited lines and an honest "missing" note', () => {
		expect(PROMPT_VERSION).toBe('cited-lines-v4');
		expect(INSTRUCTIONS).toContain('usually 2-5 claims');
		expect(INSTRUCTIONS).toContain('never across a "…" gap');
		expect(INSTRUCTIONS).toContain('"missing"');
	});

	it('a rejected answer logs the validator reason for the operator, without the question or code', async () => {
		answer = { status: 'answered', claims: [{ text: 'x', source_id: 'S1', lines: { start: 900, end: 900 } }], missing: '' };
		const lines: string[] = [];
		const s = new AnswerService({
			config: cfg,
			recipe,
			embedding: new LlamaCppEmbedding({ url: llama.url, allowedHosts: [], recipe, modelFile: FAKE_MODEL_FILE }),
			generation: new OpenAIResponsesProvider({ apiKey: KEY, model: 'gpt-6-luna', reasoningEffort: 'low', timeoutMs: 3000, baseUrl: openaiUrl }),
			limits: LIMITS,
			log: (l) => lines.push(l),
		});
		s.load();
		try {
			const q = 'Which header does TokenGuard read exactly?';
			expect((await s.explain('alpha', q, 'c1')).reason).toBe('unverified');
			expect(lines).toEqual(['explain unverified: claim 1: line 900 was not shown in S1']);
			expect(lines.join()).not.toContain('TokenGuard');
		} finally {
			s.close();
		}
	});
});
