/**
 * AI explanation and HTTP API with a fake OpenAI server (loopback) and a fake
 * embedding server — no real API call. Covers project isolation, abstention,
 * server-derived citations, fallbacks (no key, auth, quota, rate limit,
 * timeout, provider error, refusal, invalid or incomplete output), cost
 * controls (search never calls the model, cache, limits, no retries) and that
 * the key never reaches responses, logs or the browser bundle.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AnswerService, FALLBACK_MESSAGE, INSUFFICIENT_MESSAGE, messagesFor, type AnswerLimits, type ExplainResponse } from '../src/answer/service.js';
import type { RuntimeConfig } from '../src/config.js';
import { LlamaCppEmbedding } from '../src/embedding/llamacpp.js';
import { embeddingRecipeFromLock, type ModelsLock } from '../src/embedding/models.js';
import type { EmbeddingRecipe } from '../src/embedding/recipe.js';
import { createGenerationProvider, generationSettings } from '../src/generation/config.js';
import { classifyHttpError, OpenAIResponsesProvider, validateOpenAIBaseUrl } from '../src/generation/openai.js';
import type { GenerationProvider } from '../src/generation/provider.js';
import { Registry } from '../src/registry.js';
import { buildIndex } from '../src/retrieval/index.js';
import { createHttpServer, parsePublicPin, type PublicPin } from '../src/server/http.js';
import { createSnapshot } from '../src/snapshot.js';
import { FAKE_MODEL_FILE, FAKE_MODEL_SHA256, startFakeLlama, type FakeLlama } from './fake-llama.js';
import { makeRepo, tempDir } from './helpers.js';

// Assembled at runtime so the repository holds no credential-shaped literal.
const KEY = ['fake', 'openai', 'key', 'must', 'not', 'leak', String(Date.now())].join('_');
const ALPHA = {
	'src/timeout.ts': 'export function requestTimeout(ms: number) {\n\tconst timer = setTimeout(() => {\n\t\tthrow new TimeoutError("request timeout");\n\t}, ms);\n\treturn timer;\n}\n',
	'src/retry.ts': 'export const retryLimit = 2;\nexport function retryDelay(attempt: number) {\n\treturn 300 * 2 ** attempt;\n}\n',
};
const BETA = {
	'lib/payment.ts': 'export function chargeCard(amount: number) {\n\t// beta-only secret sauce: charge the timeout card\n\treturn amount * 100;\n}\n',
	'lib/timeout.ts': 'export const betaTimeoutMarker = "beta request timeout";\n',
};

interface Recorded {
	headers: IncomingMessage['headers'];
	body: Record<string, unknown>;
}
type Reply = { status?: number; body?: unknown; delayMs?: number; redirect?: string };

let llama: FakeLlama;
let recipe: EmbeddingRecipe;
let cfg: RuntimeConfig;
let openai: Server;
let openaiUrl: string;
let reply: (req: Recorded) => Reply = () => ({ status: 500 });
const requests: Recorded[] = [];
const commits: Record<string, string> = {};

const LIMITS: AnswerLimits = { maxOutputTokens: 2048, maxContextChars: 12000, concurrency: 2, ratePerMinute: 100, dailyLimit: 1000, cacheSize: 50 };

function completed(answer: unknown): Reply {
	return {
		body: {
			status: 'completed',
			model: 'gpt-6-luna',
			output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }],
			usage: { input_tokens: 900, output_tokens: 120, output_tokens_details: { reasoning_tokens: 40 } },
		},
	};
}

function provider(timeoutMs = 2000): GenerationProvider {
	return new OpenAIResponsesProvider({ apiKey: KEY, model: 'gpt-6-luna', reasoningEffort: 'low', timeoutMs, baseUrl: openaiUrl });
}

function service(opts: { generation?: GenerationProvider | null; limits?: Partial<AnswerLimits>; embedUrl?: string; serve?: string[] } = {}): AnswerService {
	const s = new AnswerService({
		config: cfg,
		recipe,
		embedding: new LlamaCppEmbedding({ url: opts.embedUrl ?? llama.url, allowedHosts: [], recipe, modelFile: FAKE_MODEL_FILE }),
		generation: opts.generation === undefined ? provider() : opts.generation,
		limits: { ...LIMITS, ...opts.limits },
		...(opts.serve ? { serve: opts.serve } : {}),
	});
	s.load();
	return s;
}

/** The S# id and a line of the first excerpt the fake OpenAI received that contains `needle`. */
function citeFrom(req: Recorded, needle: string): { source_id: string; line: number } {
	const input = String(req.body.input);
	let current = '';
	for (const l of input.split('\n')) {
		const head = /^\[(S\d+)\]/.exec(l);
		if (head) current = head[1] as string;
		const m = /^(\d+)\| (.*)$/.exec(l);
		if (m && current && (m[2] as string).includes(needle)) return { source_id: current, line: Number(m[1]) };
	}
	throw new Error(`needle not in context: ${needle}`);
}

