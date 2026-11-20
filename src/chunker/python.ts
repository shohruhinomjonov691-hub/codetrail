import { LineIndex } from './lines.js';
import { fits, splitRange, type BreakPoint } from './split.js';
import type { ChunkKind, RawChunk } from './types.js';

/**
 * Python chunker without a Python parser: it reads indentation and the keywords
 * `def`, `async def`, `class` and decorators at column 0. A top-level definition
 * (with its decorators and the comment lines directly above it) is one unit; a
 * unit that does not fit the chunk limits is split at nested `def` lines (methods)
 * and then at blank lines. Everything between units (imports, constants, module
 * code) is packed into `module` chunks. This is a line-based heuristic: it does
 * not understand multi-line strings that contain unindented `def`/`class` text.
 */

const DEF = /^(?:async\s+)?def\s+([A-Za-z_][\w]*)/;
const CLASS = /^class\s+([A-Za-z_][\w]*)/;

interface Unit {
	start: number;
	end: number;
	kind: ChunkKind;
	symbol: string | null;
}

/** Lines inside triple-quoted strings (docstrings) must not be read as code. */
function tripleQuoteMask(lines: readonly string[]): boolean[] {
	const inside = new Array<boolean>(lines.length).fill(false);
	let open: string | null = null;
	lines.forEach((line, i) => {
		if (open) inside[i] = true;
		for (const m of line.matchAll(/("""|''')/g)) {
			const q = m[1] as string;
			if (open === null) open = q;
			else if (open === q) open = null;
		}
	});
	return inside;
}

export function chunkPython(text: string): RawChunk[] {
	const idx = new LineIndex(text);
	const inString = tripleQuoteMask(idx.lines);
	let last = idx.count;
	while (last > 1 && idx.isBlank(last)) last--;

	// 1. Top-level definitions: [start, end] with decorators and directly-attached comments.
	const heads: { line: number; kind: ChunkKind; symbol: string }[] = [];
	for (let line = 1; line <= last; line++) {
		if (inString[line - 1]) continue;
		const content = idx.lines[line - 1] as string;
		const def = DEF.exec(content);
		const cls = def ? null : CLASS.exec(content);
		if (def) heads.push({ line, kind: 'function', symbol: def[1] as string });
		else if (cls) heads.push({ line, kind: 'class', symbol: cls[1] as string });
	}

	const attachStart = (line: number): number => {
		let s = line;
		while (s > 1) {
			const prev = idx.lines[s - 2] as string;
			if (/^@/.test(prev) || /^#/.test(prev)) s--;
			else break;
		}
		return s;
	};

	const units: Unit[] = [];
	heads.forEach((h, i) => {
		const start = attachStart(h.line);
		const nextHead = heads[i + 1];
		let end = nextHead ? attachStart(nextHead.line) - 1 : last;
		// the unit ends at its last non-blank line
		while (end > start && idx.isBlank(end)) end--;
		// a definition never swallows a preceding unit's tail (decorators of the next one are excluded above)
		if (units.length && start <= (units[units.length - 1] as Unit).end) return;
		units.push({ start, end, kind: h.kind, symbol: h.symbol });
	});

	// 2. Emit: module code between units, then each unit (split when it does not fit).
	const out: RawChunk[] = [];
	let cursor = 1;
	const emitModule = (a: number, b: number): void => {
		while (a <= b && idx.isBlank(a)) a++;
		while (b >= a && idx.isBlank(b)) b--;
		if (a > b) return;
		const breaks: BreakPoint[] = [];
		for (let l = a + 1; l <= b; l++) if (!inString[l - 1] && /^\S/.test(idx.lines[l - 1] as string)) breaks.push({ line: l, depth: 0 });
		out.push(...splitRange(idx, a, b, breaks, 'module', null));
	};
	for (const u of units) {
		emitModule(cursor, u.start - 1);
		if (fits(idx, u.start, u.end)) out.push({ kind: u.kind, symbol: u.symbol, startLine: u.start, endLine: u.end, part: null });
		else {
			const breaks: BreakPoint[] = [];
			for (let l = u.start + 1; l <= u.end; l++) {
				if (inString[l - 1]) continue;
				const content = idx.lines[l - 1] as string;
				const indent = content.length - content.trimStart().length;
				if (content.trim().length === 0) continue;
				if (/^\s+(?:async\s+)?def\s/.test(content) || /^\s+@/.test(content)) breaks.push({ line: attachStart(l), depth: Math.min(indent, 8) });
				else if (indent <= 4) breaks.push({ line: l, depth: 10 + indent });
			}
			out.push(...splitRange(idx, u.start, u.end, breaks, u.kind, u.symbol));
		}
		cursor = u.end + 1;
	}
	emitModule(cursor, last);
	return out.sort((x, y) => x.startLine - y.startLine);
}
