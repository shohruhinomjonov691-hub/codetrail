/**
 * Regressions for the Codex C1–C2 review (ab83c05..a2b3c08): 1×P1, 2×P2.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { LlamaCppEmbedding } from '../src/embedding/llamacpp.js';
import { embeddingRecipeFromLock, type ModelsLock } from '../src/embedding/models.js';
import { formatDocument, type EmbeddingRecipe } from '../src/embedding/recipe.js';
import { Registry } from '../src/registry.js';
import { buildIndex, loadIndex } from '../src/retrieval/index.js';
import { search } from '../src/retrieval/search.js';
import { createSnapshot } from '../src/snapshot.js';
import { DatabaseSync } from '../src/sqlite.js';
import { startFakeLlama, type FakeLlama } from './fake-llama.js';
import { commitFiles, makeRepo, tempDir } from './helpers.js';

const FILES = {
	'src/a.ts': 'export function alphaHandler(input: string) {\n\treturn input.trim();\n}\n',
	'src/b.ts': 'export function betaGuard(token: string) {\n\treturn token.length > 0;\n}\n',
	'src/c.ts': 'export const gammaConfig = { retries: 3 };\n',
};

function recipeFor(dir: string, maxTokens = 512): EmbeddingRecipe {
	const modelFile = join(dir, 'fake-embed.gguf');
	writeFileSync(modelFile, 'fake');
	const lock: ModelsLock = {
		schema: 1,
		runtime: { name: 'fake', release: 'test', commit: '0'.repeat(40), license: 'MIT', source: 'test', assets: {} },
		embedding: {
			name: 'Fake', repo: 'test/fake', revision: 'r', file: 'fake-embed.gguf', url: 'http://127.0.0.1/x',
			sha256: createHash('sha256').update('fake').digest('hex'), size: 4, quant: 'Q8_0', license: 'MIT', dims: 64, maxTokens,
		},
	};
	return embeddingRecipeFromLock(lock);
}

async function setup(name: string): Promise<{ cfg: RuntimeConfig; repoDir: string; snapshotId: string; recipe: EmbeddingRecipe }> {
	const root = tempDir(name);
	const repo = makeRepo(root, 'repo', FILES);
	const cfg: RuntimeConfig = { dataDir: join(root, 'data'), localRoots: [root] };
	const reg = new Registry(cfg.dataDir);
	reg.addProject('app', 'App');
	reg.addSource('app', { id: 'main', kind: 'local', location: repo.dir, defaultRef: 'main' });
	const snap = await createSnapshot(cfg, 'app');
	return { cfg, repoDir: repo.dir, snapshotId: snap.report.snapshot_id, recipe: recipeFor(root) };
}

const provider = (recipe: EmbeddingRecipe, url: string) => new LlamaCppEmbedding({ url, allowedHosts: [], recipe });

let serverA: FakeLlama;
let serverB: FakeLlama;
beforeAll(async () => {
	serverA = await startFakeLlama({ seed: 'space-a' });
	serverB = await startFakeLlama({ seed: 'space-b' }); // same model file name, dims and context — different vectors
});
afterAll(async () => Promise.all([serverA.close(), serverB.close()]));

async function newSnapshot(cfg: RuntimeConfig, repoDir: string): Promise<string> {
	commitFiles(repoDir, { 'src/c.ts': 'export const gammaConfig = { retries: 5 };\n' });
	return (await createSnapshot(cfg, 'app')).report.snapshot_id;
}

describe('P1 — cache never mixes vectors from different servers', () => {
	it('server B does not reuse vectors cached from server A', async () => {
		const c = await setup('c12-p1');
		await buildIndex(c.cfg, 'app', c.snapshotId, provider(c.recipe, serverA.url));
		const snap2 = await newSnapshot(c.cfg, c.repoDir);
		const built = await buildIndex(c.cfg, 'app', snap2, provider(c.recipe, serverB.url));
		expect(built.meta.embedded.from_cache).toBe(0);
		// every stored vector is B's vector for that chunk
		const index = loadIndex(c.cfg.dataDir, 'app', snap2, c.recipe);
		const fromB = await provider(c.recipe, serverB.url).embed(index.chunks.map((ch) => formatDocument(ch)), 'document');
		fromB.forEach((v, i) => expect(Array.from(index.vectors.subarray(i * 64, (i + 1) * 64))).toEqual(Array.from(v)));
		index.db.close();
	});

	it('the same server still reuses its own cache', async () => {
		const c = await setup('c12-p1-same');
		const first = await buildIndex(c.cfg, 'app', c.snapshotId, provider(c.recipe, serverA.url));
		const snap2 = await newSnapshot(c.cfg, c.repoDir);
		const second = await buildIndex(c.cfg, 'app', snap2, provider(c.recipe, serverA.url));
		expect(second.meta.embedded.from_cache).toBe(first.meta.chunk_count - 1);
	});
});

describe('P2 — the formatted query is token-limited before embedding', () => {
	it('returns TOKEN_LIMIT and never embeds an over-long query', async () => {
		const c = await setup('c12-p2');
		await buildIndex(c.cfg, 'app', c.snapshotId, provider(c.recipe, serverA.url));
		const longQueries = await startFakeLlama({ seed: 'space-a', tokens: (t) => (t.includes('Query:') ? 5000 : 10) });
		const index = loadIndex(c.cfg.dataDir, 'app', c.snapshotId, c.recipe);
		const before = longQueries.stats.embeddedInputs;
		await expect(search(index, 'short question', { mode: 'hybrid' }, provider(c.recipe, longQueries.url))).rejects.toMatchObject({ code: 'TOKEN_LIMIT' });
		expect(longQueries.stats.tokenizeRequests).toBeGreaterThan(0);
		// only the fingerprint probe may have been embedded, never the query
		expect(longQueries.stats.embeddedInputs - before).toBeLessThanOrEqual(1);
		index.db.close();
		await longQueries.close();
	});
});

describe('P2 — corrupt cache entries are recomputed, never published', () => {
	function corruptCache(dataDir: string, value: (dims: number) => Buffer): number {
		let rows = 0;
		const dir = join(dataDir, 'embed-cache');
		for (const file of readdirSync(dir).filter((f) => f.endsWith('.sqlite'))) {
			const db = new DatabaseSync(join(dir, file));
			const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vectors'").all();
			if (tables.length > 0) rows += Number(db.prepare('UPDATE vectors SET v = ?').run(value(64)).changes);
			db.close();
		}
		return rows;
	}
	const nanVec = (dims: number) => Buffer.from(new Float32Array(dims).fill(Number.NaN).buffer);
	const zeroVec = (dims: number) => Buffer.from(new Float32Array(dims).buffer);
	const infVec = (dims: number) => Buffer.from(new Float32Array(dims).fill(Number.POSITIVE_INFINITY).buffer);
	const unnormalized = (dims: number) => Buffer.from(new Float32Array(dims).fill(1).buffer);

	it.each([
		['NaN', nanVec],
		['Infinity', infVec],
		['zero', zeroVec],
		['not unit length', unnormalized],
	])('%s cache vectors are recomputed for a new snapshot', async (_label, value) => {
		const c = await setup(`c12-p3-${_label.replace(/\s/g, '')}`);
		await buildIndex(c.cfg, 'app', c.snapshotId, provider(c.recipe, serverA.url));
		expect(corruptCache(c.cfg.dataDir, value)).toBeGreaterThan(0);
		const snap2 = await newSnapshot(c.cfg, c.repoDir);
		const built = await buildIndex(c.cfg, 'app', snap2, provider(c.recipe, serverA.url));
		expect(built.meta.embedded.from_cache).toBe(0);
		const index = loadIndex(c.cfg.dataDir, 'app', snap2, c.recipe);
		expect(index.vectors.every((x) => Number.isFinite(x))).toBe(true);
		const hits = await search(index, 'beta guard token', { mode: 'vector', k: 3 }, provider(c.recipe, serverA.url));
		expect(hits.every((h) => Number.isFinite(h.scores.vector_cosine))).toBe(true);
		index.db.close();
	});

	it('a ready index whose vectors are invalid is rejected even if its checksums match', async () => {
		const c = await setup('c12-p3-ready');
		const built = await buildIndex(c.cfg, 'app', c.snapshotId, provider(c.recipe, serverA.url));
		const vpath = join(built.dir, 'vectors.f32');
		const bytes = readFileSync(vpath);
		bytes.writeFloatLE(Number.NaN, 0);
		writeFileSync(vpath, bytes);
		const metaPath = join(built.dir, 'meta.json');
		const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
		meta.files['vectors.f32'] = createHash('sha256').update(bytes).digest('hex');
		writeFileSync(metaPath, JSON.stringify(meta, null, 2));
		expect(() => loadIndex(c.cfg.dataDir, 'app', c.snapshotId, c.recipe)).toThrow(expect.objectContaining({ code: 'INDEX_CORRUPT' }));
	});
});

describe('existing artifacts that predate these rules are not accepted silently', () => {
	it('a schema-1 index is reported as INDEX_OUTDATED with the rebuild command', async () => {
		const c = await setup('c12-outdated');
		const built = await buildIndex(c.cfg, 'app', c.snapshotId, provider(c.recipe, serverA.url));
		// Simulate an index published by the previous release: different id, schema 1.
		const { renameSync } = await import('node:fs');
		const metaPath = join(built.dir, 'meta.json');
		const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
		meta.schema = 1;
		writeFileSync(metaPath, JSON.stringify(meta));
		renameSync(built.dir, join(built.dir, '..', 'aaaaaaaaaaaaaaaaaaaaaaaa'));
		expect(() => loadIndex(c.cfg.dataDir, 'app', c.snapshotId, c.recipe)).toThrow(
			expect.objectContaining({ code: 'INDEX_OUTDATED', message: expect.stringContaining(`codetrail index app ${c.snapshotId}`) }),
		);
	});

	it('a different runtime build does not share the cache', async () => {
		const otherBuild = await startFakeLlama({ seed: 'space-a', buildInfo: 'fake-b2' });
		const c = await setup('c12-runtime');
		await buildIndex(c.cfg, 'app', c.snapshotId, provider(c.recipe, serverA.url));
		const snap2 = await newSnapshot(c.cfg, c.repoDir);
		const built = await buildIndex(c.cfg, 'app', snap2, provider(c.recipe, otherBuild.url));
		expect(built.meta.embedded.from_cache).toBe(0);
		expect(built.meta.server.runtime).toBe('fake-b2');
		await otherBuild.close();
	});

	it('cache files from the previous layout are never read', async () => {
		const c = await setup('c12-v1cache');
		const { mkdirSync } = await import('node:fs');
		const dir = join(c.cfg.dataDir, 'embed-cache');
		mkdirSync(dir, { recursive: true });
		const v1 = new DatabaseSync(join(dir, `${'f'.repeat(64)}.sqlite`));
		v1.exec('CREATE TABLE vectors (key TEXT PRIMARY KEY, dims INTEGER NOT NULL, v BLOB NOT NULL)');
		v1.close();
		const built = await buildIndex(c.cfg, 'app', c.snapshotId, provider(c.recipe, serverA.url));
		expect(built.meta.embedded.from_cache).toBe(0);
		expect(readdirSync(dir).some((f) => /^v2-[0-9a-f]{64}\.sqlite$/.test(f))).toBe(true);
	});
});
