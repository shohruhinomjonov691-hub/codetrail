import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { CodeTrailError } from '../src/errors.js';
import { LlamaCppEmbedding } from '../src/embedding/llamacpp.js';
import { embeddingRecipeFromLock, type ModelsLock } from '../src/embedding/models.js';
import type { EmbeddingRecipe } from '../src/embedding/recipe.js';
import { validateProviderUrl } from '../src/embedding/url.js';
import { Registry } from '../src/registry.js';
import { buildIndex, loadIndex } from '../src/retrieval/index.js';
import { search } from '../src/retrieval/search.js';
import { ftsQuery, splitIdentifiers } from '../src/retrieval/text.js';
import { createSnapshot } from '../src/snapshot.js';
import { FAKE_MODEL_FILE, FAKE_MODEL_SHA256, startFakeLlama, type FakeLlama } from './fake-llama.js';
import { commitFiles, makeRepo, tempDir, DIST } from './helpers.js';

const ROOT = join(import.meta.dirname, '..');

const FILES = {
	'src/notification.service.ts': `export class NotificationService {\n\tpublic async contactAgent(memberId: string, tourId: string, message: string) {\n\t\treturn this.messageService.deliverTourInquiry(memberId, tourId, message);\n\t}\n}\n`,
	'src/auth.guard.ts': `/** Reads the bearer token and attaches the member. */\nexport class AuthGuard {\n\tcanActivate(request: { headers: { authorization?: string } }) {\n\t\treturn Boolean(request.headers.authorization);\n\t}\n}\n`,
	'src/config.ts': `export function validateEnv(config: Record<string, unknown>) {\n\tif (!config.ALLOWED_ORIGINS) throw new Error('ALLOWED_ORIGINS missing');\n\treturn config;\n}\n`,
	'README.md': '# Demo\n\nTours, guides and inquiries.\n',
};

interface Ctx {
	cfg: RuntimeConfig;
	repoDir: string;
	snapshotId: string;
	recipe: EmbeddingRecipe;
	lockFile: string;
	modelFile: string;
}

function fakeModel(dir: string, dims = 64, maxTokens = 512): { recipe: EmbeddingRecipe; lockFile: string; modelFile: string } {
	// The identity check needs the server to report the very file we verify: use the shared fake model.
	const modelFile = FAKE_MODEL_FILE;
	const sha256 = FAKE_MODEL_SHA256;
	const lock: ModelsLock = {
		schema: 1,
		runtime: { name: 'fake', release: 'test', commit: '0'.repeat(40), license: 'MIT', source: 'test', assets: {} },
		embedding: { name: 'Fake', repo: 'test/fake', revision: 'r', file: 'fake-embed.gguf', url: 'http://127.0.0.1/x', sha256, size: 18, quant: 'Q8_0', license: 'MIT', dims, maxTokens },
	};
	const lockFile = join(dir, 'models.lock.json');
	writeFileSync(lockFile, JSON.stringify(lock));
	return { recipe: embeddingRecipeFromLock(lock), lockFile, modelFile };
}

async function setup(name: string, files: Record<string, string> = FILES, project = 'app'): Promise<Ctx> {
	const root = tempDir(name);
	const repo = makeRepo(root, 'repo', files);
	const cfg: RuntimeConfig = { dataDir: join(root, 'data'), localRoots: [root] };
	const reg = new Registry(cfg.dataDir);
	reg.addProject(project, project);
	reg.addSource(project, { id: 'main', kind: 'local', location: repo.dir, defaultRef: 'main' });
	const snap = await createSnapshot(cfg, project);
	return { cfg, repoDir: repo.dir, snapshotId: snap.report.snapshot_id, ...fakeModel(root) };
}

let fake: FakeLlama;
beforeAll(async () => {
	fake = await startFakeLlama();
});
afterAll(async () => fake.close());

const provider = (recipe: EmbeddingRecipe, url = fake.url, extra: Partial<ConstructorParameters<typeof LlamaCppEmbedding>[0]> = {}) =>
	new LlamaCppEmbedding({ url, allowedHosts: [], recipe, modelFile: FAKE_MODEL_FILE, ...extra });

