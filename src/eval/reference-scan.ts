import type { ChunkRecord } from '../snapshot.js';
import type { ReferenceScan } from './fixture.js';

export interface ReferenceScanResult {
	identifier: string;
	source_id: string;
	expect_usages: number;
	usages: { path: string; line: number }[];
	passed: boolean;
}

/**
 * Counts whole-word occurrences of an identifier across every chunked line of
 * one source in the snapshot, excluding the declaration line. Only files the
 * snapshot included are scanned (excluded/generated files are not seen).
 */
export function scanReferences(chunks: readonly ChunkRecord[], scan: ReferenceScan): ReferenceScanResult {
	const re = new RegExp(`\\b${scan.identifier.replace(/\$/g, '\\$')}\\b`);
	const usages: { path: string; line: number }[] = [];
	for (const c of chunks) {
		if (c.source_id !== scan.source_id) continue;
		c.text.split('\n').forEach((text, i) => {
			const line = c.start_line + i;
			if (c.path === scan.declared_path && line === scan.declared_line) return;
			if (re.test(text)) usages.push({ path: c.path, line });
		});
	}
	usages.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
	return { identifier: scan.identifier, source_id: scan.source_id, expect_usages: scan.expect_usages, usages, passed: usages.length === scan.expect_usages };
}