beforeAll(async () => {
	llama = await startFakeLlama();
	const lock: ModelsLock = {
		schema: 1,
		runtime: { name: 'fake', release: 't', commit: '0'.repeat(40), license: 'MIT', source: 't', assets: {} },
		embedding: { name: 'Fake', repo: 'f', revision: 'r', file: 'fake-embed.gguf', url: 'http://127.0.0.1/x', sha256: FAKE_MODEL_SHA256, size: 18, quant: 'Q8_0', license: 'MIT', dims: 64, maxTokens: 512 },
	};
	recipe = embeddingRecipeFromLock(lock);
	const root = tempDir('explain');
	cfg = { dataDir: join(root, 'data'), localRoots: [root] };
	const reg = new Registry(cfg.dataDir);
	for (const [id, files] of [['alpha', ALPHA], ['beta', BETA]] as const) {
		const repo = makeRepo(root, id, files);
		commits[id] = repo.sha;
		reg.addProject(id, id.toUpperCase());
		reg.addSource(id, { id: 'main', kind: 'local', location: repo.dir, defaultRef: 'main' });
		const snap = (await createSnapshot(cfg, id)).report.snapshot_id;
		await buildIndex(cfg, id, snap, new LlamaCppEmbedding({ url: llama.url, allowedHosts: [], recipe, modelFile: FAKE_MODEL_FILE }));
	}
	openai = createServer((req, res) => {
		let raw = '';
		req.on('data', (c) => (raw += c));
		req.on('end', () => {
			const rec: Recorded = { headers: req.headers, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
			requests.push(rec);
			const r = reply(rec);
			const send = (): void => {
				if (r.redirect) {
					res.writeHead(302, { Location: r.redirect });
					return void res.end();
				}
				res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(r.body ?? {}));
			};
			if (r.delayMs) setTimeout(send, r.delayMs);
			else send();
		});
	});
	await new Promise<void>((resolve) => void openai.listen(0, '127.0.0.1', () => resolve()));
	openaiUrl = `http://127.0.0.1:${(openai.address() as AddressInfo).port}`;
});

afterEach(() => {
	requests.length = 0;
	reply = () => ({ status: 500 });
});

afterAll(async () => {
	await llama.close();
	await new Promise<void>((resolve) => void openai.close(() => resolve()));
});

