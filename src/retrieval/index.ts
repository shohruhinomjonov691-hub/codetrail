import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeConfig } from '../config.js';
import { CodeTrailError } from '../errors.js';
import { hashParts, sha256Hex } from '../hash.js';
import { assertId, assertSnapshotId } from '../ids.js';
import { LOCK_DEFAULTS, withLock } from '../lock.js';
import { readSnapshot, snapshotsRoot, type ChunkRecord } from '../snapshot.js';
import { DatabaseSync, type Database } from '../sqlite.js';
import type { EmbeddingProvider, ModelIdentity } from '../embedding/provider.js';
import { formatDocument, PROBE_TEXT, recipeHash, type EmbeddingRecipe } from '../embedding/recipe.js';
import { EmbeddingCache } from './cache.js';
import { assertExactUnitVector, firstInvalidRow, isExactUnitVector } from '../embedding/vectors.js';
import { splitIdentifiers } from './text.js';

/**
 * 3: cache and index bound to the confirmed model identity (loaded model file
 * sha256 + runtime build + recipe hash); vectors validated before publish and
 * on load. Older indexes are rejected with INDEX_OUTDATED.
 */
export const INDEX_SCHEMA = 3;

export interface IndexMeta {
	schema: number;
	index_id: string;
	project_id: string;
	snapshot_id: string;
	chunks_sha256: string;
	chunk_count: number;
	recipe: EmbeddingRecipe;
	recipe_hash: string;
	dims: number;
	files: { 'vectors.f32': string; 'probe.f32': string; 'index.sqlite': string };
	/** Confirmed identity of the model that produced every vector in this index. */
	identity: ModelIdentity;
	tokens: { max: number; mean: number; total: number };
	embedded: { from_cache: number; computed: number; invalid_cache_entries: number; cache: 'enabled' | 'disabled-probe-differs' };
	timings_ms: { tokenize: number; embed: number; write: number };
	created_at: string;
}

export interface LoadedIndex {
	meta: IndexMeta;
	dir: string;
	chunks: ChunkRecord[];
	vectors: Float32Array;
	probe: Float32Array;
	db: Database;
}

export function indexId(projectId: string, snapshotId: string, recipe: EmbeddingRecipe): string {
	return hashParts([INDEX_SCHEMA, projectId, snapshotId, recipeHash(recipe)]).slice(0, 24);
}

/** A ready index for this snapshot written with an older schema, if any. */
function findOutdatedIndex(dataDir: string, projectId: string, snapshotId: string): { id: string; schema: number } | null {
	const parent = join(dataDir, 'indexes', projectId, snapshotId);
	if (!existsSync(parent)) return null;
	for (const name of readdirSync(parent)) {
		if (!/^[0-9a-f]{24}$/.test(name)) continue;
		try {
			const meta = JSON.parse(readFileSync(join(parent, name, 'meta.json'), 'utf8')) as { schema?: number };
			if (typeof meta.schema === 'number' && meta.schema < INDEX_SCHEMA) return { id: name, schema: meta.schema };
		} catch {
			/* not a ready index */
		}
	}
	return null;
}

export function indexDir(dataDir: string, projectId: string, snapshotId: string, id: string): string {
	return join(dataDir, 'indexes', projectId, snapshotId, id);
}

function chunksFile(dataDir: string, projectId: string, snapshotId: string): string {
	return join(snapshotsRoot(dataDir, projectId), snapshotId, 'chunks.jsonl');
}

