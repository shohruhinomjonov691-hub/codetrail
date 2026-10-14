import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { CodeTrailError } from '../errors.js';
import { DEFAULT_QUERY_TASK, EMBED_RECIPE_VERSION, type EmbeddingRecipe } from './recipe.js';

/** Shape of models.lock.json (weights live outside the repository; only this pin is committed). */
export interface ModelsLock {
	schema: 1;
	runtime: { name: string; release: string; commit: string; license: string; source: string; assets: Record<string, { url: string; sha256: string; size: number }> };
	embedding: {
		name: string;
		repo: string;
		revision: string;
		file: string;
		url: string;
		sha256: string;
		size: number;
		quant: string;
		license: string;
		dims: number;
		maxTokens: number;
	};
}

export function loadModelsLock(path: string): ModelsLock {
	let lock: ModelsLock;
	try {
		lock = JSON.parse(readFileSync(path, 'utf8')) as ModelsLock;
	} catch {
		throw new CodeTrailError('USAGE', `Cannot read models lock file: ${path}`);
	}
	if (lock.schema !== 1 || !/^[0-9a-f]{64}$/.test(lock.embedding?.sha256 ?? '')) {
		throw new CodeTrailError('USAGE', 'models lock file has an unexpected shape');
	}
	return lock;
}

export function embeddingRecipeFromLock(lock: ModelsLock): EmbeddingRecipe {
	const e = lock.embedding;
	return {
		version: EMBED_RECIPE_VERSION,
		model: { name: e.name, file: e.file, sha256: e.sha256, quant: e.quant },
		dims: e.dims,
		pooling: 'last',
		normalize: 'l2',
		queryTask: DEFAULT_QUERY_TASK,
		queryTemplate: 'Instruct: {task}\nQuery:{query}',
		documentTemplate: 'File: {path}\nSymbol: {symbol}\n\n{text}',
		maxTokens: e.maxTokens,
	};
}

function hashFile(path: string): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const hash = createHash('sha256');
		createReadStream(path)
			.on('data', (chunk) => hash.update(chunk))
			.on('error', reject)
			.on('end', () => resolvePromise(hash.digest('hex')));
	});
}

/**
 * Verifies the local model file against the pinned sha256. The digest is cached
 * by (real path, size, mtime) so a 600 MB file is not re-hashed on every query.
 */
export async function verifyModelFile(modelFile: string, expectedSha256: string, cacheDir: string): Promise<void> {
	if (!existsSync(modelFile)) throw new CodeTrailError('MODEL_MISMATCH', `Model file not found: ${modelFile}`);
	const st = statSync(modelFile);
	const cachePath = cacheDir ? join(cacheDir, 'model-hashes.json') : null;
	let cache: Record<string, { size: number; mtimeMs: number; sha256: string }> = {};
	try {
		if (cachePath) cache = JSON.parse(readFileSync(cachePath, 'utf8')) as typeof cache;
	} catch {
		/* no cache yet */
	}
	const key = resolve(modelFile);
	let digest = cache[key]?.size === st.size && cache[key]?.mtimeMs === st.mtimeMs ? cache[key]?.sha256 : undefined;
	if (!digest) {
		digest = await hashFile(modelFile);
		cache[key] = { size: st.size, mtimeMs: st.mtimeMs, sha256: digest };
		if (cachePath) {
			mkdirSync(dirname(cachePath), { recursive: true });
			writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n');
		}
	}
	if (digest !== expectedSha256) throw new CodeTrailError('MODEL_MISMATCH', 'Model file sha256 does not match models.lock.json');
}
