import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CodeTrailError } from '../errors.js';
import { canonicalJson, sha256Hex } from '../hash.js';
import { DatabaseSync, type Database } from '../sqlite.js';
import type { ModelIdentity } from '../embedding/provider.js';
import { isUnitVector } from '../embedding/vectors.js';

/** Bumped when the cache layout or keying changes; older cache files are simply not read. */
export const CACHE_SCHEMA = 3;

/** Bounded retry for concurrent first-time initialization (WAL switch, schema creation). */
export const CACHE_INIT = { attempts: 40, maxBackoffMs: 250, busyTimeoutMs: 10_000 } as const;

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function isBusy(err: unknown): boolean {
	const e = err as { errcode?: number; message?: string };
	return e.errcode === 5 || e.errcode === 6 || /database is locked|database table is locked|SQLITE_BUSY/i.test(e.message ?? '');
}

/**
 * Embedding cache, shared only between runs with the same confirmed model
 * identity: the file is selected by sha256(model sha256, runtime build, recipe
 * hash, CACHE_SCHEMA), so vectors from a different model file, runtime or
 * recipe are never read. A probe cosine is NOT used as identity.
 * Rows are validated on read (dims, finite, unit norm); an invalid row is
 * reported as a miss and overwritten by the caller.
 *
 * Extra guard (never a reason to accept): llama-server does not report its
 * pooling/normalization settings, so the first run stores its probe embedding as
 * the namespace reference. A later run whose probe is not byte-identical (same
 * file, same build, same machine is bit-reproducible) gets `reusable = false`:
 * it neither reads nor writes the cache.
 */
export class EmbeddingCache {
	private readonly db: Database;
	invalidReads = 0;
	/** False when this run's probe differs from the namespace reference probe. */
	readonly reusable: boolean;

	constructor(dataDir: string, identity: ModelIdentity, private readonly dims: number, probe: Float32Array) {
		const dir = join(dataDir, 'embed-cache');
		const file = `v${CACHE_SCHEMA}-${sha256Hex(canonicalJson({ modelSha256: identity.modelSha256, runtime: identity.runtime, recipeHash: identity.recipeHash, schema: CACHE_SCHEMA }))}.sqlite`;
		try {
			mkdirSync(dir, { recursive: true });
			this.db = new DatabaseSync(join(dir, file));
		} catch (err) {
			throw new CodeTrailError('CACHE_FAILED', `Cannot open embedding cache: ${(err as Error).message}`);
		}
		// busy_timeout first, so every later statement waits instead of failing on contention.
		this.db.exec(`PRAGMA busy_timeout = ${CACHE_INIT.busyTimeoutMs}`);
		this.initialize();
		this.reusable = this.matchesReferenceProbe(probe);
	}

	private matchesReferenceProbe(probe: Float32Array): boolean {
		const bytes = new Uint8Array(probe.buffer, probe.byteOffset, probe.byteLength);
		this.db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('reference_probe', ?)").run(bytes);
		const row = this.db.prepare("SELECT v FROM meta WHERE k = 'reference_probe'").get() as { v: Uint8Array } | undefined;
		return !!row && Buffer.from(row.v).equals(Buffer.from(bytes));
	}

	/** WAL switch and schema creation can still race on a brand-new file; retry only contention. */
	private initialize(): void {
		let delay = 5;
		for (let attempt = 1; ; attempt++) {
			try {
				this.db.exec('PRAGMA journal_mode = WAL');
				this.db.exec('CREATE TABLE IF NOT EXISTS vectors (key TEXT PRIMARY KEY, v BLOB NOT NULL)');
				this.db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v BLOB NOT NULL)');
				return;
			} catch (err) {
				if (!isBusy(err)) {
					this.db.close();
					throw new CodeTrailError('CACHE_FAILED', `Embedding cache initialization failed: ${(err as Error).message}`);
				}
				if (attempt >= CACHE_INIT.attempts) {
					this.db.close();
					throw new CodeTrailError('CACHE_FAILED', `Embedding cache stayed locked after ${attempt} attempts`);
				}
				Atomics.wait(sleeper, 0, 0, delay);
				delay = Math.min(delay * 2, CACHE_INIT.maxBackoffMs);
			}
		}
	}

	static key(input: string): string {
		return sha256Hex(input);
	}

	get(input: string): Float32Array | null {
		if (!this.reusable) return null;
		const row = this.db.prepare('SELECT v FROM vectors WHERE key = ?').get(EmbeddingCache.key(input)) as { v: Uint8Array } | undefined;
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
		if (!this.reusable) return;
		const stmt = this.db.prepare('INSERT OR REPLACE INTO vectors (key, v) VALUES (?, ?)');
		this.db.exec('BEGIN IMMEDIATE');
		try {
			for (const e of entries) {
				if (!isUnitVector(e.vector, this.dims)) throw new Error('refusing to cache an invalid vector');
				stmt.run(EmbeddingCache.key(e.input), new Uint8Array(e.vector.buffer, e.vector.byteOffset, e.vector.byteLength));
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
