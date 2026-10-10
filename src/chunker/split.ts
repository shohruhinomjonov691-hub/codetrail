import { LineIndex } from './lines.js';
import { CHUNK_LIMITS, type ChunkKind, type RawChunk } from './types.js';

/** A line where a new segment may begin; lower depth = more natural boundary. */
export interface BreakPoint {
	line: number;
	depth: number;
}

export function fits(idx: LineIndex, start: number, end: number): boolean {
	return end - start + 1 <= CHUNK_LIMITS.maxLines && idx.chars(start, end) <= CHUNK_LIMITS.maxChars;
}

/**
 * Splits [start, end] into segments that each fit the limits. Prefers the
 * shallowest available break point inside the window (ties → latest line),
 * avoiding segments shorter than a quarter of the line limit when possible,
 * and falls back to a hard cut. Deterministic for a given input.
 */
export function splitRange(
	idx: LineIndex,
	start: number,
	end: number,
	breaks: readonly BreakPoint[],
	kind: ChunkKind,
	symbol: string | null,
): RawChunk[] {
	if (fits(idx, start, end)) return [{ kind, symbol, startLine: start, endLine: end, part: null }];

	const byLine = new Map<number, number>();
	for (const b of breaks) {
		if (b.line <= start || b.line > end) continue;
		const prev = byLine.get(b.line);
		if (prev === undefined || b.depth < prev) byLine.set(b.line, b.depth);
	}
	for (let line = start + 1; line <= end; line++) {
		if (idx.isBlank(line - 1) && !byLine.has(line)) byLine.set(line, 1000);
	}

	const minSegment = Math.floor(CHUNK_LIMITS.maxLines / 4);
	const segments: [number, number][] = [];
	let segStart = start;
	while (segStart <= end) {
		let maxEnd = segStart;
		while (maxEnd < end && fits(idx, segStart, maxEnd + 1)) maxEnd++;
		if (maxEnd === end) {
			segments.push([segStart, end]);
			break;
		}
		const pick = (minLen: number): number | null => {
			let best: number | null = null;
			let bestDepth = Infinity;
			for (let line = segStart + minLen; line <= maxEnd + 1; line++) {
				const depth = byLine.get(line);
				if (depth === undefined || line <= segStart) continue;
				if (depth < bestDepth || (depth === bestDepth && best !== null && line > best)) {
					best = line;
					bestDepth = depth;
				}
			}
			return best;
		};
		const next = pick(minSegment) ?? pick(1) ?? maxEnd + 1;
		segments.push([segStart, next - 1]);
		segStart = next;
	}

	// Drop whitespace-only segments; label parts.
	const kept = segments.filter(([a, b]) => idx.slice(a, b).trim().length > 0);
	return kept.map(([a, b], i) => ({
		kind,
		symbol,
		startLine: a,
		endLine: b,
		part: kept.length > 1 ? { index: i + 1, total: kept.length } : null,
	}));
}