describe('provider URL policy', () => {
	it('accepts loopback and allowlisted internal hosts only', () => {
		expect(validateProviderUrl('http://127.0.0.1:8081').host).toBe('127.0.0.1:8081');
		expect(validateProviderUrl('http://localhost:8081/').hostname).toBe('localhost');
		expect(validateProviderUrl('http://[::1]:8081').hostname).toBe('[::1]');
		expect(validateProviderUrl('http://embedder:8081', ['embedder']).hostname).toBe('embedder');
	});
	it.each([
		'https://api.openai.com',
		'http://example.com:8081',
		'http://embedder:8081',
		'http://user:pw@127.0.0.1:8081',
		'http://127.0.0.1:8081/v1',
		'http://127.0.0.1:8081/?x=1',
		'http://127.0.0.1:8081/#f',
		'ftp://127.0.0.1',
		'file:///tmp/x',
		'not a url',
	])('rejects %s', (url) => {
		expect(() => validateProviderUrl(url)).toThrow(expect.objectContaining({ code: 'PROVIDER_URL_REJECTED' }));
	});
	it('never follows redirects', async () => {
		const target = await startFakeLlama();
		const redirecting = await startFakeLlama({ redirectTo: `${target.url}/props` });
		const { recipe } = fakeModel(tempDir('redir'));
		await expect(provider(recipe, redirecting.url).verifyServer()).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
		expect(target.stats.hits).toBe(0);
		await Promise.all([target.close(), redirecting.close()]);
	});
	it('enforces the request timeout and the concurrency limit', async () => {
		const slow = await startFakeLlama({ delayMs: 300 });
		const { recipe } = fakeModel(tempDir('slow'));
		await expect(provider(recipe, slow.url, { queryTimeoutMs: 100 }).embed(['q'], 'query')).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
		const bounded = await startFakeLlama({ delayMs: 50 });
		await provider(recipe, bounded.url, { concurrency: 2, batchSize: 1 }).embed(['a', 'b', 'c', 'd', 'e'], 'document');
		expect(bounded.stats.maxConcurrent).toBe(2);
		await Promise.all([slow.close(), bounded.close()]);
	});
	it('rejects a server that serves another model file or a smaller context', async () => {
		const { recipe } = fakeModel(tempDir('mismatch'));
		const other = await startFakeLlama({ modelPath: '/models/other.gguf' });
		await expect(provider(recipe, other.url).verifyServer()).rejects.toMatchObject({ code: 'MODEL_MISMATCH' });
		const small = await startFakeLlama({ nCtx: 128 });
		await expect(provider(recipe, small.url).verifyServer()).rejects.toMatchObject({ code: 'MODEL_MISMATCH' });
		await Promise.all([other.close(), small.close()]);
	});
});

describe('keyword tokenization', () => {
	it('splits identifiers and quotes every FTS term', () => {
		expect(splitIdentifiers('contactAgentHandler deliver_tour-inquiry HTTPServer2x')).toBe('contact agent handler deliver tour inquiry http server'); // 1-char pieces are dropped
		expect(ftsQuery('contactAgent OR path:* "x"')).toBe('"contactagent" OR "or" OR "path" OR "contact" OR "agent"');
		expect(ftsQuery('?? !!')).toBeNull();
	});
});

