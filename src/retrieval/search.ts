import { CodeTrailError } from '../errors.js';
import type { EmbeddingProvider } from '../embedding/provider.js';
import { formatQuery, PROBE_TEXT } from '../embedding/recipe.js';
import { assertExactUnitVector } from '../embedding/vectors.js';
import type { LoadedIndex } from './index.js';
import { ftsQuery } from './text.js';

export type SearchMode = 'bm25' | 'vector' | 'hybrid';

export const SEARCH_LIMITS = { maxQueryChars: 1000, defaultK: 8, maxK: 20, candidatePool: 100, rrfK: 30, probeMinCosine: 0.9999 } as const;

/**
 * BM25 column weights: path, symbol, text, split identifiers. Together with
 * rrfK = 30 and a candidate pool of 100 these were chosen by a 108-config grid on
 * the TUNING questions only (eval/*.tuning.json, 26 answerable); the holdout set
 * was not used. Before tuning: [2, 3, 1, 1], rrfK 60, pool 50.
 */
const BM25_WEIGHTS = [3.0, 3.0, 1.0, 2.0] as const;

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

const assertQueryVector: (v: unknown, dims: number, what: string) => asserts v is Float32Array = assertExactUnitVector;

/**
 * Confirms the provider is the model the index was built with. Identity is the
 * confirmed (loaded model sha256, runtime build, recipe hash) — all must match
 * the index exactly. The stored probe is then compared as a drift check only.
 */
export async function verifyProviderAgainstIndex(index: LoadedIndex, provider: EmbeddingProvider): Promise<void> {
	const id = await provider.identity();
	const want = index.meta.identity;
	if (id.modelSha256 !== want.modelSha256 || id.runtime !== want.runtime || id.recipeHash !== want.recipeHash) {
		throw new CodeTrailError('MODEL_MISMATCH', 'Embedding model identity differs from the index (model file, runtime or recipe)');
	}
	const [probe] = await provider.embed([PROBE_TEXT], 'document');
	assertQueryVector(probe, index.meta.dims, 'Probe embedding');
	const cos = dot(probe, 0, index.probe);
	if (!(cos >= SEARCH_LIMITS.probeMinCosine)) {
		throw new CodeTrailError('MODEL_MISMATCH', `Embedding server fingerprint differs from the index (cosine ${cos.toFixed(6)})`);
	}
}

/** Retrieval parameters that the evaluation may tune. Defaults are the shipped values. */
export interface SearchTuning {
	/** BM25 column weights: path, symbol, text, split identifiers. */
	bm25Weights: readonly [number, number, number, number];
	rrfK: number;
	candidatePool: number;
	/** Drop generic English question words from the BM25 query. */
	bm25Stopwords: boolean;
	/** RRF weights for the two rankings in hybrid mode: [bm25, vector]. */
	rrfWeights: readonly [number, number];
}

export const DEFAULT_TUNING: SearchTuning = {
	bm25Weights: BM25_WEIGHTS,
	rrfK: SEARCH_LIMITS.rrfK,
	candidatePool: SEARCH_LIMITS.candidatePool,
	bm25Stopwords: false,
	rrfWeights: [1, 1],
};

export interface SearchOptions {
	mode: SearchMode;
	k?: number;
	tuning?: Partial<SearchTuning>;
}

function validated(question: string, opts: SearchOptions): { q: string; k: number; t: SearchTuning } {
	const q = question.trim();
	if (q.length === 0) throw new CodeTrailError('INVALID_QUERY', 'Question is empty');
	if (q.length > SEARCH_LIMITS.maxQueryChars) throw new CodeTrailError('INVALID_QUERY', `Question is longer than ${SEARCH_LIMITS.maxQueryChars} characters`);
	const k = opts.k ?? SEARCH_LIMITS.defaultK;
	if (!Number.isInteger(k) || k < 1 || k > SEARCH_LIMITS.maxK) throw new CodeTrailError('INVALID_QUERY', `k must be 1..${SEARCH_LIMITS.maxK}`);
	const t: SearchTuning = { ...DEFAULT_TUNING, ...opts.tuning };
	if (t.bm25Weights.length !== 4 || !t.bm25Weights.every((w) => Number.isFinite(w) && w > 0)) throw new CodeTrailError('INVALID_QUERY', 'bm25Weights must be 4 positive numbers');
	if (!Number.isFinite(t.rrfK) || t.rrfK < 1) throw new CodeTrailError('INVALID_QUERY', 'rrfK must be >= 1');
	if (!Number.isInteger(t.candidatePool) || t.candidatePool < k || t.candidatePool > 500) throw new CodeTrailError('INVALID_QUERY', `candidatePool must be an integer in k..500`);
	if (t.rrfWeights.length !== 2 || !t.rrfWeights.every((w) => Number.isFinite(w) && w >= 0) || t.rrfWeights[0] + t.rrfWeights[1] <= 0) {
		throw new CodeTrailError('INVALID_QUERY', 'rrfWeights must be 2 non-negative numbers, not both zero');
	}
	return { q, k, t };
}

