import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync, type BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
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

const HASH_CHUNK_BYTES = 1024 * 1024;
const YIELD_EVERY_BYTES = 64 * 1024 * 1024;

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}

function unchanged(a: BigIntStats, b: BigIntStats): boolean {
	return sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/**
 * SHA-256 of a file read through ONE descriptor. The descriptor is checked to be
 * the file currently at `path` before and after reading, and its size, mtime and
 * ctime must not change while it is read (ctime cannot be set back by a user).
 * Any replacement or modification during the read is rejected. No digest is
 * cached between calls.
 *
 * This proves what is on disk at verification time; it does not prove what a
 * running server holds in memory.
 */
export async function sha256FileStable(path: string, onChunk?: (bytesRead: number) => void): Promise<string> {
	const fail = (why: string): never => {
		throw new CodeTrailError('MODEL_MISMATCH', `Model file ${why}`);
	};
	let fd: number;
	try {
		fd = openSync(path, 'r');
	} catch {
		return fail('cannot be opened');
	}
	try {
		const before = fstatSync(fd, { bigint: true });
		if (!before.isFile()) fail('is not a regular file');
		if (!sameFile(statSync(path, { bigint: true }), before)) fail('was replaced while it was being opened');
		const hash = createHash('sha256');
		const buf = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
		let pos = 0;
		let sinceYield = 0;
		for (;;) {
			const n = readSync(fd, buf, 0, buf.length, pos);
			if (n === 0) break;
			hash.update(buf.subarray(0, n));
			pos += n;
			sinceYield += n;
			onChunk?.(pos);
			if (sinceYield >= YIELD_EVERY_BYTES) {
				sinceYield = 0;
				await new Promise((r) => setImmediate(r));
			}
		}
		const after = fstatSync(fd, { bigint: true });
		if (!unchanged(before, after) || BigInt(pos) !== after.size) fail('changed while it was being hashed');
		let current: BigIntStats;
		try {
			current = statSync(path, { bigint: true });
		} catch {
			return fail('disappeared while it was being hashed');
		}
		if (!unchanged(after, current)) fail('was replaced while it was being hashed');
		return hash.digest('hex');
	} finally {
		closeSync(fd);
	}
}

/**
 * Verifies the local model file against the pinned sha256 with a fresh,
 * descriptor-stable hash (no size/mtime digest cache). Callers verify once per
 * operation (index build, search) and reuse that confirmed identity within it.
 */
export async function verifyModelFile(modelFile: string, expectedSha256: string): Promise<void> {
	if (!existsSync(modelFile)) throw new CodeTrailError('MODEL_MISMATCH', `Model file not found: ${modelFile}`);
	const digest = await sha256FileStable(modelFile);
	if (digest !== expectedSha256) throw new CodeTrailError('MODEL_MISMATCH', 'Model file sha256 does not match models.lock.json');
}