describe('index build and hybrid search', () => {
	let ctx: Ctx;
	beforeAll(async () => {
		ctx = await setup('index');
	});

	it('builds an index, then reports exists on a second run', async () => {
		const first = await buildIndex(ctx.cfg, 'app', ctx.snapshotId, provider(ctx.recipe));
		expect(first.status).toBe('created');
		expect(first.meta).toMatchObject({ project_id: 'app', snapshot_id: ctx.snapshotId, dims: 64, embedded: { from_cache: 0 } });
		expect(first.meta.chunk_count).toBeGreaterThan(0);
		const again = await buildIndex(ctx.cfg, 'app', ctx.snapshotId, provider(ctx.recipe));
		expect(again.status).toBe('exists');
		expect(again.meta.files).toEqual(first.meta.files);
	});

	it('finds identifiers through split keywords (bm25) and returns snapshot citations', async () => {
		const index = loadIndex(ctx.cfg.dataDir, 'app', ctx.snapshotId, ctx.recipe);
		const hits = await search(index, 'where is the contact agent inquiry sent?', { mode: 'bm25', k: 3 });
		expect(hits[0]?.path).toBe('src/notification.service.ts');
		expect(hits[0]?.citation).toMatch(/^main@[0-9a-f]{12}:src\/notification\.service\.ts:L1-5$/);
		const hybrid = await search(index, 'bearer token authorization guard', { mode: 'hybrid', k: 3 }, provider(ctx.recipe));
		expect(hybrid[0]?.path).toBe('src/auth.guard.ts');
		expect(hybrid.every((h) => h.scores.rrf > 0)).toBe(true);
		const vec = await search(index, 'bearer token authorization guard', { mode: 'vector', k: 2 }, provider(ctx.recipe));
		expect(vec.every((h) => h.scores.vector_cosine !== null && h.scores.bm25_rank === null)).toBe(true);
		index.db.close();
	});

	it('validates the question and k', async () => {
		const index = loadIndex(ctx.cfg.dataDir, 'app', ctx.snapshotId, ctx.recipe);
		await expect(search(index, '   ', { mode: 'bm25' })).rejects.toMatchObject({ code: 'INVALID_QUERY' });
		await expect(search(index, 'x'.repeat(1001), { mode: 'bm25' })).rejects.toMatchObject({ code: 'INVALID_QUERY' });
		await expect(search(index, 'agent', { mode: 'bm25', k: 21 })).rejects.toMatchObject({ code: 'INVALID_QUERY' });
		await expect(search(index, 'agent', { mode: 'hybrid' })).rejects.toBeInstanceOf(CodeTrailError);
		index.db.close();
	});

	it('rejects a provider whose model fingerprint differs from the index', async () => {
		const other = await startFakeLlama({ seed: 'model-b' });
		const index = loadIndex(ctx.cfg.dataDir, 'app', ctx.snapshotId, ctx.recipe);
		await expect(search(index, 'agent', { mode: 'vector' }, provider(ctx.recipe, other.url))).rejects.toMatchObject({ code: 'MODEL_MISMATCH' });
		index.db.close();
		await other.close();
	});

	it('detects tampered artifacts', async () => {
		const c = await setup('tamper');
		const built = await buildIndex(c.cfg, 'app', c.snapshotId, provider(c.recipe));
		const vpath = join(built.dir, 'vectors.f32');
		const bytes = readFileSync(vpath);
		bytes[5] = (bytes[5] as number) ^ 0xff;
		writeFileSync(vpath, bytes);
		expect(() => loadIndex(c.cfg.dataDir, 'app', c.snapshotId, c.recipe)).toThrow(expect.objectContaining({ code: 'INDEX_CORRUPT' }));
	});

	it('is deterministic across fresh data directories', async () => {
		const a = await setup('det-a');
		const b = await setup('det-b');
		const ma = (await buildIndex(a.cfg, 'app', a.snapshotId, provider(a.recipe))).meta;
		const mb = (await buildIndex(b.cfg, 'app', b.snapshotId, provider(b.recipe))).meta;
		expect(a.snapshotId).toBe(b.snapshotId); // fixture commits are deterministic
		expect(ma.files['index.sqlite']).toBe(mb.files['index.sqlite']);
		expect(ma.files['vectors.f32']).toBe(mb.files['vectors.f32']);
		expect(ma.files['probe.f32']).toBe(mb.files['probe.f32']);
	});

	it('re-embeds only changed text for a new snapshot (cache keyed by recipe)', async () => {
		const c = await setup('cache');
		const first = await buildIndex(c.cfg, 'app', c.snapshotId, provider(c.recipe));
		commitFiles(c.repoDir, { 'src/config.ts': `export function validateEnv(config: Record<string, unknown>) {\n\treturn config;\n}\n` });
		const snap2 = (await createSnapshot(c.cfg, 'app')).report.snapshot_id;
		const before = fake.stats.embeddedInputs;
		const second = await buildIndex(c.cfg, 'app', snap2, provider(c.recipe));
		expect(second.meta.embedded.computed).toBe(1);
		expect(second.meta.embedded.from_cache).toBe(first.meta.chunk_count - 1);
		expect(fake.stats.embeddedInputs - before).toBe(2); // the changed chunk + the probe
	});

	it('aborts on over-long inputs instead of truncating, leaving no partial index', async () => {
		const c = await setup('toolong', { ...FILES, 'src/huge.ts': 'export const HUGE_MARKER = 1;\n' });
		const tokenizing = await startFakeLlama({ tokens: (t) => (t.includes('HUGE_MARKER') ? 5000 : 10) });
		await expect(buildIndex(c.cfg, 'app', c.snapshotId, provider(c.recipe, tokenizing.url))).rejects.toMatchObject({
			code: 'TOKEN_LIMIT',
			message: expect.stringContaining('src/huge.ts'),
		});
		const parent = join(c.cfg.dataDir, 'indexes', 'app', c.snapshotId);
		expect(existsSync(parent) ? readdirSync(parent) : []).toEqual([]);
		await tokenizing.close();
	});
});

