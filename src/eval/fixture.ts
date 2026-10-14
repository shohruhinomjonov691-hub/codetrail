import { readFileSync } from 'node:fs';
import { CodeTrailError } from '../errors.js';
import type { ChunkRecord, Manifest } from '../snapshot.js';
import { isValidIdentifier, occurrencesInSource } from './identifiers.js';
import { declarationToken, expectedOccurrences } from './reference-scan.js';

export const QUESTION_TYPES = ['locate', 'flow', 'auth', 'config', 'error', 'partial', 'unused', 'doc-vs-code', 'abstention'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/**
 * One piece of evidence: a single-line `anchor` that must occur inside
 * [start_line, end_line] of the snapshot file. Scoring uses the anchor line(s),
 * not the range: the evidence counts as retrieved only when ONE retrieved chunk
 * contains an anchor line and that line of the chunk text contains the anchor.
 * Chunks are never combined (an anchor is a single line).
 */
export interface Evidence {
	source_id: string;
	path: string;
	start_line: number;
	end_line: number;
	anchor: string;
}

/**
 * Identifier-occurrence scan for "is X used?" questions — a syntactic token count
 * reported apart from retrieval (not binding-aware, not a runtime-usage proof).
 */
export interface ReferenceScan {
	identifier: string;
	source_id: string;
	/** The declaration token (excluded from the count) is the declaration name on this line. */
	declared_path: string;
	declared_line: number;
	expect_occurrences?: number;
	/** Legacy name for expect_occurrences. */
	expect_usages?: number;
}

export interface EvalQuestion {
	id: string;
	type: QuestionType;
	question: string;
	/** Each group must be satisfied by retrieving ANY ONE of its alternatives. Empty for abstention. */
	required: Evidence[][];
	/** Helpful but not needed; never part of the recall denominator. */
	optional: Evidence[];
	/** Abstention only: code that documents the absence (reported, never scored as recall). */
	absence_evidence?: Evidence[];
	reference_scan?: ReferenceScan;
}

export interface EvalFixture {
	schema: 2;
	project: string;
	snapshot_id: string;
	/** Only `tuning` fixtures exist in the repository; holdout sets are written and kept separately. */
	split: 'tuning';
	questions: EvalQuestion[];
}

/** Schema 1 (`expected: Evidence[]`) is read as one required group per expected item. */
function upgrade(raw: unknown): EvalFixture {
	const fx = raw as { schema?: number; questions?: unknown[] } & Record<string, unknown>;
	if (fx.schema === 2) return fx as unknown as EvalFixture;
	if (fx.schema === 1 && Array.isArray(fx.questions)) {
		return {
			...(fx as unknown as EvalFixture),
			schema: 2,
			questions: (fx.questions as (EvalQuestion & { expected?: Evidence[] })[]).map(({ expected = [], ...q }) => ({ ...q, required: expected.map((e) => [e]), optional: [] })),
		};
	}
	throw new CodeTrailError('USAGE', 'Evaluation fixture has an unexpected schema');
}

export function normalizeFixture(raw: unknown): EvalFixture {
	const fx = upgrade(raw);
	if (fx.split !== 'tuning' || !Array.isArray(fx.questions)) throw new CodeTrailError('USAGE', 'Evaluation fixture has an unexpected shape');
	for (const q of fx.questions) {
		q.required ??= [];
		q.optional ??= [];
	}
	return fx;
}

export function loadFixture(path: string): EvalFixture {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		throw new CodeTrailError('USAGE', `Cannot read evaluation fixture: ${path}`);
	}
	return normalizeFixture(raw);
}

/** Line → text for every chunked line of every file in the snapshot. */
export type SnapshotLines = Map<string, Map<number, string>>;

export function snapshotLines(chunks: readonly ChunkRecord[]): SnapshotLines {
	const lines: SnapshotLines = new Map();
	for (const c of chunks) {
		const key = `${c.source_id}\u0000${c.path}`;
		let m = lines.get(key);
		if (!m) lines.set(key, (m = new Map()));
		c.text.split('\n').forEach((text, i) => m!.set(c.start_line + i, text));
	}
	return lines;
}

