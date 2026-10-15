/**
 * Regressions for the Docker index timeout: (1) an interrupted index build keeps
 * the vectors it already computed, so a rerun only computes what is missing;
 * (2) batch size and document timeout come from configuration, the query timeout
 * does not. Fake embeddings only.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { embeddingSettings } from '../src/embedding/config.js';
import { EMBED_LIMITS, LlamaCppEmbedding } from '../src/embedding/llamacpp.js';
import { embeddingRecipeFromLock, type ModelsLock } from '../src/embedding/models.js';
import type { EmbeddingProvider } from '../src/embedding/provider.js';
import type { EmbeddingRecipe } from '../src/embedding/recipe.js';
import { Registry } from '../src/registry.js';
import { buildIndex, INDEX_CACHE_GROUP } from '../src/retrieval/index.js';
import { createSnapshot } from '../src/snapshot.js';
import { FAKE_MODEL_FILE, FAKE_MODEL_SHA256, startFakeLlama, type FakeLlama } from './fake-llama.js';
import { makeRepo, tempDir } from './helpers.js';

const FILES: Record<string, string> = {};
for (let i = 0; i < 80; i++) FILES[`src/f${i}.ts`] = `export function handler${i}(input: number) {\n\treturn input + ${i};\n}\n`;

let llama: FakeLlama;
let recipe: EmbeddingRecipe;
let cfg: RuntimeConfig;
let snapshotId: string;

beforeAll(async () => {
	llama = await startFakeLlama();
	const lock: ModelsLock = {
		schema: 1,
		runtime: { name: 'fake', release: 't', commit: '0'.repeat(40), license: 'MIT', source: 't', assets: {} },
		embedding: { name: 'Fake', repo: 'f', revision: 'r', file: 'fake-embed.gguf', url: 'http://127.0.0.1/x', sha256: FAKE_MODEL_SHA256, size: 18, quant: 'Q8_0', license: 'MIT', dims: 64, maxTokens: 512 },
	};
	recipe = embeddingRecipeFromLock(lock);
	const root = tempDir('index-resume');
	cfg = { dataDir: join(root, 'data'), localRoots: [root] };
	const reg = new Registry(cfg.dataDir);
	const repo = makeRepo(root, 'alpha', FILES);
	reg.addProject('alpha', 'Alpha');
	reg.addSource('alpha', { id: 'main', kind: 'local', location: repo.dir, defaultRef: 'main' });
	snapshotId = (await createSnapshot(cfg, 'alpha')).report.snapshot_id;
});
afterAll(async () => llama.close());

const real = () => new LlamaCppEmbedding({ url: llama.url, allowedHosts: [], recipe, modelFile: FAKE_MODEL_FILE });

/**
 * Delegates to a real provider but fails once `limit` document vectors have been computed —
 * like a server that times out midway through a long indexing run (independent of how the
 * caller groups its requests). The probe does not count.
 */
function failingAfter(limit: number): EmbeddingProvider {
	const inner = real();
	let done = 0;
	return {
		recipe: inner.recipe,
		verifyServer: () => inner.verifyServer(),
		identity: () => inner.identity(),
		countTokens: (input, signal) => inner.countTokens(input, signal),
		embed: async (inputs, kind, signal) => {
			if (kind !== 'document' || (inputs.length === 1 && done === 0 && inputs[0]?.includes('fingerprint'))) return inner.embed(inputs, kind, signal);
			const out: Float32Array[] = [];
			for (let i = 0; i < inputs.length; i += 8) {
				if (done >= limit) throw new Error('simulated provider timeout');
				const part = inputs.slice(i, i + 8);
				out.push(...(await inner.embed(part, kind, signal)));
				done += part.length;
			}
			return out;
		},
	};
}

describe('an interrupted index build keeps its progress', () => {
	it('a rerun computes only the vectors that were still missing', async () => {
		// 64 of the 80 document vectors are computed, then the provider fails
		await expect(buildIndex(cfg, 'alpha', snapshotId, failingAfter(64))).rejects.toThrow('simulated provider timeout');
		const before = llama.stats.embeddedInputs;
		const result = await buildIndex(cfg, 'alpha', snapshotId, real());
		const embeddedOnRerun = llama.stats.embeddedInputs - before;
		const total = 80;
		// behaviour first: the rerun must not recompute everything the first run had already computed
		expect(embeddedOnRerun).toBeLessThan(1 + total);
		// exactly: the probe (1) plus only the chunks that were not cached by the first run
		expect(INDEX_CACHE_GROUP).toBeLessThan(40); // the fixture spans several groups
		expect(embeddedOnRerun).toBe(1 + (total - 2 * INDEX_CACHE_GROUP));
		expect(JSON.stringify(result)).toContain(`"from_cache":${2 * INDEX_CACHE_GROUP}`);
	});
});

describe('indexing batch size and document timeout are configurable', () => {
	it('reads them from the environment with safe bounds; defaults are unchanged', () => {
		const base = { CODETRAIL_MODELS_LOCK: join(import.meta.dirname, '..', 'models.lock.json') };
		const d = embeddingSettings(base);
		expect([d.batchSize, d.documentTimeoutMs]).toEqual([EMBED_LIMITS.batchSize, EMBED_LIMITS.documentTimeoutMs]);
		const c = embeddingSettings({ ...base, CODETRAIL_EMBED_BATCH_SIZE: '2', CODETRAIL_EMBED_DOC_TIMEOUT_MS: '300000' });
		expect([c.batchSize, c.documentTimeoutMs]).toEqual([2, 300000]);
		for (const bad of [{ CODETRAIL_EMBED_BATCH_SIZE: '0' }, { CODETRAIL_EMBED_BATCH_SIZE: '2.5' }, { CODETRAIL_EMBED_DOC_TIMEOUT_MS: '5' }]) {
			expect(() => embeddingSettings({ ...base, ...bad })).toThrow();
		}
		expect(EMBED_LIMITS.queryTimeoutMs).toBe(10_000); // the query timeout is not configurable
		expect(Object.keys(c)).not.toContain('queryTimeoutMs');
	});
});
