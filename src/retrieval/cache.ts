import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, sha256Hex } from '../hash.js';
import { DatabaseSync, type Database } from '../sqlite.js';
import { cosine, isUnitVector } from '../embedding/vectors.js';

/** Bumped when the cache layout or keying changes; older cache files are simply not read. */
export const CACHE_SCHEMA = 2;

/** Same-server probe embeddings agree to ~1e-7; different embedding spaces are far below this. */
export const FINGERPRINT_MIN_COSINE = 0.9999;

export interface CacheNamespace {
	/** Model sha256, quantization, pooling, templates, dims, limits. */
	recipeHash: string;
	/** Runtime build reported by the embedding server. */
	runtime: string;
}

/**
 * Embedding cache. Vectors are only shared between runs that agree on
 * (recipe, runtime build, served-model fingerprint):
 * - the file is selected by sha256(recipe hash, runtime, CACHE_SCHEMA);
 * - inside it, each distinct probe embedding gets a fingerprint id, and rows are
 *   keyed by (fingerprint id, sha256 of the exact model input).
 * So a server producing a different embedding space never reads another
 * server's vectors. Rows are validated on read (dims, finite, unit norm); an
 * invalid row is reported as a miss and overwritten by the caller.
 */
export class EmbeddingCache {
	private readonly db: Database;
	readonly fingerprintId: number;
	invalidReads = 0;

	constructor(dataDir: string, ns: CacheNamespace, private readonly dims: number, probe: Float32Array) {
		const dir = join(dataDir, 'embed-cache');
		mkdirSync(dir, { recursive: true });
		const file = `v${CACHE_SCHEMA}-${sha256Hex(canonicalJson({ ...ns, schema: CACHE_SCHEMA }))}.sqlite`;
		this.db = new DatabaseSync(join(dir, file));
		this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;');
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS fingerprints (id INTEGER PRIMARY KEY, dims INTEGER NOT NULL, probe BLOB NOT NULL);
			CREATE TABLE IF NOT EXISTS vectors (fp INTEGER NOT NULL, key TEXT NOT NULL, v BLOB NOT NULL, PRIMARY KEY (fp, key));`);
		this.fingerprintId = this.resolveFingerprint(probe);
	}

	private resolveFingerprint(probe: Float32Array): number {
		this.db.exec('BEGIN IMMEDIATE');
		try {
			const rows = this.db.prepare('SELECT id, dims, probe FROM fingerprints ORDER BY id').all() as { id: number; dims: number; probe: Uint8Array }[];
			for (const row of rows) {
				if (row.dims !== this.dims || row.probe.byteLength !== this.dims * 4) continue;
				const stored = new Float32Array(row.probe.buffer.slice(row.probe.byteOffset, row.probe.byteOffset + row.probe.byteLength));
				if (isUnitVector(stored, this.dims) && cosine(stored, probe) >= FINGERPRINT_MIN_COSINE) {
					this.db.exec('COMMIT');
					return row.id;
				}
			}
			const res = this.db.prepare('INSERT INTO fingerprints (dims, probe) VALUES (?, ?)').run(this.dims, new Uint8Array(probe.buffer, probe.byteOffset, probe.byteLength));
			this.db.exec('COMMIT');
			return Number(res.lastInsertRowid);
		} catch (err) {
			this.db.exec('ROLLBACK');
			throw err;
		}
	}

	static key(input: string): string {
		return sha256Hex(input);
	}

	get(input: string): Float32Array | null {
		const row = this.db.prepare('SELECT v FROM vectors WHERE fp = ? AND key = ?').get(this.fingerprintId, EmbeddingCache.key(input)) as { v: Uint8Array } | undefined;
		if (!row) return null;
		if (row.v.byteLength !== this.dims * 4) {
			this.invalidReads++;
			return null;
		}
		const v = new Float32Array(row.v.buffer.slice(row.v.byteOffset, row.v.byteOffset + row.v.byteLength));
		if (!isUnitVector(v, this.dims)) {
			this.invalidReads++;
			return null;
		}
		return v;
	}

	putMany(entries: { input: string; vector: Float32Array }[]): void {
		const stmt = this.db.prepare('INSERT OR REPLACE INTO vectors (fp, key, v) VALUES (?, ?, ?)');
		this.db.exec('BEGIN');
		try {
			for (const e of entries) {
				if (!isUnitVector(e.vector, this.dims)) throw new Error('refusing to cache an invalid vector');
				stmt.run(this.fingerprintId, EmbeddingCache.key(e.input), new Uint8Array(e.vector.buffer, e.vector.byteOffset, e.vector.byteLength));
			}
			this.db.exec('COMMIT');
		} catch (err) {
			this.db.exec('ROLLBACK');
			throw err;
		}
	}

	close(): void {
		this.db.close();
	}
}