function toBytes(v: Float32Array): Buffer {
	return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function writeSqlite(path: string, chunks: ChunkRecord[]): void {
	const db = new DatabaseSync(path);
	try {
		db.exec(`
			PRAGMA journal_mode = OFF;
			CREATE TABLE chunks (
				row INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, source_id TEXT NOT NULL, commit_sha TEXT NOT NULL,
				path TEXT NOT NULL, symbol TEXT, kind TEXT NOT NULL, language TEXT NOT NULL,
				start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, text_sha256 TEXT NOT NULL);
			CREATE VIRTUAL TABLE fts USING fts5(path, symbol, text, ident, tokenize = 'unicode61');`);
		const insChunk = db.prepare('INSERT INTO chunks VALUES (?,?,?,?,?,?,?,?,?,?,?)');
		const insFts = db.prepare('INSERT INTO fts (rowid, path, symbol, text, ident) VALUES (?,?,?,?,?)');
		db.exec('BEGIN');
		chunks.forEach((c, i) => {
			insChunk.run(i + 1, c.id, c.source_id, c.commit, c.path, c.symbol, c.kind, c.language, c.start_line, c.end_line, c.text_sha256);
			insFts.run(i + 1, c.path, c.symbol ?? '', c.text, splitIdentifiers(`${c.path} ${c.symbol ?? ''} ${c.text}`));
		});
		db.exec('COMMIT');
		db.exec('VACUUM');
	} finally {
		db.close();
	}
}

/**
 * Builds the retrieval index for one snapshot and one embedding recipe.
 * - Runs under a per-snapshot cross-process lock; concurrent runs wait and then see `exists`.
 * - Everything is written to a private temp dir and renamed into place; meta.json
 *   is written last, so a directory without a valid meta.json is never "ready".
 * - Every input is token-counted first; anything over recipe.maxTokens aborts the
 *   build (no silent truncation).
 */
export async function buildIndex(
	config: RuntimeConfig,
	projectId: string,
	snapshotId: string,
	provider: EmbeddingProvider,
	now: () => Date = () => new Date(),
): Promise<{ status: 'created' | 'exists'; meta: IndexMeta; dir: string }> {
	assertId('project', projectId);
	assertSnapshotId(snapshotId);
	const recipe = provider.recipe;
	const id = indexId(projectId, snapshotId, recipe);
	const dir = indexDir(config.dataDir, projectId, snapshotId, id);
	return withLock(join(config.dataDir, 'locks'), `index-${projectId}-${snapshotId}`, LOCK_DEFAULTS.snapshot, async () => {
		if (existsSync(join(dir, 'meta.json'))) {
			const loaded = loadIndex(config.dataDir, projectId, snapshotId, recipe);
			loaded.db.close();
			return { status: 'exists' as const, meta: loaded.meta, dir };
		}
		const { chunks } = readSnapshot(config.dataDir, projectId, snapshotId);
		const chunksSha = sha256Hex(readFileSync(chunksFile(config.dataDir, projectId, snapshotId)));
		// Throws MODEL_MISMATCH unless the loaded model file, runtime and recipe are confirmed.
		const identity = await provider.identity();

		const inputs = chunks.map((c) => formatDocument(c));
		let t0 = Date.now();
		const counts = await Promise.all(inputs.map((input) => provider.countTokens(input)));
		const tokenizeMs = Date.now() - t0;
		const over = chunks.map((c, i) => ({ c, n: counts[i] as number })).filter((x) => x.n > recipe.maxTokens);
		if (over.length > 0) {
			const sample = over.slice(0, 10).map((x) => `${x.c.source_id}:${x.c.path}:L${x.c.start_line}-${x.c.end_line} (${x.n} tokens)`);
			throw new CodeTrailError('TOKEN_LIMIT', `${over.length} chunk(s) exceed ${recipe.maxTokens} tokens; nothing was indexed: ${sample.join(', ')}`);
		}

		t0 = Date.now();
		// The probe is stored as a drift check for queries; it is not an identity.
		const probes = await provider.embed([PROBE_TEXT], 'document');
		const probe = probes[0];
		// Validate the probe BEFORE the cache is opened or written.
		if (probes.length !== 1) throw new CodeTrailError('PROVIDER_FAILED', 'Embedding provider returned a wrong number of probe vectors');
		assertExactUnitVector(probe, recipe.dims, 'Probe embedding');
		const cache = new EmbeddingCache(config.dataDir, identity, recipe.dims, probe);
		const vectors = new Float32Array(chunks.length * recipe.dims);
		const missing: number[] = [];
		inputs.forEach((input, i) => {
			const hit = cache.get(input);
			if (hit) vectors.set(hit, i * recipe.dims);
			else missing.push(i);
		});
		if (missing.length > 0) {
			let computed: Float32Array[];
			try {
				computed = await provider.embed(missing.map((i) => inputs[i] as string), 'document');
				if (computed.length !== missing.length) throw new CodeTrailError('PROVIDER_FAILED', 'Embedding provider returned a wrong number of vectors');
				computed.forEach((v, j) => assertExactUnitVector(v, recipe.dims, `Document embedding for chunk ${chunks[missing[j] as number]?.id ?? j}`));
			} catch (err) {
				cache.close();
				throw err;
			}
			computed.forEach((v, j) => vectors.set(v, (missing[j] as number) * recipe.dims));
			cache.putMany(computed.map((v, j) => ({ input: inputs[missing[j] as number] as string, vector: v })));
		}
		const invalidCache = cache.invalidReads;
		const cacheReusable = cache.reusable;
		cache.close();
		const embedMs = Date.now() - t0;
		const bad = firstInvalidRow(vectors, recipe.dims);
		if (bad >= 0 || !isExactUnitVector(probe, recipe.dims)) {
			throw new CodeTrailError('INDEX_CORRUPT', `Refusing to publish: invalid embedding for chunk ${bad >= 0 ? (chunks[bad]?.id ?? bad) : 'probe'}`);
		}

		t0 = Date.now();
		const parent = join(config.dataDir, 'indexes', projectId, snapshotId);
		mkdirSync(parent, { recursive: true });
		const tmp = join(parent, `.tmp-${id}-${process.pid}-${randomBytes(4).toString('hex')}`);
		mkdirSync(tmp);
		try {
			writeFileSync(join(tmp, 'vectors.f32'), toBytes(vectors));
			writeFileSync(join(tmp, 'probe.f32'), toBytes(probe));
			writeSqlite(join(tmp, 'index.sqlite'), chunks);
			const total = counts.reduce((a, b) => a + b, 0);
			const meta: IndexMeta = {
				schema: INDEX_SCHEMA,
				index_id: id,
				project_id: projectId,
				snapshot_id: snapshotId,
				chunks_sha256: chunksSha,
				chunk_count: chunks.length,
				recipe,
				recipe_hash: recipeHash(recipe),
				dims: recipe.dims,
				files: {
					'vectors.f32': sha256Hex(readFileSync(join(tmp, 'vectors.f32'))),
					'probe.f32': sha256Hex(readFileSync(join(tmp, 'probe.f32'))),
					'index.sqlite': sha256Hex(readFileSync(join(tmp, 'index.sqlite'))),
				},
				identity,
				tokens: { max: Math.max(0, ...counts), mean: chunks.length ? Math.round(total / chunks.length) : 0, total },
				embedded: { from_cache: chunks.length - missing.length, computed: missing.length, invalid_cache_entries: invalidCache, cache: cacheReusable ? 'enabled' : 'disabled-probe-differs' },
				timings_ms: { tokenize: tokenizeMs, embed: embedMs, write: 0 },
				created_at: now().toISOString(),
			};
			meta.timings_ms.write = Date.now() - t0;
			writeFileSync(join(tmp, 'meta.json'), JSON.stringify(meta, null, 2) + '\n'); // written last
			renameSync(tmp, dir);
			return { status: 'created' as const, meta, dir };
		} catch (err) {
			rmSync(tmp, { recursive: true, force: true });
			throw err;
		}
	});
}

/**
 * Opens a ready index after verifying that it belongs to this project/snapshot
 * and recipe, that the snapshot's chunks are unchanged, and that every artifact
 * matches the sha256 recorded in meta.json.
 */
export function loadIndex(dataDir: string, projectId: string, snapshotId: string, recipe: EmbeddingRecipe): LoadedIndex {
	assertId('project', projectId);
	assertSnapshotId(snapshotId);
	const id = indexId(projectId, snapshotId, recipe);
	const dir = indexDir(dataDir, projectId, snapshotId, id);
	const metaPath = join(dir, 'meta.json');
	if (!existsSync(metaPath)) {
		const outdated = findOutdatedIndex(dataDir, projectId, snapshotId);
		if (outdated) {
			throw new CodeTrailError(
				'INDEX_OUTDATED',
				`Index ${outdated.id} for ${projectId}/${snapshotId} uses schema ${outdated.schema} (current ${INDEX_SCHEMA}) and is not used. Rebuild with: codetrail index ${projectId} ${snapshotId}`,
			);
		}
		throw new CodeTrailError('UNKNOWN_INDEX', `No ready index for ${projectId}/${snapshotId} with this embedding recipe`);
	}
	let meta: IndexMeta;
	try {
		meta = JSON.parse(readFileSync(metaPath, 'utf8')) as IndexMeta;
	} catch {
		throw new CodeTrailError('INDEX_CORRUPT', 'Index meta.json is unreadable');
	}
	const corrupt = (why: string): never => {
		throw new CodeTrailError('INDEX_CORRUPT', `Index ${id} failed verification: ${why}`);
	};
	if (meta.schema !== INDEX_SCHEMA || meta.index_id !== id) corrupt('schema or id');
	if (meta.project_id !== projectId || meta.snapshot_id !== snapshotId) corrupt('project/snapshot mismatch');
	if (meta.recipe_hash !== recipeHash(recipe)) corrupt('recipe mismatch');
	const { chunks } = readSnapshot(dataDir, projectId, snapshotId);
	if (sha256Hex(readFileSync(chunksFile(dataDir, projectId, snapshotId))) !== meta.chunks_sha256) corrupt('snapshot chunks changed');
	if (chunks.length !== meta.chunk_count) corrupt('chunk count');
	const files: Record<string, Buffer> = {};
	for (const name of ['vectors.f32', 'probe.f32', 'index.sqlite'] as const) {
		const path = join(dir, name);
		if (!existsSync(path)) corrupt(`missing ${name}`);
		files[name] = readFileSync(path);
		if (sha256Hex(files[name] as Buffer) !== meta.files[name]) corrupt(`${name} sha256`);
	}
	const vbuf = files['vectors.f32'] as Buffer;
	if (vbuf.byteLength !== meta.chunk_count * meta.dims * 4) corrupt('vector file size');
	const vectors = new Float32Array(vbuf.buffer.slice(vbuf.byteOffset, vbuf.byteOffset + vbuf.byteLength));
	const pbuf = files['probe.f32'] as Buffer;
	if (pbuf.byteLength !== meta.dims * 4) corrupt('probe size');
	const probe = new Float32Array(pbuf.buffer.slice(pbuf.byteOffset, pbuf.byteOffset + pbuf.byteLength));
	// Checksums only prove the files are unchanged since publish; also prove the values are sane.
	const badRow = firstInvalidRow(vectors, meta.dims);
	if (badRow >= 0) corrupt(`vector ${badRow} is not a finite unit vector`);
	if (!isExactUnitVector(probe, meta.dims)) corrupt('probe is not a finite unit vector');
	const db = new DatabaseSync(join(dir, 'index.sqlite'), { readOnly: true });
	const rows = (db.prepare('SELECT count(*) AS n FROM chunks').get() as { n: number }).n;
	if (rows !== meta.chunk_count) {
		db.close();
		corrupt('sqlite row count');
	}
	return { meta, dir, chunks, vectors, probe, db };
}