describe('project isolation and search', () => {
	it('search returns only the selected project and never calls the model', async () => {
		const s = service();
		try {
			const a = await s.search('alpha', 'request timeout');
			const b = await s.search('beta', 'request timeout');
			expect(a.hits.length).toBeGreaterThan(0);
			expect(a.hits.every((h) => h.path.startsWith('src/') && h.commit === commits.alpha)).toBe(true);
			expect(b.hits.every((h) => h.path.startsWith('lib/') && h.commit === commits.beta)).toBe(true);
			expect(a.hits[0]?.code).toBe(readCode(a.hits[0]!.path, a.hits[0]!.start_line, a.hits[0]!.end_line, ALPHA));
			expect(requests).toHaveLength(0);
		} finally {
			s.close();
		}
	});

	it('requires a served project and its served snapshot', async () => {
		const s = service();
		try {
			await expect(s.search(undefined, 'x')).rejects.toMatchObject({ code: 'USAGE' });
			await expect(s.search('gamma', 'x')).rejects.toMatchObject({ code: 'UNKNOWN_PROJECT' });
			await expect(s.search('alpha', 'x', 'f'.repeat(24))).rejects.toMatchObject({ code: 'UNKNOWN_SNAPSHOT' });
			await expect(s.search('alpha', '   ')).rejects.toMatchObject({ code: 'INVALID_QUERY' });
		} finally {
			s.close();
		}
	});

	it('the operator allowlist decides which projects are served', () => {
		const s = service({ serve: ['beta'] });
		try {
			expect(s.list().map((p) => p.project_id)).toEqual(['beta']);
		} finally {
			s.close();
		}
	});

	it('the model only receives excerpts of the selected project', async () => {
		reply = () => completed({ status: 'insufficient_evidence', claims: [] });
		const s = service();
		try {
			await s.explain('alpha', 'request timeout', 'c1');
			const input = String(requests[0]?.body.input);
			expect(input).toContain('src/timeout.ts');
			expect(input).not.toMatch(/lib\/|chargeCard|beta-only|betaTimeoutMarker/);
		} finally {
			s.close();
		}
	});
});

function readCode(path: string, a: number, z: number, files: Record<string, string>): string {
	return (files[path] as string).split('\n').slice(a - 1, z).join('\n');
}

