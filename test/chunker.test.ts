import { describe, expect, it } from 'vitest';
import { chunkFile, CHUNK_LIMITS, LineIndex, type RawChunk } from '../src/chunker/index.js';

/** Invariants every chunking result must satisfy. */
function assertInvariants(path: string, text: string, chunks: RawChunk[]): void {
	const idx = new LineIndex(text);
	let lastEnd = 0;
	for (const c of chunks) {
		expect(c.startLine).toBeGreaterThan(lastEnd); // ordered, non-overlapping
		expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
		expect(c.endLine).toBeLessThanOrEqual(idx.count);
		const slice = idx.slice(c.startLine, c.endLine);
		expect(c.endLine - c.startLine + 1).toBeLessThanOrEqual(CHUNK_LIMITS.maxLines);
		expect(slice.length).toBeLessThanOrEqual(CHUNK_LIMITS.maxChars);
		expect(slice.trim().length).toBeGreaterThan(0);
		lastEnd = c.endLine;
	}
	expect(chunks.length, path).toBeGreaterThan(0);
}

const NEST_RESOLVER = `import { Resolver, Mutation, UseGuards } from '@nestjs/graphql';
import { AuthGuard } from './auth.guard';

/** Tour operations. */
@Resolver()
export class TourResolver {
	constructor(private readonly tourService: TourService) {}

	@Roles(MemberType.AGENT)
	@UseGuards(RolesGuard)
	@Mutation(() => Tour)
	public async createTour(@Args('input') input: TourInput): Promise<Tour> {
		return await this.tourService.createTour(input);
	}
}
`;

describe('TypeScript chunking', () => {
	it('keeps decorators and doc comments inside the class chunk', () => {
		const chunks = chunkFile('tour.resolver.ts', NEST_RESOLVER);
		assertInvariants('tour.resolver.ts', NEST_RESOLVER, chunks);
		const cls = chunks.find((c) => c.kind === 'class');
		expect(cls?.symbol).toBe('TourResolver');
		expect(cls?.startLine).toBe(4); // the /** Tour operations. */ line, before @Resolver()
		expect(cls?.endLine).toBe(15);
		expect(chunks[0]?.kind).toBe('module'); // imports packed together
	});

	it('names functions, arrow components, types and enums', () => {
		const text = [
			"import React from 'react';",
			'',
			'export enum Role {',
			"\tUSER = 'USER',",
			"\tAGENT = 'AGENT',",
			"\tADMIN = 'ADMIN',",
			"\tGUEST = 'GUEST',",
			"\tBOT = 'BOT',",
			'}',
			'',
			'export interface Props {',
			'\ttitle: string;',
			'\tcount: number;',
			'\tonClick(): void;',
			'\tdisabled?: boolean;',
			'\tlabel?: string;',
			'}',
			'',
			'export const Card = ({ title }: Props) => {',
			'\tconst x = 1;',
			'\treturn <div className="card">{title}</div>;',
			'};',
			'',
			'export default function Page() {',
			'\treturn <Card title="a" count={1} onClick={() => {}} />;',
			'}',
			'',
		].join('\n');
		const chunks = chunkFile('Card.tsx', text);
		assertInvariants('Card.tsx', text, chunks);
		const byKind = chunks.map((c) => `${c.kind}:${c.symbol}`);
		expect(byKind).toContain('enum:Role');
		expect(byKind).toContain('type:Props');
		expect(byKind).toContain('function:Card');
		expect(byKind).toContain('function:Page');
	});

	it('splits an oversized function into parts that all respect the limits', () => {
		const body = Array.from({ length: 700 }, (_, i) => `\tconst v${i} = compute(${i}); if (v${i} > 10) { log(v${i}); }`).join('\n');
		const text = `export function huge() {\n${body}\n\treturn 0;\n}\n`;
		const chunks = chunkFile('huge.ts', text);
		assertInvariants('huge.ts', text, chunks);
		expect(chunks.length).toBeGreaterThan(5);
		expect(chunks.every((c) => c.symbol === 'huge' && c.kind === 'function')).toBe(true);
		expect(chunks.map((c) => c.part?.index)).toEqual(chunks.map((_, i) => i + 1));
		// coverage: every non-blank line of the function lands in some chunk
		const covered = new Set(chunks.flatMap((c) => Array.from({ length: c.endLine - c.startLine + 1 }, (_, k) => c.startLine + k)));
		const idx = new LineIndex(text);
		for (let line = 1; line <= idx.count; line++) if (!idx.isBlank(line)) expect(covered.has(line)).toBe(true);
	});

	it('splits an oversized class into header and per-method chunks', () => {
		const methods = Array.from(
			{ length: 12 },
			(_, m) => `\t@Get()\n\tpublic async m${m}(): Promise<number> {\n${Array.from({ length: 15 }, (_, i) => `\t\tconst a${i} = ${i};`).join('\n')}\n\t\treturn 1;\n\t}`,
		).join('\n\n');
		const text = `@Controller()\nexport class Big {\n\tprivate readonly x = 1;\n\n${methods}\n}\n`;
		const chunks = chunkFile('big.ts', text);
		assertInvariants('big.ts', text, chunks);
		const methodChunks = chunks.filter((c) => c.kind === 'method');
		expect(methodChunks.map((c) => c.symbol)).toEqual(Array.from({ length: 12 }, (_, m) => `Big.m${m}`));
		const idx = new LineIndex(text);
		for (const c of methodChunks) expect(idx.lines[c.startLine - 1]?.trim()).toBe('@Get()'); // decorator included
		expect(chunks[0]?.kind).toBe('class');
		expect(idx.slice(chunks[0]!.startLine, chunks[0]!.endLine)).toContain('@Controller()');
	});

	it('handles a very long JSX return and huge gql template within limits', () => {
		const jsx = `export const Page = () => {\n\treturn (\n\t\t<div>\n${Array.from({ length: 400 }, (_, i) => `\t\t\t<span key="${i}">{t('label ${i}')}</span>`).join('\n')}\n\t\t</div>\n\t);\n};\n`;
		assertInvariants('Page.tsx', jsx, chunkFile('Page.tsx', jsx));
		const gql = `export const Q = gql\`\n${Array.from({ length: 500 }, (_, i) => `\tfield${i}`).join('\n')}\n\`;\n`;
		assertInvariants('query.ts', gql, chunkFile('query.ts', gql));
	});

	it('preserves CRLF text exactly and survives syntax errors', () => {
		const crlf = 'export function a() {\r\n\treturn 1;\r\n}\r\n\r\nexport function b() {\r\n\treturn 2;\r\n}\r\n';
		const chunks = chunkFile('crlf.ts', crlf);
		assertInvariants('crlf.ts', crlf, chunks);
		expect(new LineIndex(crlf).slice(chunks[0]!.startLine, chunks[0]!.endLine)).toBe('export function a() {\r\n\treturn 1;\r\n}\r');
		const broken = 'export function x( {\n  return ;\n}}}\nconst = ;\n';
		assertInvariants('broken.ts', broken, chunkFile('broken.ts', broken));
	});

	it('handles two statements on one line without overlapping ranges', () => {
		const text = 'const a = 1; const b = 2;\nfunction f() { return a + b; } function g() { return 1; }\n';
		assertInvariants('same-line.js', text, chunkFile('same-line.js', text));
	});

	it('is deterministic', () => {
		expect(chunkFile('tour.resolver.ts', NEST_RESOLVER)).toEqual(chunkFile('tour.resolver.ts', NEST_RESOLVER));
	});
});

