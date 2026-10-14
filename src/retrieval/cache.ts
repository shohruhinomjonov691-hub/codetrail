import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CodeTrailError } from '../errors.js';
import { canonicalJson, sha256Hex } from '../hash.js';
import { DatabaseSync, type Database } from '../sqlite.js';
import type { ModelIdentity } from '../embedding/provider.js';
import { assertExactUnitVector, isExactUnitVector } from '../embedding/vectors.js';

/** Bumped when the cache layout or keying changes; older cache files are simply not read. */
export const CACHE_SCHEMA = 3;

/** Bounded retry for concurrent first-time initialization (WAL switch, schema creation). */
export const CACHE_INIT = { attempts: 40, maxBackoffMs: 250, busyTimeoutMs: 10_000 } as const;

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Expected layout: table → required columns. */
const REQUIRED_SCHEMA: Record<string, readonly string[]> = { vectors: ['key', 'v'], meta: ['k', 'v'] };

function isBusy(err: unknown): boolean {
	const e = err as { errcode?: number; message?: string };
	return e.errcode === 5 || e.errcode === 6 || /database is locked|database table is locked|SQLITE_BUSY/i.test(e.message ?? '');
}

/** Diagnostic summary of an underlying error: codes and the driver message, never data values. */
function diagnostic(err: unknown): { code?: string; errcode?: number; message: string } {
	const e = err as { code?: string; errcode?: number; message?: string };
	return { code: e.code, errcode: e.errcode, message: String(e.message ?? err).slice(0, 300) };
}

/**
 * Embedding cache, shared only between runs with the same confirmed model
 * identity: the file is selected by sha256(model sha256, runtime build, recipe
 * hash, CACHE_SCHEMA). A probe cosine is NOT identity.
 *
 * - Every vector written or read must pass the single strict validator
 *   (Float32Array, exact length, finite, non-zero, unit norm); invalid rows are
 *   reported as misses and recomputed by the caller.
 * - Extra reject-only guard: llama-server does not report pooling/normalization,
 *   so the first run stores its probe as the namespace reference; a run whose
 *   probe is not byte-identical gets `reusable = false` (no reads, no writes).
 * - Construction is all-or-nothing: open, busy_timeout, WAL/schema setup (retried
 *   only on lock contention), schema verification and reference-probe setup all
 *   run under one error handler; on any failure the connection is closed and a
 *   CACHE_FAILED error is thrown with the original cause attached.
 */
export class EmbeddingCache {
	private readonly db: Database;
	invalidReads = 0;
	/** False when this run's probe differs from the namespace reference probe. */
	readonly reusable: boolean;

	constructor(dataDir: string, identity: ModelIdentity, private readonly dims: number, probe: Float32Array) {
		assertExactUnitVector(probe, dims, 'Probe embedding'); // before anything touches the cache
		const file = `v${CACHE_SCHEMA}-${sha256Hex(canonicalJson({ modelSha256: identity.modelSha256, runtime: identity.runtime, recipeHash: identity.recipeHash, schema: CACHE_SCHEMA }))}.sqlite`;
		let db: Database | undefined;
		try {
			const dir = join(dataDir, 'embed-cache');
			mkdirSync(dir, { recursive: true });
			db = new DatabaseSync(join(dir, file));
			// busy_timeout first, so every later statement waits instead of failing on contention.
			db.exec(`PRAGMA busy_timeout = ${CACHE_INIT.busyTimeoutMs}`);
			EmbeddingCache.initialize(db);
			EmbeddingCache.verifySchema(db);
			this.reusable = EmbeddingCache.matchesReferenceProbe(db, probe);
			this.db = db;
		} catch (err) {
			try {
				db?.close();
			} catch {
				/* already closed */
			}
			if (err instanceof CodeTrailError && err.code === 'CACHE_FAILED') throw err;
			const d = diagnostic(err);
			throw new CodeTrailError('CACHE_FAILED', `Embedding cache unavailable (${d.code ?? 'error'}${d.errcode !== undefined ? `/${d.errcode}` : ''}): ${d.message}`, { cause: d });
		}
	}

	/** WAL switch and schema creation can race on a brand-new file; retry only lock contention. */
	private static initialize(db: Database): void {
		let delay = 5;
		for (let attempt = 1; ; attempt++) {
			try {
				db.exec('PRAGMA journal_mode = WAL');
				db.exec('CREATE TABLE IF NOT EXISTS vectors (key TEXT PRIMARY KEY, v BLOB NOT NULL)');
				db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v BLOB NOT NULL)');
				return;
			} catch (err) {
				if (!isBusy(err)) throw err; // permanent: no retry
				if (attempt >= CACHE_INIT.attempts) {
					throw new CodeTrailError('CACHE_FAILED', `Embedding cache stayed locked after ${attempt} attempts`, { cause: diagnostic(err) });
				}
				Atomics.wait(sleeper, 0, 0, delay);
				delay = Math.min(delay * 2, CACHE_INIT.maxBackoffMs);
			}
		}
	}

	/** A pre-existing file with a different layout (missing columns, views, …) is a permanent error. */
	private static verifySchema(db: Database): void {
		for (const [table, columns] of Object.entries(REQUIRED_SCHEMA)) {
			const kind = db.prepare('SELECT type FROM sqlite_master WHERE name = ?').get(table) as { type: string } | undefined;
			if (kind?.type !== 'table') throw new CodeTrailError('CACHE_FAILED', `Embedding cache schema invalid: ${table} is ${kind?.type ?? 'missing'}`);
			const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
			const missing = columns.filter((c) => !have.has(c));
			if (missing.length > 0) throw new CodeTrailError('CACHE_FAILED', `Embedding cache schema invalid: ${table} lacks ${missing.join(', ')}`);
		}
	}

	private static matchesReferenceProbe(db: Database, probe: Float32Array): boolean {
		const bytes = new Uint8Array(probe.buffer, probe.byteOffset, probe.byteLength);
		db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('reference_probe', ?)").run(bytes);
		const row = db.prepare("SELECT v FROM meta WHERE k = 'reference_probe'").get() as { v: Uint8Array } | undefined;
		return !!row && Buffer.from(row.v).equals(Buffer.from(bytes));
	}

	static key(input: string): string {
		return sha256Hex(input);
	}

	get(input: string): Float32Array | null {
		if (!this.reusable) return null;
		const row = this.db.prepare('SELECT v FROM vectors WHERE key = ?').get(EmbeddingCache.key(input)) as { v: Uint8Array } | undefined;
		if (!row) return null;
		if (!(row.v instanceof Uint8Array) || row.v.byteLength !== this.dims * 4) {
			this.invalidReads++;
			return null;
		}
		const v = new Float32Array(row.v.buffer.slice(row.v.byteOffset, row.v.byteOffset + row.v.byteLength));
		if (!isExactUnitVector(v, this.dims)) {
			this.invalidReads++;
			return null;
		}
		return v;
	}

	putMany(entries: { input: string; vector: Float32Array }[]): void {
		for (const e of entries) assertExactUnitVector(e.vector, this.dims, 'Cached embedding'); // all-or-nothing, before writing
		if (!this.reusable) return;
		const stmt = this.db.prepare('INSERT OR REPLACE INTO vectors (key, v) VALUES (?, ?)');
		this.db.exec('BEGIN IMMEDIATE');
		try {
			for (const e of entries) stmt.run(EmbeddingCache.key(e.input), new Uint8Array(e.vector.buffer, e.vector.byteOffset, e.vector.byteLength));
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
