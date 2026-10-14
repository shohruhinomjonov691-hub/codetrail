import type { ChunkRecord } from '../snapshot.js';
import type { ReferenceScan } from './fixture.js';
import { occurrencesInSource, type IdentifierOccurrence } from './identifiers.js';

/**
 * "Identifier occurrences" for one name in one source of the snapshot: every
 * identifier token with that exact name in the snapshot's code files, except
 * the single declaration token named by the fixture. Not binding-aware and not
 * a runtime-usage proof; only files the snapshot included are scanned.
 */
export interface ReferenceScanResult {
	kind: 'identifier-occurrences';
	identifier: string;
	source_id: string;
	declaration: { path: string; line: number; column: number } | null;
	expect_occurrences: number;
	occurrences: { path: string; line: number; column: number }[];
	passed: boolean;
}

/** The declaration token of `scan`: the declaration-name occurrence on the declared line (exactly one expected). */
export function declarationToken(all: readonly IdentifierOccurrence[], scan: ReferenceScan): IdentifierOccurrence[] {
	return all.filter((o) => o.path === scan.declared_path && o.line === scan.declared_line && o.isDeclarationName);
}

export function expectedOccurrences(scan: ReferenceScan): number {
	return scan.expect_occurrences ?? scan.expect_usages ?? 0;
}

export function scanReferences(chunks: readonly ChunkRecord[], scan: ReferenceScan): ReferenceScanResult {
	const all = occurrencesInSource(chunks, scan.source_id, scan.identifier);
	const decl = declarationToken(all, scan);
	const excluded = decl.length === 1 ? decl[0] : undefined;
	const occurrences = all.filter((o) => o !== excluded).map(({ path, line, column }) => ({ path, line, column }));
	const expect = expectedOccurrences(scan);
	return {
		kind: 'identifier-occurrences',
		identifier: scan.identifier,
		source_id: scan.source_id,
		declaration: excluded ? { path: excluded.path, line: excluded.line, column: excluded.column } : null,
		expect_occurrences: expect,
		occurrences,
		passed: excluded !== undefined && occurrences.length === expect,
	};
}
