/**
 * 1-based line arithmetic over the exact file text. Lines are split on "\n"
 * only, so `slice(a, b)` is byte-for-byte the original text of those lines
 * (a trailing "\r" stays part of its line).
 */
export class LineIndex {
	readonly lines: string[];
	private readonly starts: number[];

	constructor(readonly text: string) {
		this.lines = text.split('\n');
		this.starts = new Array<number>(this.lines.length);
		let offset = 0;
		for (let i = 0; i < this.lines.length; i++) {
			this.starts[i] = offset;
			offset += (this.lines[i] as string).length + 1;
		}
	}

	get count(): number {
		return this.lines.length;
	}

	/** 1-based line containing character offset `pos`. */
	lineOf(pos: number): number {
		let lo = 0;
		let hi = this.starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if ((this.starts[mid] as number) <= pos) lo = mid;
			else hi = mid - 1;
		}
		return lo + 1;
	}

	slice(startLine: number, endLine: number): string {
		return this.lines.slice(startLine - 1, endLine).join('\n');
	}

	chars(startLine: number, endLine: number): number {
		let total = endLine - startLine; // newlines between lines
		for (let i = startLine - 1; i < endLine; i++) total += (this.lines[i] as string).length;
		return total;
	}

	isBlank(line: number): boolean {
		return (this.lines[line - 1] ?? '').trim().length === 0;
	}
}
