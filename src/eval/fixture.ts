import { readFileSync } from 'node:fs';
import { CodeTrailError } from '../errors.js';
import type { ChunkRecord, Manifest } from '../snapshot.js';

export const QUESTION_TYPES = ['locate', 'flow', 'auth', 'config', 'error', 'partial', 'unused', 'doc-vs-code', 'abstention'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export interface Evidence {
	source_id: string;
	path: string;
	start_line: number;
	end_line: number;
	/** Text that must appear inside [start_line, end_line] of the snapshot file — proves the range is real. */
	anchor: string;
}

export interface EvalQuestion {
	id: string;
	type: QuestionType;
	question: string;
	/** Evidence a correct retrieval should surface. Must be empty for abstention questions. */
	expected: Evidence[];
	/** Abstention only: code that documents the absence (reported, never scored as recall). */
	absence_evidence?: Evidence[];
}

export interface EvalFixture {
	schema: 1;
	project: string;
	snapshot_id: string;
	/** Only `tuning` fixtures exist in the repository; holdout sets are written and kept separately. */
	split: 'tuning';
	questions: EvalQuestion[];
}

export function loadFixture(path: string): EvalFixture {
	let fx: EvalFixture;
	try {
		fx = JSON.parse(readFileSync(path, 'utf8')) as EvalFixture;
	} catch {
		throw new CodeTrailError('USAGE', `Cannot read evaluation fixture: ${path}`);
	}
	if (fx.schema !== 1 || fx.split !== 'tuning' || !Array.isArray(fx.questions)) throw new CodeTrailError('USAGE', 'Evaluation fixture has an unexpected shape');
	return fx;
}

/**
 * Every expected range must point at an included file of the evaluated snapshot,
 * lie within it, and contain its anchor text (read from the snapshot's own chunk
 * texts). Abstention questions must not have expected evidence. Returns problems.
 */
export function validateFixture(fx: EvalFixture, manifest: Manifest, chunks: ChunkRecord[]): string[] {
	const problems: string[] = [];
	const ids = new Set<string>();
	const lines = new Map<string, Map<number, string>>();
	for (const c of chunks) {
		const key = `${c.source_id}\u0000${c.path}`;
		let m = lines.get(key);
		if (!m) lines.set(key, (m = new Map()));
		c.text.split('\n').forEach((text, i) => m!.set(c.start_line + i, text));
	}
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
		let found = false;
		for (let l = e.start_line; l <= e.end_line && !found; l++) found = (m.get(l) ?? '').includes(e.anchor);
		if (!found) problems.push(`${where}: anchor ${JSON.stringify(e.anchor)} not found in range`);
	};
	for (const q of fx.questions) {
		if (ids.has(q.id)) problems.push(`${q.id}: duplicate id`);
		ids.add(q.id);
		if (!(QUESTION_TYPES as readonly string[]).includes(q.type)) problems.push(`${q.id}: unknown type ${q.type}`);
		if (!q.question?.trim()) problems.push(`${q.id}: empty question`);
		if (q.type === 'abstention') {
			if (q.expected.length > 0) problems.push(`${q.id}: abstention question must not have expected evidence`);
		} else if (q.expected.length === 0) problems.push(`${q.id}: answerable question needs expected evidence`);
		q.expected.forEach((e) => checkEvidence(q, e, 'expected'));
		(q.absence_evidence ?? []).forEach((e) => checkEvidence(q, e, 'absence'));
	}
	return problems;
}
