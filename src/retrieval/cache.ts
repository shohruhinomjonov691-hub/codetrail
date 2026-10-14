import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '../hash.js';
import { DatabaseSync, type Database } from '../sqlite.js';

/**
 * Embedding cache keyed by (recipe hash, sha256 of the exact model input).
 * A changed model, quantization, pooling, template or limit is a different
 * recipe and therefore a different cache file; unchanged text is never re-embedded.
 */
export class EmbeddingCache {
	private readonly db: Database;

	constructor(dataDir: string, recipeHash: string, private readonly dims: number) {
		const dir = join(dataDir, 'embed-cache');
		mkdirSync(dir, { recursive: true });
		this.db = new DatabaseSync(join(dir, `${recipeHash}.sqlite`));
		this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;');
		this.db.exec('CREATE TABLE IF NOT EXISTS vectors (key TEXT PRIMARY KEY, dims INTEGER NOT NULL, v BLOB NOT NULL)');
	}

	static key(input: string): string {
		return sha256Hex(input);
	}

	get(input: string): Float32Array | null {
		const row = this.db.prepare('SELECT dims, v FROM vectors WHERE key = ?').get(EmbeddingCache.key(input)) as { dims: number; v: Uint8Array } | undefined;
		if (!row || row.dims !== this.dims || row.v.byteLength !== this.dims * 4) return null;
		return new Float32Array(row.v.buffer.slice(row.v.byteOffset, row.v.byteOffset + row.v.byteLength));
	}

	putMany(entries: { input: string; vector: Float32Array }[]): void {
		const stmt = this.db.prepare('INSERT OR REPLACE INTO vectors (key, dims, v) VALUES (?, ?, ?)');
		this.db.exec('BEGIN');
		try {
			for (const e of entries) stmt.run(EmbeddingCache.key(e.input), this.dims, new Uint8Array(e.vector.buffer, e.vector.byteOffset, e.vector.byteLength));
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
