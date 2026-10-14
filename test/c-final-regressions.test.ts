/**
 * Regressions for the Codex C re-review of 80a54d0..79c211e (1×P1, 1×P2, 1×P3).
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, renameSync, statSync, utimesSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { CodeTrailError } from '../src/errors.js';
import { LlamaCppEmbedding } from '../src/embedding/llamacpp.js';
import { embeddingRecipeFromLock, type ModelsLock } from '../src/embedding/models.js';
import type { EmbeddingProvider } from '../src/embedding/provider.js';
import { PROBE_TEXT, recipeHash, type EmbeddingRecipe } from '../src/embedding/recipe.js';
import { Registry } from '../src/registry.js';
import { EmbeddingCache } from '../src/retrieval/cache.js';
import { buildIndex } from '../src/retrieval/index.js';
import { createSnapshot } from '../src/snapshot.js';
import { DatabaseSync } from '../src/sqlite.js';
import { startFakeLlama, type FakeLlama } from './fake-llama.js';
import { makeRepo, tempDir } from './helpers.js';

const A = 'model bytes A '.repeat(64);
const B = 'model bytes B '.repeat(64); // same length as A
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

function recipeFor(content: string, dims = 64): EmbeddingRecipe {
	const lock: ModelsLock = {
		schema: 1,
		runtime: { name: 'fake', release: 'test', commit: '0'.repeat(40), license: 'MIT', source: 'test', assets: {} },
		embedding: { name: 'Fake', repo: 'test/fake', revision: 'r', file: 'fake-embed.gguf', url: 'http://127.0.0.1/x', sha256: sha(content), size: content.length, quant: 'Q8_0', license: 'MIT', dims, maxTokens: 512 },
	};
	return embeddingRecipeFromLock(lock);
}

describe('P1 — the model hash cannot be satisfied by stale metadata', () => {
	let dir: string;
	let modelFile: string;
	let server: FakeLlama;
	const provider = (): LlamaCppEmbedding =>
		new LlamaCppEmbedding({ url: server.url, allowedHosts: [], recipe: recipeFor(A), modelFile, hashCacheDir: join(dir, 'hash-cache') } as ConstructorParameters<typeof LlamaCppEmbedding>[0]);

	beforeAll(async () => {
		dir = tempDir('p1-hash');
		modelFile = join(dir, 'fake-embed.gguf');
		server = await startFakeLlama({ modelPath: modelFile });
	});
	afterAll(async () => server.close());

	function setA(): void {
		writeFileSync(modelFile, A);
		utimesSync(modelFile, 1_700_000_000, 1_700_000_000);
	}

	it('a different file swapped in with the same size and mtime is rejected', async () => {
		setA();
		await expect(provider().identity()).resolves.toMatchObject({ modelSha256: sha(A) });
		const st = statSync(modelFile);
		const swap = join(dir, 'swap.gguf');
		writeFileSync(swap, B);
		utimesSync(swap, st.atime, st.mtime);
		renameSync(swap, modelFile); // new inode, same path, same size, same mtime
		expect(statSync(modelFile).size).toBe(st.size);
		expect(statSync(modelFile).mtimeMs).toBe(st.mtimeMs);
		await expect(provider().identity()).rejects.toMatchObject({ code: 'MODEL_MISMATCH' });
	});

	it('an in-place modification with the mtime restored is rejected', async () => {
		setA();
		await expect(provider().identity()).resolves.toMatchObject({ modelSha256: sha(A) });
		const st = statSync(modelFile);
		const fd = openSync(modelFile, 'r+');
		writeSync(fd, 'X', 0);
		closeSync(fd);
		utimesSync(modelFile, st.atime, st.mtime);
		await expect(provider().identity()).rejects.toMatchObject({ code: 'MODEL_MISMATCH' });
	});

	it('a change while the file is being hashed is detected', async () => {
		const models = (await import('../src/embedding/models.js')) as unknown as Record<string, unknown>;
		const hashStable = models.sha256FileStable as ((path: string, onChunk?: (n: number) => void) => Promise<string>) | undefined;
		expect(typeof hashStable).toBe('function');
		writeFileSync(modelFile, 'x'.repeat(3 * 1024 * 1024));
		let modified = false;
		await expect(
			hashStable!(modelFile, () => {
				if (!modified) {
					modified = true;
					const fd = openSync(modelFile, 'r+');
					writeSync(fd, 'CHANGED', 2 * 1024 * 1024);
					closeSync(fd);
				}
			}),
		).rejects.toMatchObject({ code: 'MODEL_MISMATCH' });
		expect(modified).toBe(true);
	});
});

describe('P2 — every vector input goes through one strict validator', () => {
	const FILES = { 'src/a.ts': 'export const alpha = 1;\n', 'src/b.ts': 'export const beta = 2;\n' };

	async function setup(name: string): Promise<{ cfg: RuntimeConfig; snapshotId: string }> {
		const root = tempDir(name);
		const repo = makeRepo(root, 'repo', FILES);
		const cfg: RuntimeConfig = { dataDir: join(root, 'data'), localRoots: [root] };
		const reg = new Registry(cfg.dataDir);
		reg.addProject('app', 'App');
		reg.addSource('app', { id: 'main', kind: 'local', location: repo.dir, defaultRef: 'main' });
		return { cfg, snapshotId: (await createSnapshot(cfg, 'app')).report.snapshot_id };
	}

	function custom(dims: number, probe: () => Float32Array, doc: () => Float32Array): EmbeddingProvider {
		const recipe = recipeFor(A, dims);
		return {
			recipe,
			verifyServer: async () => ({ runtime: 'custom-1', modelPath: '/x' }),
			identity: async () => ({ modelSha256: recipe.model.sha256, runtime: 'custom-1', recipeHash: recipeHash(recipe) }),
			countTokens: async () => 5,
			embed: async (inputs) => inputs.map((t) => (t === PROBE_TEXT ? probe() : doc())),
		} as EmbeddingProvider;
	}

	const unit = (dims: number): Float32Array => {
		const v = new Float32Array(dims);
		v[0] = 1;
		return v;
	};

	function leftovers(cfg: RuntimeConfig, snapshotId: string): { readyIndexes: number; cacheRows: number } {
		const parent = join(cfg.dataDir, 'indexes', 'app', snapshotId);
		const readyIndexes = existsSync(parent) ? readdirSync(parent).filter((n) => existsSync(join(parent, n, 'meta.json'))).length : 0;
		let cacheRows = 0;
		const cacheDir = join(cfg.dataDir, 'embed-cache');
		if (existsSync(cacheDir)) {
			for (const f of readdirSync(cacheDir).filter((n) => n.endsWith('.sqlite'))) {
				const db = new DatabaseSync(join(cacheDir, f));
				for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]) {
					cacheRows += Number((db.prepare(`SELECT count(*) AS n FROM ${t.name}`).get() as { n: number }).n);
				}
				db.close();
			}
		}
		return { readyIndexes, cacheRows };
	}

	it.each([
		['[1,0,NaN] with dims=2', 2, () => new Float32Array([1, 0, Number.NaN])],
		['one element too many', 64, () => {
			const v = new Float32Array(65);
			v[0] = 1;
			return v;
		}],
		['one element too few', 64, () => {
			const v = new Float32Array(63);
			v[0] = 1;
			return v;
		}],
		['a plain number array', 64, () => Array.from(unit(64)) as unknown as Float32Array],
	])('an invalid probe (%s) leaves no ready index and no cache entry', async (_label, dims, probe) => {
		const c = await setup('p2-probe');
		await expect(buildIndex(c.cfg, 'app', c.snapshotId, custom(dims, probe, () => unit(dims)))).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
		expect(leftovers(c.cfg, c.snapshotId)).toEqual({ readyIndexes: 0, cacheRows: 0 });
	});

	it.each([
		['too long', () => {
			const v = new Float32Array(65);
			v[0] = 1;
			return v;
		}],
		['NaN tail', () => {
			const v = new Float32Array(64);
			v[0] = 1;
			v[63] = Number.NaN;
			return v;
		}],
	])('an invalid document vector (%s) is rejected before it reaches the index or cache', async (_label, doc) => {
		const c = await setup('p2-doc');
		await expect(buildIndex(c.cfg, 'app', c.snapshotId, custom(64, () => unit(64), doc))).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
		expect(leftovers(c.cfg, c.snapshotId).readyIndexes).toBe(0);
	});

	it('cache putMany requires the exact length', () => {
		const identity = { modelSha256: 'm'.repeat(64), runtime: 'r', recipeHash: 'h'.repeat(64) };
		const cache = new EmbeddingCache(join(tempDir('p2-put'), 'data'), identity, 4, unit(4));
		const long = new Float32Array(5);
		long[0] = 1;
		expect(() => cache.putMany([{ input: 'x', vector: long }])).toThrow();
		expect(cache.get('x')).toBeNull();
		cache.close();
	});
});

describe('P3 — every cache constructor failure is CACHE_FAILED', () => {
	const identity = { modelSha256: 'm'.repeat(64), runtime: 'r', recipeHash: 'h'.repeat(64) };
	const probe = (): Float32Array => {
		const v = new Float32Array(4);
		v[0] = 1;
		return v;
	};

	function cacheFile(dataDir: string): string {
		new EmbeddingCache(dataDir, identity, 4, probe()).close();
		const dir = join(dataDir, 'embed-cache');
		return join(dir, readdirSync(dir).find((f) => f.endsWith('.sqlite')) as string);
	}

	it.each([
		['meta table without column v', 'DROP TABLE meta; CREATE TABLE meta (k TEXT PRIMARY KEY, x BLOB)'],
		['vectors table without column v', 'DROP TABLE vectors; CREATE TABLE vectors (key TEXT PRIMARY KEY, other BLOB)'],
		['meta is a view', 'DROP TABLE meta; CREATE VIEW meta AS SELECT 1 AS k, 2 AS v'],
	])('%s', (_label, ddl) => {
		const dataDir = join(tempDir('p3-schema'), 'data');
		const file = cacheFile(dataDir);
		const db = new DatabaseSync(file);
		db.exec(ddl);
		db.close();
		const started = Date.now();
		let err: unknown;
		try {
			new EmbeddingCache(dataDir, identity, 4, probe());
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(CodeTrailError);
		expect((err as CodeTrailError).code).toBe('CACHE_FAILED');
		expect(Date.now() - started).toBeLessThan(2_000); // not retried as contention
		// the failed constructor released its connection: an exclusive transaction is possible
		const check = new DatabaseSync(file);
		check.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE; ROLLBACK;');
		check.close();
	});

	it('a corrupt (non-sqlite) cache file is CACHE_FAILED', () => {
		const dataDir = join(tempDir('p3-garbage'), 'data');
		const file = cacheFile(dataDir);
		writeFileSync(file, 'this is not a sqlite database at all, just text');
		expect(() => new EmbeddingCache(dataDir, identity, 4, probe())).toThrow(expect.objectContaining({ code: 'CACHE_FAILED' }));
	});
});
