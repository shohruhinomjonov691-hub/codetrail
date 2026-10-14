import type { Evidence } from './fixture.js';

export interface RetrievedChunk {
	source_id: string;
	path: string;
	start_line: number;
	end_line: number;
	/** Exact chunk text, needed to confirm the anchor is in what was retrieved. */
	text: string;
}

/** Evidence plus the snapshot lines (inside its range) that contain its anchor. */
export interface ResolvedEvidence extends Evidence {
	anchorLines: number[];
}

/**
 * True when this one chunk retrieved the evidence: it covers an anchor line and
 * its own text at that line contains the anchor. A range overlap alone is not
 * enough, and chunks are not combined.
 */
export function retrievesEvidence(hit: RetrievedChunk, e: ResolvedEvidence): boolean {
	if (hit.source_id !== e.source_id || hit.path !== e.path) return false;
	const lines = hit.text.split('\n');
	return e.anchorLines.some((l) => l >= hit.start_line && l <= hit.end_line && (lines[l - hit.start_line] ?? '').includes(e.anchor));
}

export interface QuestionScore {
	/** At least one required group is satisfied in the top k. */
	hit: boolean;
	/** Satisfied required groups / required groups (optional evidence never counts). */
	recall: number;
	/** 1 / rank of the first chunk that retrieves any alternative of any required group (0 if none in top k). */
	reciprocalRank: number;
	firstRank: number | null;
	satisfiedGroups: number;
	requiredGroups: number;
	optionalFound: number;
}

export function scoreQuestion(retrieved: readonly RetrievedChunk[], required: readonly (readonly ResolvedEvidence[])[], optional: readonly ResolvedEvidence[], k: number): QuestionScore {
	const top = retrieved.slice(0, k);
	const found = (e: ResolvedEvidence): boolean => top.some((h) => retrievesEvidence(h, e));
	const satisfied = required.filter((group) => group.some(found)).length;
	const firstIdx = top.findIndex((h) => required.some((group) => group.some((e) => retrievesEvidence(h, e))));
	return {
		hit: satisfied > 0,
		recall: required.length === 0 ? 0 : satisfied / required.length,
		reciprocalRank: firstIdx < 0 ? 0 : 1 / (firstIdx + 1),
		firstRank: firstIdx < 0 ? null : firstIdx + 1,
		satisfiedGroups: satisfied,
		requiredGroups: required.length,
		optionalFound: optional.filter(found).length,
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
