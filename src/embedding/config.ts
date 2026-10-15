import { join, resolve } from 'node:path';
import type { RuntimeConfig } from '../config.js';
import { EMBED_LIMITS, LlamaCppEmbedding } from './llamacpp.js';
import { embeddingRecipeFromLock, loadModelsLock } from './models.js';
import type { EmbeddingRecipe } from './recipe.js';

export interface EmbeddingSettings {
	url: string;
	allowedHosts: string[];
	lockFile: string;
	modelFile: string;
	recipe: EmbeddingRecipe;
	expectedSha256: string;
	/** Inputs per /v1/embeddings request when indexing (smaller for slow CPUs). */
	batchSize: number;
	/** Timeout of one document (indexing) request; the query timeout is not configurable. */
	documentTimeoutMs: number;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
	const raw = env[name]?.trim();
	if (!raw) return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
	return n;
}

/**
 * CODETRAIL_EMBED_URL       local llama-server base URL (default http://127.0.0.1:8081)
 * CODETRAIL_PROVIDER_HOSTS  extra internal host names allowed besides loopback (comma-separated)
 * CODETRAIL_MODELS_LOCK     models lock file (default ./models.lock.json)
 * CODETRAIL_MODELS_DIR      where weights live, outside the repo (default ./models, git-ignored)
 * CODETRAIL_EMBED_MODEL_FILE explicit path to the embedding GGUF (default <models dir>/models/<file>)
 * CODETRAIL_EMBED_BATCH_SIZE     inputs per indexing request (default 8; e.g. 2 on a 2-CPU container)
 * CODETRAIL_EMBED_DOC_TIMEOUT_MS timeout of one indexing request (default 120000)
 */
export function embeddingSettings(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): EmbeddingSettings {
	const lockFile = resolve(cwd, env.CODETRAIL_MODELS_LOCK?.trim() || 'models.lock.json');
	const lock = loadModelsLock(lockFile);
	const modelsDir = resolve(cwd, env.CODETRAIL_MODELS_DIR?.trim() || 'models');
	return {
		url: env.CODETRAIL_EMBED_URL?.trim() || 'http://127.0.0.1:8081',
		allowedHosts: (env.CODETRAIL_PROVIDER_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
		lockFile,
		modelFile: resolve(cwd, env.CODETRAIL_EMBED_MODEL_FILE?.trim() || join(modelsDir, 'models', lock.embedding.file)),
		recipe: embeddingRecipeFromLock(lock),
		expectedSha256: lock.embedding.sha256,
		batchSize: intEnv(env, 'CODETRAIL_EMBED_BATCH_SIZE', EMBED_LIMITS.batchSize, 1, 64),
		documentTimeoutMs: intEnv(env, 'CODETRAIL_EMBED_DOC_TIMEOUT_MS', EMBED_LIMITS.documentTimeoutMs, 10_000, 3_600_000),
	};
}

/** Returns an HTTP provider for the local server; identity (incl. the model file hash) is confirmed per operation. */
export async function createEmbeddingProvider(config: RuntimeConfig, settings: EmbeddingSettings): Promise<LlamaCppEmbedding> {
	// The model file is hashed (fresh) when identity is confirmed, once per operation.
	void config;
	const provider = new LlamaCppEmbedding({
		url: settings.url,
		allowedHosts: settings.allowedHosts,
		recipe: settings.recipe,
		modelFile: settings.modelFile,
		batchSize: settings.batchSize,
		documentTimeoutMs: settings.documentTimeoutMs,
	});
	return provider;
}