describe('grounded answer', () => {
	it('builds citations (path, lines, commit, exact code) from the snapshot, not the model', async () => {
		reply = (req) => {
			const c = citeFrom(req, 'new TimeoutError');
			return completed({ status: 'answered', claims: [{ text: 'A TimeoutError is thrown when the timer fires.', source_id: c.source_id, lines: { start: c.line, end: c.line } }] });
		};
		const s = service();
		try {
			const r = await s.explain('alpha', 'How does the request timeout work?', 'c1');
			expect(r.mode).toBe('answer');
			expect(r.claims).toHaveLength(1);
			const cite = r.claims[0]!.citation;
			expect(cite).toMatchObject({ source_id: 'main', commit: commits.alpha, path: 'src/timeout.ts', start_line: 3, end_line: 3 });
			expect(cite.code).toBe('\t\tthrow new TimeoutError("request timeout");');
			expect(r.hits.length).toBeGreaterThan(0);
			expect(r.usage).toEqual({ inputTokens: 900, outputTokens: 120, reasoningTokens: 40 });
			const body = requests[0]!.body;
			expect(body).toMatchObject({ model: 'gpt-6-luna', store: false, max_output_tokens: 2048, reasoning: { effort: 'low' } });
			expect(body.text).toMatchObject({ format: { type: 'json_schema', strict: true, name: 'cited_answer' } });
			expect(JSON.stringify(body.text)).not.toMatch(/minLength|maxLength/);
			expect(requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
		} finally {
			s.close();
		}
	});

	it('an out-of-project question gets the abstention message, with sources', async () => {
		reply = () => completed({ status: 'insufficient_evidence', claims: [] });
		const s = service();
		try {
			const r = await s.explain('alpha', 'What is the capital of France?', 'c1');
			expect(r).toMatchObject({ mode: 'insufficient', message: INSUFFICIENT_MESSAGE, claims: [], reason: null });
		} finally {
			s.close();
		}
	});

	it.each([
		['a claim citing a line that was not shown', (req: Recorded) => completed({ status: 'answered', claims: [{ text: 'x', source_id: citeFrom(req, 'TimeoutError').source_id, lines: { start: 900, end: 900 } }] }), 'unverified'],
		['an unknown excerpt id', () => completed({ status: 'answered', claims: [{ text: 'x', source_id: 'S99', lines: { start: 1, end: 1 } }] }), 'unverified'],
		['claims plus one invalid claim (fail-closed, nothing shown)', (req: Recorded) => {
			const c = citeFrom(req, 'TimeoutError');
			return completed({ status: 'answered', claims: [{ text: 'ok', source_id: c.source_id, lines: { start: c.line, end: c.line } }, { text: 'bad', source_id: 'S99', lines: { start: 1, end: 1 } }] });
		}, 'unverified'],
		['non-JSON text', () => ({ body: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Sure! The timeout…' }] }] } }), 'unverified'],
		['an incomplete response (output limit)', () => ({ body: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] } }), 'incomplete'],
		['a refusal', () => ({ body: { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] } }), 'refused'],
		['HTTP 401', () => ({ status: 401, body: { error: { code: 'invalid_api_key', message: `Incorrect API key provided: ${KEY}` } } }), 'auth'],
		['HTTP 429 insufficient_quota', () => ({ status: 429, body: { error: { code: 'insufficient_quota', type: 'insufficient_quota' } } }), 'quota'],
		['HTTP 429 rate limit', () => ({ status: 429, body: { error: { code: 'rate_limit_exceeded' } } }), 'rate_limit'],
		['HTTP 500', () => ({ status: 500, body: { error: { message: 'boom' } } }), 'provider'],
		['a redirect', () => ({ redirect: 'http://127.0.0.1:1/elsewhere' }), 'provider'],
	] as [string, (req: Recorded) => Reply, string][])('%s → sources with fallback "%s", one request, no retry', async (_, make, reason) => {
		reply = make;
		const s = service();
		try {
			const r = await s.explain('alpha', 'How does the request timeout work?', 'c1');
			expect(r).toMatchObject({ mode: 'fallback', message: FALLBACK_MESSAGE, reason, claims: [] });
			expect(r.hits.length).toBeGreaterThan(0);
			expect(r.hits[0]?.code.length).toBeGreaterThan(0);
			expect(requests).toHaveLength(1);
			expect(JSON.stringify(r)).not.toContain(KEY);
		} finally {
			s.close();
		}
	});

	it('a timeout falls back to sources', async () => {
		reply = () => ({ ...completed({ status: 'insufficient_evidence', claims: [] }), delayMs: 600 });
		const s = service({ generation: provider(150) });
		try {
			const r = await s.explain('alpha', 'request timeout', 'c1');
			expect(r).toMatchObject({ mode: 'fallback', reason: 'timeout' });
			expect(r.hits.length).toBeGreaterThan(0);
		} finally {
			s.close();
		}
	});

	it('without a key: sources and "not_configured", no request', async () => {
		const s = service({ generation: null });
		try {
			const r = await s.explain('alpha', 'request timeout', 'c1');
			expect(r).toMatchObject({ mode: 'fallback', reason: 'not_configured', message: FALLBACK_MESSAGE });
			expect(r.hits.length).toBeGreaterThan(0);
			expect(requests).toHaveLength(0);
		} finally {
			s.close();
		}
	});
});

describe('cost controls', () => {
	it('caches validated answers per project/snapshot/question/model', async () => {
		reply = () => completed({ status: 'insufficient_evidence', claims: [] });
		const s = service();
		try {
			// The key is the exact question (only outer whitespace trimmed); see explain-review-regressions.
			const first = await s.explain('alpha', 'request timeout?', 'c1');
			const second = await s.explain('alpha', '  request timeout?  ', 'c2');
			await s.explain('beta', 'request timeout?', 'c1');
			expect(first.cached).toBe(false);
			expect(second.cached).toBe(true);
			expect(requests).toHaveLength(2); // alpha once, beta once
		} finally {
			s.close();
		}
	});

	it('failed calls are not cached', async () => {
		reply = () => ({ status: 500 });
		const s = service();
		try {
			await s.explain('alpha', 'request timeout', 'c1');
			await s.explain('alpha', 'request timeout', 'c1');
			expect(requests).toHaveLength(2);
		} finally {
			s.close();
		}
	});

	it('per-client and daily limits refuse before calling the model', async () => {
		reply = () => completed({ status: 'insufficient_evidence', claims: [] });
		const s = service({ limits: { ratePerMinute: 1, dailyLimit: 2 } });
		try {
			expect((await s.explain('alpha', 'q one timeout', 'c1')).reason).toBeNull();
			expect(await s.explain('alpha', 'q two timeout', 'c1')).toMatchObject({ mode: 'fallback', reason: 'client_rate_limit' });
			expect((await s.explain('alpha', 'q three timeout', 'c2')).reason).toBeNull();
			const r = await s.explain('alpha', 'q four timeout', 'c3');
			expect(r).toMatchObject({ mode: 'fallback', reason: 'daily_limit' });
			expect(r.hits.length).toBeGreaterThan(0);
			expect(requests).toHaveLength(2);
		} finally {
			s.close();
		}
	});

	it('bounds the excerpt context', async () => {
		reply = () => completed({ status: 'insufficient_evidence', claims: [] });
		const s = service({ limits: { maxContextChars: 1000 } });
		try {
			const r = await s.explain('alpha', 'request timeout retry delay', 'c1');
			expect(r.context!.chars).toBeLessThanOrEqual(1000);
			expect(String(requests[0]!.body.input).length).toBeLessThan(1000 + 400);
		} finally {
			s.close();
		}
	});
});

describe('local search failure', () => {
	it('is reported apart from AI problems and never calls the model', async () => {
		const s = service({ embedUrl: 'http://127.0.0.1:9' });
		try {
			await expect(s.search('alpha', 'request timeout')).rejects.toMatchObject({ name: 'SearchUnavailableError' });
			await expect(s.explain('alpha', 'request timeout', 'c1')).rejects.toMatchObject({ name: 'SearchUnavailableError' });
			expect(requests).toHaveLength(0);
		} finally {
			s.close();
		}
	});
});

describe('generation settings and provider guards', () => {
	it('reads the key and limits from the environment; no key → no provider', () => {
		expect(createGenerationProvider(generationSettings({}))).toBeNull();
		const s = generationSettings({ CODETRAIL_OPENAI_API_KEY: KEY, CODETRAIL_AI_MAX_OUTPUT_TOKENS: '1024' });
		expect(s).toMatchObject({ apiKey: KEY, model: 'gpt-6-luna', reasoningEffort: 'low', maxOutputTokens: 1024, concurrency: 2 });
		expect(generationSettings({ CODETRAIL_OPENAI_MODEL: 'gpt-5.4-nano' }).model).toBe('gpt-5.4-nano');
		expect(() => generationSettings({ CODETRAIL_AI_CONCURRENCY: '0' })).toThrow();
		expect(() => generationSettings({ CODETRAIL_OPENAI_REASONING: 'extreme' })).toThrow();
	});

	it('only api.openai.com or a loopback mock are accepted as base URL', () => {
		expect(validateOpenAIBaseUrl('https://api.openai.com')).toBe('https://api.openai.com');
		expect(validateOpenAIBaseUrl('http://127.0.0.1:9999/')).toBe('http://127.0.0.1:9999');
		for (const bad of ['http://api.openai.com', 'https://evil.example', 'https://api.openai.com/v1', 'https://u:p@api.openai.com', 'http://10.0.0.5:80']) {
			expect(() => validateOpenAIBaseUrl(bad)).toThrow();
		}
	});

	it('error messages never echo the provider message (which could quote the key)', () => {
		expect(classifyHttpError(401, { code: 'invalid_api_key' }).message).not.toContain('sk-');
		expect(classifyHttpError(429, { type: 'insufficient_quota' }).kind).toBe('quota');
		expect(classifyHttpError(504, null).kind).toBe('timeout');
	});
});

describe('HTTP API (internal, unpinned module) and UI bundle', () => {
	let s: AnswerService;
	let http: Server;
	let base: string;
	const logs: string[] = [];

	beforeAll(async () => {
		s = service();
		http = createHttpServer(s, { log: (l) => logs.push(l) });
		await new Promise<void>((resolve) => void http.listen(0, '127.0.0.1', () => resolve()));
		base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
	});
	afterAll(async () => {
		await new Promise<void>((resolve) => void http.close(() => resolve()));
		s.close();
	});
	const post = (path: string, body: unknown, type = 'application/json') => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });

	it('serves the UI with a strict CSP and only allowlisted files', async () => {
		const page = await fetch(`${base}/`);
		expect(page.status).toBe(200);
		expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
		expect(await page.text()).toContain('data-i18n="action.explain"');
		for (const p of ['/app.js', '/highlight.js', '/i18n.js', '/style.css']) expect((await fetch(`${base}${p}`)).status).toBe(200);
		for (const p of ['/../package.json', '/web/app.js', '/.env', '/src/cli.ts']) expect((await fetch(`${base}${p}`)).status).toBe(404);
	});

	it('the browser bundle and project list contain no key or provider settings', async () => {
		const web = join(import.meta.dirname, '..', 'web');
		for (const f of readdirSync(web)) {
			const text = readFileSync(join(web, f), 'utf8');
			expect(text).not.toMatch(/CODETRAIL_OPENAI|api\.openai\.com|Authorization|\bsk-[A-Za-z0-9]{8}/);
			expect(text).not.toContain(KEY);
		}
		const projects = await (await fetch(`${base}/api/projects`)).text();
		expect(projects).not.toContain(KEY);
		expect(JSON.parse(projects)).toMatchObject({ ai: { available: true, model: 'gpt-6-luna' } });
	});

	it('the UI has no project picker or repository input and never sends a project id', () => {
		const web = join(import.meta.dirname, '..', 'web');
		const html = readFileSync(join(web, 'index.html'), 'utf8');
		const app = readFileSync(join(web, 'app.js'), 'utf8');
		expect(html).not.toMatch(/<select|type="file"|repo(sitory)? ?url/i);
		expect(app).not.toContain('project_id');
		// the only request payload is the question and the answer language (snapshot_id is shown, never sent)
		expect(app).toContain("{ question, language: state.lang }");
		expect(app).not.toMatch(/snapshot_id\s*:/);
	});

	it('validates requests', async () => {
		expect((await post('/api/search', { question: 'x' })).status).toBe(400);
		expect((await post('/api/search', { project_id: 'gamma', question: 'x' })).status).toBe(404);
		expect((await post('/api/search', '{oops')).status).toBe(400);
		expect((await post('/api/search', { project_id: 'alpha', question: 'x' }, 'text/plain')).status).toBe(415);
		expect((await post('/api/search', { project_id: 'alpha', question: 'x'.repeat(9000) })).status).toBe(413);
		expect((await fetch(`${base}/api/search`)).status).toBe(405);
		expect((await post('/api/search', { project_id: 'alpha', question: 'x'.repeat(1001) })).status).toBe(400);
	});

	it('search and explain flows; logs carry no question, prompt, code or key', async () => {
		reply = () => ({ status: 429, body: { error: { code: 'insufficient_quota' } } });
		const search = await post('/api/search', { project_id: 'alpha', question: 'unique-question-marker timeout' });
		expect(search.status).toBe(200);
		expect(requests).toHaveLength(0);
		const explain = (await (await post('/api/explain', { project_id: 'alpha', question: 'unique-question-marker timeout' })).json()) as ExplainResponse;
		expect(explain).toMatchObject({ mode: 'fallback', reason: 'quota' });
		expect(explain.hits.length).toBeGreaterThan(0);
		const joined = logs.join('\n');
		expect(joined).toContain('mode=fallback reason=quota');
		expect(joined).not.toMatch(/unique-question-marker|TimeoutError/);
		expect(joined).not.toContain(KEY);
	});
});