describe('isolation', () => {
	it('never serves one project index under another project', async () => {
		const a = await setup('iso-a', FILES, 'alpha');
		await buildIndex(a.cfg, 'alpha', a.snapshotId, provider(a.recipe));
		expect(() => loadIndex(a.cfg.dataDir, 'beta', a.snapshotId, a.recipe)).toThrow(CodeTrailError);
		const index = loadIndex(a.cfg.dataDir, 'alpha', a.snapshotId, a.recipe);
		const hits = await search(index, 'agent inquiry token config', { mode: 'hybrid', k: 10 }, provider(a.recipe));
		expect(hits.length).toBeGreaterThan(0);
		for (const h of hits) expect(index.chunks.find((c) => c.id === h.chunk_id)?.snapshot_id).toBe(a.snapshotId);
		index.db.close();
		const otherRecipe = { ...a.recipe, maxTokens: 256 };
		expect(() => loadIndex(a.cfg.dataDir, 'alpha', a.snapshotId, otherRecipe)).toThrow(expect.objectContaining({ code: 'UNKNOWN_INDEX' }));
	});
});

describe('parallel index runs in separate processes', () => {
	it('build once; the others report exists; no partial directories', async () => {
		const c = await setup('par-index');
		const env = {
			...process.env,
			CODETRAIL_DATA_DIR: c.cfg.dataDir,
			CODETRAIL_LOCAL_ROOTS: c.cfg.localRoots.join(':'),
			CODETRAIL_EMBED_URL: fake.url,
			CODETRAIL_MODELS_LOCK: c.lockFile,
			CODETRAIL_EMBED_MODEL_FILE: c.modelFile,
		};
		const run = (): Promise<{ code: number | null; out: string; err: string }> =>
			new Promise((resolve) => {
				const child = spawn(process.execPath, [join(DIST, 'cli.js'), 'index', 'app', c.snapshotId], { env });
				let out = '';
				let err = '';
				child.stdout.on('data', (d: Buffer) => (out += d.toString()));
				child.stderr.on('data', (d: Buffer) => (err += d.toString()));
				child.on('close', (code) => resolve({ code, out, err }));
			});
		const results = await Promise.all([run(), run(), run(), run()]);
		expect(results.map((r) => r.code)).toEqual([0, 0, 0, 0]);
		const statuses = results.map((r) => (JSON.parse(r.out) as { result: string }).result).sort();
		expect(statuses).toEqual(['created', 'exists', 'exists', 'exists']);
		const parent = join(c.cfg.dataDir, 'indexes', 'app', c.snapshotId);
		expect(readdirSync(parent).filter((n) => n.startsWith('.tmp'))).toEqual([]);
		expect(readdirSync(parent)).toHaveLength(1);
	});
});

describe('weights stay out of git and images', () => {
	it('tracks no weight files and ignores them for docker builds', () => {
		const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n');
		expect(tracked.filter((f) => /\.(gguf|safetensors|onnx|bin|pt|pth|ckpt)$/i.test(f) || f.startsWith('models/'))).toEqual([]);
		const dockerignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8');
		for (const p of ['models', 'data', '*.gguf', '*.safetensors', '.env']) expect(dockerignore.split('\n')).toContain(p);
		expect(execFileSync('git', ['check-ignore', 'models/a.gguf', 'x.gguf', 'data/indexes/a'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n')).toHaveLength(3);
	});
});
