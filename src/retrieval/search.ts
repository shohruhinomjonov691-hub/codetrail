import { CodeTrailError } from '../errors.js';
import type { EmbeddingProvider } from '../embedding/provider.js';
import { formatQuery, PROBE_TEXT } from '../embedding/recipe.js';
import type { LoadedIndex } from './index.js';
import { ftsQuery } from './text.js';

export type SearchMode = 'bm25' | 'vector' | 'hybrid';

export const SEARCH_LIMITS = { maxQueryChars: 1000, defaultK: 8, maxK: 20, candidatePool: 50, rrfK: 60, probeMinCosine: 0.9999 } as const;

/** BM25 column weights: path, symbol, text, split identifiers. */
const BM25_WEIGHTS = [2.0, 3.0, 1.0, 1.0] as const;

export interface SearchHit {
	rank: number;
	chunk_id: string;
	source_id: string;
	commit: string;
	path: string;
	start_line: number;
	end_line: number;
	symbol: string | null;
	kind: string;
	citation: string;
	scores: { rrf: number; bm25_rank: number | null; vector_rank: number | null; vector_cosine: number | null };
}

function dot(a: Float32Array, offset: number, b: Float32Array): number {
	let s = 0;
	for (let i = 0; i < b.length; i++) s += (a[offset + i] as number) * (b[i] as number);
	return s;
}

/**
 * Confirms the provider serves the same model the index was built with: the
 * server's model/context must match the recipe and its embedding of a fixed
 * probe text must equal the stored one (cosine ≥ 0.9999).
 */
export async function verifyProviderAgainstIndex(index: LoadedIndex, provider: EmbeddingProvider): Promise<void> {
	if (provider.recipe.model.sha256 !== index.meta.recipe.model.sha256) throw new CodeTrailError('MODEL_MISMATCH', 'Provider recipe differs from the index recipe');
	await provider.verifyServer();
	const [probe] = await provider.embed([PROBE_TEXT], 'document');
	const cos = dot(probe as Float32Array, 0, index.probe);
	if (!(cos >= SEARCH_LIMITS.probeMinCosine)) {
		throw new CodeTrailError('MODEL_MISMATCH', `Embedding server fingerprint differs from the index (cosine ${cos.toFixed(6)})`);
	}
}

export async function search(
	index: LoadedIndex,
	question: string,
	opts: { mode: SearchMode; k?: number },
	provider?: EmbeddingProvider,
): Promise<SearchHit[]> {
	const q = question.trim();
	if (q.length === 0) throw new CodeTrailError('INVALID_QUERY', 'Question is empty');
	if (q.length > SEARCH_LIMITS.maxQueryChars) throw new CodeTrailError('INVALID_QUERY', `Question is longer than ${SEARCH_LIMITS.maxQueryChars} characters`);
	const k = opts.k ?? SEARCH_LIMITS.defaultK;
	if (!Number.isInteger(k) || k < 1 || k > SEARCH_LIMITS.maxK) throw new CodeTrailError('INVALID_QUERY', `k must be 1..${SEARCH_LIMITS.maxK}`);

	const bm25Rank = new Map<number, number>();
	if (opts.mode !== 'vector') {
		const match = ftsQuery(q);
		if (match) {
			const rows = index.db
				.prepare(`SELECT rowid AS row FROM fts WHERE fts MATCH ? ORDER BY bm25(fts, ${BM25_WEIGHTS.join(', ')}), rowid LIMIT ?`)
				.all(match, SEARCH_LIMITS.candidatePool) as { row: number }[];
			rows.forEach((r, i) => bm25Rank.set(r.row - 1, i + 1));
		}
	}

	const vectorRank = new Map<number, number>();
	const cosine = new Map<number, number>();
	if (opts.mode !== 'bm25') {
		if (!provider) throw new CodeTrailError('USAGE', `${opts.mode} search needs an embedding provider`);
		await verifyProviderAgainstIndex(index, provider);
		const [qv] = await provider.embed([formatQuery(provider.recipe, q)], 'query');
		const dims = index.meta.dims;
		const scored: { i: number; s: number }[] = [];
		for (let i = 0; i < index.meta.chunk_count; i++) scored.push({ i, s: dot(index.vectors, i * dims, qv as Float32Array) });
		scored.sort((a, b) => b.s - a.s || a.i - b.i);
		scored.slice(0, SEARCH_LIMITS.candidatePool).forEach((x, r) => {
			vectorRank.set(x.i, r + 1);
			cosine.set(x.i, x.s);
		});
	}

	const fused = new Map<number, number>();
	for (const [i, r] of bm25Rank) fused.set(i, (fused.get(i) ?? 0) + 1 / (SEARCH_LIMITS.rrfK + r));
	for (const [i, r] of vectorRank) fused.set(i, (fused.get(i) ?? 0) + 1 / (SEARCH_LIMITS.rrfK + r));
	const ordered = [...fused.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, k);

	return ordered.map(([i, rrf], n) => {
		const c = index.chunks[i];
		if (!c || c.snapshot_id !== index.meta.snapshot_id || c.project_id !== index.meta.project_id) {
			throw new CodeTrailError('INDEX_CORRUPT', 'Hit outside the requested snapshot');
		}
		return {
			rank: n + 1,
			chunk_id: c.id,
			source_id: c.source_id,
			commit: c.commit,
			path: c.path,
			start_line: c.start_line,
			end_line: c.end_line,
			symbol: c.symbol,
			kind: c.kind,
			citation: `${c.source_id}@${c.commit.slice(0, 12)}:${c.path}:L${c.start_line}-${c.end_line}`,
			scores: { rrf: Number(rrf.toFixed(6)), bm25_rank: bm25Rank.get(i) ?? null, vector_rank: vectorRank.get(i) ?? null, vector_cosine: cosine.has(i) ? Number((cosine.get(i) as number).toFixed(6)) : null },
		};
	});
}