describe('HTTP: local search down', () => {
	it('returns 503 SEARCH_UNAVAILABLE', async () => {
		const s = service({ embedUrl: 'http://127.0.0.1:9' });
		const http = createHttpServer(s);
		await new Promise<void>((resolve) => void http.listen(0, '127.0.0.1', () => resolve()));
		try {
			const res = await fetch(`http://127.0.0.1:${(http.address() as AddressInfo).port}/api/explain`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_id: 'alpha', question: 'timeout' }) });
			expect(res.status).toBe(503);
			expect(await res.json()).toMatchObject({ error: { code: 'SEARCH_UNAVAILABLE' } });
		} finally {
			await new Promise<void>((resolve) => void http.close(() => resolve()));
			s.close();
		}
	});
});

describe('public server pinned to one project and snapshot', () => {
	let s: AnswerService;
	let http: Server;
	let base: string;
	let pin: PublicPin;

	beforeAll(async () => {
		// The service itself is multi-project; the public HTTP layer pins it.
		s = service();
		const alpha = s.list().find((p) => p.project_id === 'alpha')!;
		pin = { project_id: 'alpha', snapshot_id: alpha.snapshot_id };
		http = createHttpServer(s, { pinned: pin });
		await new Promise<void>((resolve) => void http.listen(0, '127.0.0.1', () => resolve()));
		base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
	});
	afterAll(async () => {
		await new Promise<void>((resolve) => void http.close(() => resolve()));
		s.close();
	});
	const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

	it('lists only the pinned project', async () => {
		const data = (await (await fetch(`${base}/api/projects`)).json()) as { projects: { project_id: string }[]; pinned: boolean };
		expect(data.pinned).toBe(true);
		expect(data.projects.map((p) => p.project_id)).toEqual(['alpha']);
	});

	it('answers without a project id, only from the pinned project', async () => {
		const r = (await (await post('/api/search', { question: 'request timeout' })).json()) as { project_id: string; snapshot_id: string; hits: { path: string; commit: string }[] };
		expect(r.project_id).toBe('alpha');
		expect(r.snapshot_id).toBe(pin.snapshot_id);
		expect(r.hits.length).toBeGreaterThan(0);
		expect(r.hits.every((h) => h.path.startsWith('src/') && h.commit === commits.alpha)).toBe(true);
	});

	it('refuses any other project or snapshot (403) and never calls the model', async () => {
		for (const path of ['/api/search', '/api/explain']) {
			const p = await post(path, { project_id: 'beta', question: 'request timeout' });
			expect(p.status).toBe(403);
			expect(await p.json()).toMatchObject({ error: { code: 'PROJECT_NOT_ALLOWED' } });
			const q = await post(path, { project_id: 'alpha', snapshot_id: 'f'.repeat(24), question: 'request timeout' });
			expect(q.status).toBe(403);
			expect(await q.json()).toMatchObject({ error: { code: 'SNAPSHOT_NOT_ALLOWED' } });
		}
		expect((await post('/api/search', { project_id: 'alpha', snapshot_id: pin.snapshot_id, question: 'request timeout' })).status).toBe(200);
		expect(requests).toHaveLength(0);
	});

	it('out-of-project question abstains; API failure keeps pinned sources', async () => {
		reply = () => completed({ status: 'insufficient_evidence', claims: [] });
		const a = (await (await post('/api/explain', { question: 'How do I bake bread?' })).json()) as ExplainResponse;
		expect(a).toMatchObject({ project_id: 'alpha', mode: 'insufficient', message: INSUFFICIENT_MESSAGE });
		expect(String(requests[0]?.body.input)).not.toMatch(/lib\/|chargeCard|betaTimeoutMarker/);
		reply = () => ({ status: 401, body: { error: { code: 'invalid_api_key' } } });
		const b = (await (await post('/api/explain', { question: 'retry delay attempt' })).json()) as ExplainResponse;
		expect(b).toMatchObject({ project_id: 'alpha', mode: 'fallback', reason: 'auth' });
		expect(b.hits.length).toBeGreaterThan(0);
		expect(b.hits.every((h) => h.path.startsWith('src/'))).toBe(true);
	});

	it('parsePublicPin requires project and a full snapshot id', () => {
		expect(parsePublicPin('gotrip:d75aaec921284e35893092a7')).toEqual({ project_id: 'gotrip', snapshot_id: 'd75aaec921284e35893092a7' });
		for (const bad of [undefined, '', 'gotrip', 'gotrip:', ':d75aaec921284e35893092a7', 'gotrip:d75aaec9', 'Go Trip:d75aaec921284e35893092a7', 'gotrip:d75aaec921284e35893092a7:x']) {
			expect(() => parsePublicPin(bad)).toThrow();
		}
	});
});