describe('text chunking', () => {
	it('splits markdown at headings and labels sections', () => {
		const sections = Array.from({ length: 8 }, (_, s) => `## Section ${s}\n\n${Array.from({ length: 30 }, (_, i) => `Line ${i} of section ${s}.`).join('\n')}\n`).join('\n');
		const text = `# Title\n\nIntro.\n\n${sections}`;
		const chunks = chunkFile('README.md', text);
		assertInvariants('README.md', text, chunks);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.slice(1).every((c) => /^Section \d$/.test(c.symbol ?? ''))).toBe(true);
	});

	it('does not treat # inside code fences as headings', () => {
		const text = '# Real\n\n```bash\n# not a heading\n```\n';
		expect(chunkFile('a.md', text).map((c) => c.symbol)).toEqual(['Real']);
	});

	it('keeps small JSON whole and splits large JSON within limits', () => {
		const small = '{\n  "name": "x"\n}\n';
		expect(chunkFile('package.json', small)).toEqual([{ kind: 'config', symbol: null, startLine: 1, endLine: 3, part: null }]);
		const big = `{\n${Array.from({ length: 900 }, (_, i) => `  "key${i}": "value ${i}",`).join('\n')}\n  "end": 1\n}\n`;
		assertInvariants('big.json', big, chunkFile('big.json', big));
	});

	it('returns no chunks for empty files', () => {
		expect(chunkFile('empty.ts', '\n\n  \n')).toEqual([]);
	});
});

describe('TypeScript edge coverage', () => {
	it('keeps trailing comment blocks and comment-only files', () => {
		const text = 'export const a = 1;\n\n/*\nold code:\nconst b = 2;\n*/\n// end\n';
		const chunks = chunkFile('tail.ts', text);
		assertInvariants('tail.ts', text, chunks);
		expect(chunks.at(-1)?.endLine).toBe(7);
		const onlyComments = '// just a note\n/* and a block */\n';
		expect(chunkFile('note.ts', onlyComments).map((c) => [c.startLine, c.endLine])).toEqual([[1, 2]]);
	});

	it('labels top-level test calls', () => {
		const text = `describe('AuthGuard', () => {\n${Array.from({ length: 10 }, (_, i) => `\tit('case ${i}', () => {});`).join('\n')}\n});\n`;
		expect(chunkFile('a.spec.ts', text)[0]?.symbol).toBe('describe("AuthGuard")');
	});
});

describe('tiny leftovers', () => {
	it('attaches a trailing export default to the preceding component chunk', () => {
		const text = `const Page = () => {\n${Array.from({ length: 8 }, (_, i) => `\tconst v${i} = ${i};`).join('\n')}\n\treturn null;\n};\n\nexport default Page;\n`;
		const chunks = chunkFile('Page.tsx', text);
		assertInvariants('Page.tsx', text, chunks);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toMatchObject({ kind: 'function', symbol: 'Page', startLine: 1, endLine: 13 });
	});
});
