import { LineIndex } from './lines.js';
import { splitRange, type BreakPoint } from './split.js';
import type { ChunkKind, RawChunk } from './types.js';

/** Markdown: break preferentially at headings (outside code fences), then blank lines. */
export function chunkMarkdown(text: string): RawChunk[] {
	const idx = new LineIndex(text);
	const breaks: BreakPoint[] = [];
	let inFence = false;
	let firstHeading: string | null = null;
	for (let line = 1; line <= idx.count; line++) {
		const content = idx.lines[line - 1] as string;
		if (/^\s*(```|~~~)/.test(content)) inFence = !inFence;
		const heading = !inFence ? /^(#{1,6})\s+(.*)$/.exec(content) : null;
		if (heading) {
			breaks.push({ line, depth: (heading[1] as string).length });
			firstHeading ??= (heading[2] as string).trim().slice(0, 80);
		}
	}
	return labelSections(idx, splitRange(idx, 1, lastContentLine(idx), breaks, 'markdown-section', firstHeading));
}

/** Re-label markdown chunks with the nearest heading at or above their first line. */
function labelSections(idx: LineIndex, chunks: RawChunk[]): RawChunk[] {
	return chunks.map((chunk) => {
		for (let line = chunk.startLine; line >= 1; line--) {
			const heading = /^#{1,6}\s+(.*)$/.exec(idx.lines[line - 1] as string);
			if (heading) return { ...chunk, symbol: (heading[1] as string).trim().slice(0, 80) };
		}
		return chunk;
	});
}

/** JSON / YAML / GraphQL: whole file when it fits, else break at shallow-indent lines. */
export function chunkStructured(text: string, kind: ChunkKind): RawChunk[] {
	const idx = new LineIndex(text);
	const breaks: BreakPoint[] = [];
	for (let line = 2; line <= idx.count; line++) {
		const content = idx.lines[line - 1] as string;
		if (content.trim().length === 0) continue;
		const indent = content.length - content.trimStart().length;
		if (indent <= 4) breaks.push({ line, depth: indent });
	}
	return splitRange(idx, 1, lastContentLine(idx), breaks, kind, null);
}

function lastContentLine(idx: LineIndex): number {
	let line = idx.count;
	while (line > 1 && idx.isBlank(line)) line--;
	return line;
}