describe('answer language (en | ko)', () => {
	it('is passed to the prompt, keyed into the cache and validated', async () => {
		reply = () => completed({ status: 'insufficient_evidence', claims: [] });
		const s = service();
		try {
			const en = await s.explain('alpha', 'request timeout', 'c1', undefined, undefined, 'en');
			const ko = await s.explain('alpha', 'request timeout', 'c1', undefined, undefined, 'ko');
			const koAgain = await s.explain('alpha', 'request timeout', 'c1', undefined, undefined, 'ko');
			expect(requests).toHaveLength(2); // en and ko are different cache entries; the repeat is cached
			expect(String(requests[0]!.body.input)).toContain('Answer language: English');
			expect(String(requests[1]!.body.input)).toContain('Answer language: Korean');
			expect(String(requests[0]!.body.instructions)).toMatch(/never translate code, identifiers, file paths/);
			expect([en.cached, ko.cached, koAgain.cached]).toEqual([false, false, true]);
			expect(en).toMatchObject({ language: 'en', message: INSUFFICIENT_MESSAGE });
			expect(ko).toMatchObject({ language: 'ko', message: messagesFor('ko').insufficient });
			await expect(s.explain('alpha', 'request timeout', 'c1', undefined, undefined, 'fr')).rejects.toMatchObject({ code: 'USAGE' });
			expect(requests).toHaveLength(2);
			// default is English
			expect((await s.explain('alpha', 'request timeout', 'c1')).language).toBe('en');
		} finally {
			s.close();
		}
	});

	it('fallback messages follow the language; HTTP accepts only en|ko', async () => {
		const s = service({ generation: null });
		const http = createHttpServer(s);
		await new Promise<void>((resolve) => void http.listen(0, '127.0.0.1', () => resolve()));
		const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
		const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
		try {
			const ko = (await (await post('/api/explain', { project_id: 'alpha', question: 'request timeout', language: 'ko' })).json()) as ExplainResponse;
			expect(ko).toMatchObject({ language: 'ko', mode: 'fallback', reason: 'not_configured', message: messagesFor('ko').fallback });
			for (const bad of ['fr', 'EN', '', 1, null]) {
				const r = await post('/api/explain', { project_id: 'alpha', question: 'request timeout', language: bad });
				if (bad === null) expect(r.status).toBe(200); // null = default (en)
				else expect(r.status).toBe(400);
			}
			expect((await post('/api/search', { project_id: 'alpha', question: 'request timeout', language: 'de' })).status).toBe(400);
			expect((await post('/api/search', { project_id: 'alpha', question: 'request timeout', language: 'ko' })).status).toBe(200);
		} finally {
			await new Promise<void>((resolve) => void http.close(() => resolve()));
			s.close();
		}
	});

	it('UI text comes from one dictionary with identical en/ko keys; examples fill the field only', async () => {
		const web = join(import.meta.dirname, '..', 'web');
		const { DICT, LANGS, DEFAULT_LANG } = (await import(join(web, 'i18n.js'))) as { DICT: Record<string, Record<string, unknown>>; LANGS: string[]; DEFAULT_LANG: string };
		expect(LANGS).toEqual(['en', 'ko']);
		expect(DEFAULT_LANG).toBe('en');
		expect(Object.keys(DICT.ko!).sort()).toEqual(Object.keys(DICT.en!).sort());
		expect((DICT.en!['examples.items'] as string[]).length).toBe(4);
		expect((DICT.ko!['examples.items'] as string[]).length).toBe(4);
		const html = readFileSync(join(web, 'index.html'), 'utf8');
		for (const m of html.matchAll(/data-i18n(?:-placeholder|-aria)?="([^"]+)"/g)) expect(DICT.en).toHaveProperty([m[1]!]);
		const app = readFileSync(join(web, 'app.js'), 'utf8');
		for (const m of app.matchAll(/\bt\('([a-zA-Z_.]+)'/g)) expect(DICT.en).toHaveProperty([m[1]!]);
		// the chip handler sets the field and focuses it; it does not search
		const chip = app.slice(app.indexOf("chip.addEventListener('click'"), app.indexOf('return chip;'));
		expect(chip).toContain("$('question').value = q;");
		expect(chip).not.toMatch(/run\(|fetch\(/);
		expect(app).toContain("localStorage.setItem(LANG_KEY, lang)");
	});
});
