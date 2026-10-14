import type { Evidence } from './fixture.js';

export interface RetrievedChunk {
	source_id: string;
	path: string;
	start_line: number;
	end_line: number;
}

export function overlaps(hit: RetrievedChunk, e: Evidence): boolean {
	return hit.source_id === e.source_id && hit.path === e.path && hit.start_line <= e.end_line && hit.end_line >= e.start_line;
}

export interface QuestionScore {
	/** At least one expected range overlaps a retrieved chunk in the top k. */
	hit: boolean;
	/** Fraction of expected ranges overlapped by some retrieved chunk in the top k. */
	recall: number;
	/** 1 / rank of the first retrieved chunk that overlaps any expected range (0 if none in top k). */
	reciprocalRank: number;
	firstRank: number | null;
	foundEvidence: number;
}

/** Scores one answerable question against the top-k retrieved chunks (in rank order). */
export function scoreQuestion(retrieved: readonly RetrievedChunk[], expected: readonly Evidence[], k: number): QuestionScore {
	const top = retrieved.slice(0, k);
	const found = expected.filter((e) => top.some((h) => overlaps(h, e))).length;
	const firstIdx = top.findIndex((h) => expected.some((e) => overlaps(h, e)));
	return {
		hit: found > 0,
		recall: expected.length === 0 ? 0 : found / expected.length,
		reciprocalRank: firstIdx < 0 ? 0 : 1 / (firstIdx + 1),
		firstRank: firstIdx < 0 ? null : firstIdx + 1,
		foundEvidence: found,
	};
}

export interface Aggregate {
	n: number;
	hitAtK: number;
	evidenceRecallAtK: number;
	mrrAtK: number;
}

export function aggregate(scores: readonly QuestionScore[]): Aggregate {
	const n = scores.length;
	const mean = (f: (s: QuestionScore) => number): number => (n === 0 ? 0 : scores.reduce((a, s) => a + f(s), 0) / n);
	return { n, hitAtK: mean((s) => (s.hit ? 1 : 0)), evidenceRecallAtK: mean((s) => s.recall), mrrAtK: mean((s) => s.reciprocalRank) };
}

export function distribution(values: readonly number[]): { n: number; min: number | null; median: number | null; max: number | null } {
	if (values.length === 0) return { n: 0, min: null, median: null, max: null };
	const v = [...values].sort((a, b) => a - b);
	const mid = Math.floor(v.length / 2);
	const median = v.length % 2 ? (v[mid] as number) : ((v[mid - 1] as number) + (v[mid] as number)) / 2;
	return { n: v.length, min: v[0] as number, median, max: v[v.length - 1] as number };
}
