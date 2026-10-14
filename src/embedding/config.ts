import { join, resolve } from 'node:path';
import type { RuntimeConfig } from '../config.js';
import { LlamaCppEmbedding } from './llamacpp.js';
import { embeddingRecipeFromLock, loadModelsLock, verifyModelFile } from './models.js';
import type { EmbeddingRecipe } from './recipe.js';

export interface EmbeddingSettings {
	url: string;
	allowedHosts: string[];
	lockFile: string;
	modelFile: string;
	recipe: EmbeddingRecipe;
	expectedSha256: string;
}

/**
 * CODETRAIL_EMBED_URL       local llama-server base URL (default http://127.0.0.1:8081)
 * CODETRAIL_PROVIDER_HOSTS  extra internal host names allowed besides loopback (comma-separated)
 * CODETRAIL_MODELS_LOCK     models lock file (default ./models.lock.json)
 * CODETRAIL_MODELS_DIR      where weights live, outside the repo (default ./models, git-ignored)
 * CODETRAIL_EMBED_MODEL_FILE explicit path to the embedding GGUF (default <models dir>/models/<file>)
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
	};
}

/** Verifies the local weights against the lock, then returns an HTTP provider for the local server. */
export async function createEmbeddingProvider(config: RuntimeConfig, settings: EmbeddingSettings): Promise<LlamaCppEmbedding> {
	const hashCacheDir = join(config.dataDir, 'cache');
	await verifyModelFile(settings.modelFile, settings.expectedSha256, hashCacheDir);
	const provider = new LlamaCppEmbedding({
		url: settings.url,
		allowedHosts: settings.allowedHosts,
		recipe: settings.recipe,
		modelFile: settings.modelFile,
		hashCacheDir,
	});
	return provider;
}