/** Lines inside the evidence range whose text contains the anchor. */
export function anchorLines(e: Evidence, lines: SnapshotLines): number[] {
	const m = lines.get(`${e.source_id}\u0000${e.path}`);
	const out: number[] = [];
	if (!m || !e.anchor) return out;
	for (let l = e.start_line; l <= e.end_line; l++) if ((m.get(l) ?? '').includes(e.anchor)) out.push(l);
	return out;
}

/**
 * Every evidence item must point at an included file of the evaluated snapshot,
 * lie within it, and contain its single-line anchor. Required groups must be
 * non-empty; abstention questions have none; reference scans must name a
 * declaration line that contains the identifier. Returns all problems found.
 */
export function validateFixture(fx: EvalFixture, manifest: Manifest, chunks: ChunkRecord[]): string[] {
	const problems: string[] = [];
	const ids = new Set<string>();
	const lines = snapshotLines(chunks);
	const checkEvidence = (q: EvalQuestion, e: Evidence, label: string): void => {
		const where = `${q.id} ${label} ${e.source_id}:${e.path}:L${e.start_line}-${e.end_line}`;
		const file = manifest.files.find((f) => f.source_id === e.source_id && f.path === e.path);
		if (!file) return void problems.push(`${where}: file not in snapshot`);
		if (file.status !== 'included') return void problems.push(`${where}: file is excluded (${file.reason})`);
		if (!Number.isInteger(e.start_line) || !Number.isInteger(e.end_line) || e.start_line < 1 || e.end_line < e.start_line) {
			return void problems.push(`${where}: invalid line range`);
		}
		const m = lines.get(`${e.source_id}\u0000${e.path}`) ?? new Map<number, string>();
		const maxLine = Math.max(0, ...m.keys());
		if (e.end_line > maxLine + 2) problems.push(`${where}: range beyond end of file (last chunked line ${maxLine})`);
		if (!e.anchor || e.anchor.length < 3) return void problems.push(`${where}: missing anchor`);
		if (e.anchor.includes('\n')) return void problems.push(`${where}: anchor must be a single line`);
		if (anchorLines(e, lines).length === 0) problems.push(`${where}: anchor ${JSON.stringify(e.anchor)} not found in range`);
	};
	for (const q of fx.questions) {
		if (ids.has(q.id)) problems.push(`${q.id}: duplicate id`);
		ids.add(q.id);
		if (!(QUESTION_TYPES as readonly string[]).includes(q.type)) problems.push(`${q.id}: unknown type ${q.type}`);
		if (!q.question?.trim()) problems.push(`${q.id}: empty question`);
		if (q.type === 'abstention') {
			if (q.required.length > 0 || q.optional.length > 0) problems.push(`${q.id}: abstention question must not have required or optional evidence`);
		} else if (q.required.length === 0) problems.push(`${q.id}: answerable question needs at least one required group`);
		q.required.forEach((group, g) => {
			if (!Array.isArray(group) || group.length === 0) problems.push(`${q.id}: required group ${g + 1} is empty`);
			else group.forEach((e) => checkEvidence(q, e, `required[${g + 1}]`));
		});
		q.optional.forEach((e) => checkEvidence(q, e, 'optional'));
		(q.absence_evidence ?? []).forEach((e) => checkEvidence(q, e, 'absence'));
		if (q.reference_scan) {
			const r = q.reference_scan;
			if (!isValidIdentifier(r.identifier)) problems.push(`${q.id}: reference_scan identifier is not a JavaScript identifier`);
			else {
				// Same tokenization as the scanner: exactly one declaration-name token on the declared line.
				const decl = declarationToken(occurrencesInSource(chunks, r.source_id, r.identifier), r);
				if (decl.length !== 1) problems.push(`${q.id}: reference_scan expects one declaration of ${r.identifier} at ${r.declared_path}:${r.declared_line}, found ${decl.length}`);
			}
			const expect = expectedOccurrences(r);
			if (!Number.isInteger(expect) || expect < 0) problems.push(`${q.id}: reference_scan expect_occurrences must be a non-negative integer`);
		}
	}
	return problems;
}