export interface SearchSession {
	search(question: string, opts: SearchOptions): Promise<SearchHit[]>;
}

/**
 * Opens a search session: when a provider is given, its identity is confirmed
 * against the index ONCE (fresh model-file hash, runtime, recipe, probe drift
 * check) and reused for every query in the session.
 */
export async function openSearchSession(index: LoadedIndex, provider?: EmbeddingProvider): Promise<SearchSession> {
	if (provider) await verifyProviderAgainstIndex(index, provider);
	const queryVectors = new Map<string, Float32Array>(); // same question within one session → same embedding
	return {
		search: (question, opts) => {
			if (opts.mode !== 'bm25' && !provider) throw new CodeTrailError('USAGE', `${opts.mode} search needs an embedding provider`);
			return runSearch(index, question, opts, provider, queryVectors);
		},
	};
}

/** One-shot search: validates the input, confirms identity (if needed) and searches. */
export async function search(index: LoadedIndex, question: string, opts: SearchOptions, provider?: EmbeddingProvider): Promise<SearchHit[]> {
	validated(question, opts);
	if (opts.mode !== 'bm25' && !provider) throw new CodeTrailError('USAGE', `${opts.mode} search needs an embedding provider`);
	const session = await openSearchSession(index, opts.mode === 'bm25' ? undefined : provider);
	return session.search(question, opts);
}

async function runSearch(
	index: LoadedIndex,
	question: string,
	opts: SearchOptions,
	provider?: EmbeddingProvider,
	queryVectors: Map<string, Float32Array> = new Map(),
): Promise<SearchHit[]> {
	const { q, k, t } = validated(question, opts);
	const bm25Rank = new Map<number, number>();
	if (opts.mode !== 'vector') {
		const match = ftsQuery(q, { stopwords: t.bm25Stopwords });
		if (match) {
			const rows = index.db
				.prepare(`SELECT rowid AS row FROM fts WHERE fts MATCH ? ORDER BY bm25(fts, ${t.bm25Weights.join(', ')}), rowid LIMIT ?`)
				.all(match, t.candidatePool) as { row: number }[];
			rows.forEach((r, i) => bm25Rank.set(r.row - 1, i + 1));
		}
	}

	const vectorRank = new Map<number, number>();
	const cosine = new Map<number, number>();
	if (opts.mode !== 'bm25') {
		if (!provider) throw new CodeTrailError('USAGE', `${opts.mode} search needs an embedding provider`);
		// Identity was confirmed once when the session was opened.
		// The character limit does not bound tokens: count the exact model input first.
		const input = formatQuery(provider.recipe, q);
		let qv = queryVectors.get(input);
		if (!qv) {
			const tokens = await provider.countTokens(input);
			if (tokens > provider.recipe.maxTokens) {
				throw new CodeTrailError('TOKEN_LIMIT', `Query is ${tokens} tokens; the embedding limit is ${provider.recipe.maxTokens} (not truncated)`);
			}
			const [embedded] = await provider.embed([input], 'query');
			assertQueryVector(embedded, index.meta.dims, 'Query embedding');
			qv = embedded;
			queryVectors.set(input, qv);
		}
		const dims = index.meta.dims;
		const scored: { i: number; s: number }[] = [];
		for (let i = 0; i < index.meta.chunk_count; i++) scored.push({ i, s: dot(index.vectors, i * dims, qv as Float32Array) });
		scored.sort((a, b) => b.s - a.s || a.i - b.i);
		scored.slice(0, t.candidatePool).forEach((x, r) => {
			vectorRank.set(x.i, r + 1);
			cosine.set(x.i, x.s);
		});
	}

	const fused = new Map<number, number>();
	// Weights only matter when two rankings are fused; a single ranking keeps its own order.
	const [wb, wv] = opts.mode === 'hybrid' ? t.rrfWeights : [1, 1];
	for (const [i, r] of bm25Rank) fused.set(i, (fused.get(i) ?? 0) + wb / (t.rrfK + r));
	for (const [i, r] of vectorRank) fused.set(i, (fused.get(i) ?? 0) + wv / (t.rrfK + r));
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
