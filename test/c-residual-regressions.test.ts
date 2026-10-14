/**
 * Regressions for the Codex C re-review of 575a6c2..0b1a1de (three residual findings).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { LlamaCppEmbedding, normalizeVector } from '../src/embedding/llamacpp.js';
import { embeddingRecipeFromLock, type ModelsLock } from '../src/embedding/models.js';
import type { EmbeddingProvider } from '../src/embedding/provider.js';
import { formatDocument, PROBE_TEXT, type EmbeddingRecipe } from '../src/embedding/recipe.js';
import { Registry } from '../src/registry.js';
import { buildIndex, loadIndex } from '../src/retrieval/index.js';
import { search } from '../src/retrieval/search.js';
import { createSnapshot } from '../src/snapshot.js';
import { startFakeLlama, type FakeLlama } from './fake-llama.js';
import { commitFiles, DIST, makeRepo, tempDir } from './helpers.js';

const DIMS = 64;
const FILES = {
	'src/a.ts': 'export function alphaHandler(input: string) {\n\treturn input.trim();\n}\n',
	'src/b.ts': 'export function betaGuard(token: string) {\n\treturn token.length > 0;\n}\n',
	'src/c.ts': 'export const gammaConfig = { retries: 3 };\n',
};

let modelFile: string;
let otherModelFile: string;
let recipe: EmbeddingRecipe;
let serverA: FakeLlama;
let serverB: FakeLlama;

beforeAll(async () => {
	const dir = tempDir('c-res-model');
	modelFile = join(dir, 'fake-embed.gguf');
	writeFileSync(modelFile, 'fake model A');
	mkdirSync(join(dir, 'other'));
	otherModelFile = join(dir, 'other', 'fake-embed.gguf'); // same basename, different file
	writeFileSync(otherModelFile, 'fake model B');
	const lock: ModelsLock = {
		schema: 1,
		runtime: { name: 'fake', release: 'test', commit: '0'.repeat(40), license: 'MIT', source: 'test', assets: {} },
		embedding: {
			name: 'Fake', repo: 'test/fake', revision: 'r', file: 'fake-embed.gguf', url: 'http://127.0.0.1/x',
			sha256: createHash('sha256').update('fake model A').digest('hex'), size: 12, quant: 'Q8_0', license: 'MIT', dims: DIMS, maxTokens: 512,
		},
	};
	recipe = embeddingRecipeFromLock(lock);
	serverA = await startFakeLlama({ seed: 'space-a', modelPath: modelFile });
	// B: different document vectors, but its probe is almost A's (cosine ≈ 0.99995).
	serverB = await startFakeLlama({ seed: 'space-b', probeSeed: 'space-a', probeNoise: 0.0025, modelPath: otherModelFile });
});
afterAll(async () => Promise.all([serverA.close(), serverB.close()]));

const provider = (url: string): LlamaCppEmbedding =>
	new LlamaCppEmbedding({ url, allowedHosts: [], recipe, modelFile } as ConstructorParameters<typeof LlamaCppEmbedding>[0]);

async function setup(name: string): Promise<{ cfg: RuntimeConfig; repoDir: string; snapshotId: string }> {
	const root = tempDir(name);
	const repo = makeRepo(root, 'repo', FILES);
	const cfg: RuntimeConfig = { dataDir: join(root, 'data'), localRoots: [root] };
	const reg = new Registry(cfg.dataDir);
	reg.addProject('app', 'App');
	reg.addSource('app', { id: 'main', kind: 'local', location: repo.dir, defaultRef: 'main' });
	return { cfg, repoDir: repo.dir, snapshotId: (await createSnapshot(cfg, 'app')).report.snapshot_id };
}

async function nextSnapshot(cfg: RuntimeConfig, repoDir: string): Promise<string> {
	commitFiles(repoDir, { 'src/c.ts': 'export const gammaConfig = { retries: 5 };\n' });
	return (await createSnapshot(cfg, 'app')).report.snapshot_id;
}

describe('1 — model identity is the loaded model hash + runtime + recipe, not a probe cosine', () => {
	it('the reproducer is in the dangerous regime: probe cosine A/B ≥ 0.9999, document vectors differ', async () => {
		const [pa] = await provider(serverA.url).embed([PROBE_TEXT], 'document');
		const [pb] = await provider(serverB.url).embed([PROBE_TEXT], 'document');
		const cos = pa!.reduce((s, x, i) => s + x * pb![i]!, 0);
		expect(cos).toBeGreaterThanOrEqual(0.9999);
		expect(cos).toBeLessThan(1);
		const [da] = await provider(serverA.url).embed(['export function alphaHandler'], 'document');
		const [db] = await provider(serverB.url).embed(['export function alphaHandler'], 'document');
		expect(da!.reduce((s, x, i) => s + x * db![i]!, 0)).toBeLessThan(0.9);
	});

	it('server B never reuses vectors cached from server A', async () => {
		const c = await setup('c-res-id');
		await buildIndex(c.cfg, 'app', c.snapshotId, provider(serverA.url));
		const snap2 = await nextSnapshot(c.cfg, c.repoDir);
		let outcome: { code?: string; fromCache?: number };
		try {
			const built = await buildIndex(c.cfg, 'app', snap2, provider(serverB.url));
			outcome = { fromCache: built.meta.embedded.from_cache };
		} catch (err) {
			outcome = { code: (err as { code?: string }).code };
		}
		// Either refused (identity not confirmed) or rebuilt entirely from B — never A's vectors.
		if (outcome.code === undefined) expect(outcome.fromCache).toBe(0);
		else expect(outcome.code).toBe('MODEL_MISMATCH');
	});

	it('a query through server B is refused for an index built by server A', async () => {
		const c = await setup('c-res-id-query');
		await buildIndex(c.cfg, 'app', c.snapshotId, provider(serverA.url));
		const index = loadIndex(c.cfg.dataDir, 'app', c.snapshotId, recipe);
		await expect(search(index, 'beta guard', { mode: 'vector' }, provider(serverB.url))).rejects.toMatchObject({ code: 'MODEL_MISMATCH' });
		index.db.close();
	});

	it('the same verified server still reuses its own cache', async () => {
		const c = await setup('c-res-id-same');
		const first = await buildIndex(c.cfg, 'app', c.snapshotId, provider(serverA.url));
		const snap2 = await nextSnapshot(c.cfg, c.repoDir);
		const second = await buildIndex(c.cfg, 'app', snap2, provider(serverA.url));
		expect(second.meta.embedded.from_cache).toBe(first.meta.chunk_count - 1);
	});
});

describe('2 — vector validation', () => {
	it('normalization is overflow-safe', () => {
		const v = normalizeVector([1e308, 1e308], 2);
		expect(v[0]).toBeCloseTo(Math.SQRT1_2, 6);
		expect(v[1]).toBeCloseTo(Math.SQRT1_2, 6);
		const tiny = normalizeVector([1e-300, 0, 0], 3);
		expect(Array.from(tiny)).toEqual([1, 0, 0]);
	});

	it.each([
		['NaN', [Number.NaN, 1]],
		['Infinity', [Number.POSITIVE_INFINITY, 1]],
		['zero', [0, 0]],
		['wrong dims', [1, 0, 0]],
	])('normalization rejects %s', (_label, values) => {
		expect(() => normalizeVector(values, 2)).toThrow(expect.objectContaining({ code: 'PROVIDER_FAILED' }));
	});

	it('a provider that returns huge raw values still scores correctly', async () => {
		const huge = await startFakeLlama({
			seed: 'space-a',
			modelPath: modelFile,
			rawVector: (text, dims) => (text.includes('Query:') ? Array.from({ length: dims }, (_, i) => ((i % 3) - 1) * 1e308) : null),
		});
		const c = await setup('c-res-huge');
		await buildIndex(c.cfg, 'app', c.snapshotId, provider(huge.url));
		const index = loadIndex(c.cfg.dataDir, 'app', c.snapshotId, recipe);
		const hits = await search(index, 'beta guard', { mode: 'vector', k: 3 }, provider(huge.url));
		const cosines = hits.map((h) => h.scores.vector_cosine as number);
		expect(cosines.every((x) => Number.isFinite(x))).toBe(true);
		expect(cosines.some((x) => x !== 0)).toBe(true); // a zeroed query vector would score everything 0
		index.db.close();
		await huge.close();
	});

	it.each([
		['NaN', () => new Float32Array(DIMS).fill(Number.NaN)],
		['Infinity', () => new Float32Array(DIMS).fill(Number.POSITIVE_INFINITY)],
		['zero', () => new Float32Array(DIMS)],
		['not unit length', () => new Float32Array(DIMS).fill(1)],
		['wrong dims', () => new Float32Array(DIMS + 1).fill(1 / Math.sqrt(DIMS + 1))],
	])('a custom provider returning a %s query vector is rejected before scoring', async (_label, make) => {
		const c = await setup('c-res-custom');
		const built = await buildIndex(c.cfg, 'app', c.snapshotId, provider(serverA.url));
		const index = loadIndex(c.cfg.dataDir, 'app', c.snapshotId, recipe);
		const real = provider(serverA.url);
		const custom: EmbeddingProvider = {
			recipe,
			verifyServer: () => real.verifyServer(),
			countTokens: (input) => real.countTokens(input),
			embed: async (inputs, kind) => (inputs[0] === PROBE_TEXT ? [index.probe] : kind === 'query' ? [make()] : real.embed(inputs, kind)),
			...({ identity: async () => (built.meta as unknown as { identity: unknown }).identity } as object),
		} as EmbeddingProvider;
		await expect(search(index, 'beta guard', { mode: 'vector' }, custom)).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
		index.db.close();
	});
});

describe('3 — cache initialization under concurrency', () => {
	function openInChildren(dataDir: string, n: number): Promise<string[]> {
		const startAt = Date.now() + 1_500;
		const script = `
			import { EmbeddingCache } from ${JSON.stringify(join(DIST, 'retrieval', 'cache.js'))};
			const [dataDir, startAt] = [process.argv[1], Number(process.argv[2])];
			const ns = { recipeHash: 'r'.repeat(64), runtime: 'b1', modelSha256: 'm'.repeat(64) };
			const probe = new Float32Array(64); probe[0] = 1;
			while (Date.now() < startAt) {}
			try { const c = new EmbeddingCache(dataDir, ns, 64, probe); c.close(); console.log('ok'); }
			catch (e) { console.log(e.code ?? ('raw:' + e.message)); }`;
		return Promise.all(
			Array.from({ length: n }, () =>
				new Promise<string>((resolve) => {
					const child = spawn(process.execPath, ['--input-type=module', '-e', script, dataDir, String(startAt)]);
					let out = '';
					child.stdout.on('data', (d: Buffer) => (out += d.toString()));
					child.on('close', () => resolve(out.trim()));
				}),
			),
		);
	}

	it('8 processes opening the same empty namespace all succeed', async () => {
		for (let round = 0; round < 3; round++) {
			const results = await openInChildren(join(tempDir(`cache-race-${round}`), 'data'), 8);
			expect(results).toEqual(Array(8).fill('ok'));
		}
	});

	it('a permanent error is reported clearly and promptly', async () => {
		const dataDir = join(tempDir('cache-perm'), 'data');
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(join(dataDir, 'embed-cache'), 'not a directory');
		const started = Date.now();
		const [result] = await openInChildren(dataDir, 1);
		expect(result).toBe('CACHE_FAILED');
		expect(Date.now() - started).toBeLessThan(10_000);
	});
});
