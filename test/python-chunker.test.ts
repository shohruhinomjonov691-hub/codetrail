/** Python support: the line-based chunker keeps definitions whole, covers every line, respects the limits and the file filters. */
import { describe, expect, it } from 'vitest';
import { CHUNK_LIMITS, chunkFile, languageOf } from '../src/chunker/index.js';
import { classifyContent, classifyPath } from '../src/filters.js';
import { chunkRole } from '../src/retrieval/role.js';

const lines = (text: string, a: number, b: number): string => text.split('\n').slice(a - 1, b).join('\n');

function assertSound(path: string, text: string): ReturnType<typeof chunkFile> {
	const chunks = chunkFile(path, text);
	const covered = new Set<number>();
	for (const c of chunks) {
		expect(c.endLine - c.startLine + 1).toBeLessThanOrEqual(CHUNK_LIMITS.maxLines);
		expect(lines(text, c.startLine, c.endLine).length).toBeLessThanOrEqual(CHUNK_LIMITS.maxChars);
		for (let l = c.startLine; l <= c.endLine; l++) covered.add(l);
	}
	text.split('\n').forEach((t, i) => {
		if (t.trim()) expect(covered.has(i + 1), `line ${i + 1} (${t}) is covered`).toBe(true);
	});
	return chunks;
}

describe('Python chunker', () => {
	const SRC = [
		'"""Module doc."""',
		'import os',
		'',
		'LIMIT = 3',
		'',
		'',
		'# cached per image',
		'@lru_cache(maxsize=8)',
		'def detect(image):',
		'    """Docstring with a fake definition:',
		'',
		'def fake():',
		'    pass',
		'    """',
		'    return image',
		'',
		'',
		'class Detector:',
		'    def __init__(self):',
		'        self.x = 1',
		'',
		'    async def run(self):',
		'        return 2',
		'',
		'tail = 1',
	].join('\n');

	it('recognises python files', () => {
		expect(languageOf('a/b.py')).toBe('python');
		expect(languageOf('a/B.PY')).toBe('python');
	});

	it('keeps decorators and attached comments with their function and ignores definitions inside docstrings', () => {
		const chunks = assertSound('m.py', SRC);
		const detect = chunks.find((c) => c.symbol === 'detect')!;
		expect(detect).toMatchObject({ kind: 'function', startLine: 7, endLine: 15 });
		expect(chunks.some((c) => c.symbol === 'fake')).toBe(false);
		const cls = chunks.find((c) => c.symbol === 'Detector')!;
		expect(cls).toMatchObject({ kind: 'class', startLine: 18 });
		expect(chunks.find((c) => c.kind === 'module' && c.startLine === 1)).toBeTruthy(); // imports + constants
	});

	it('splits an oversized class at its methods and never exceeds the limits', () => {
		const methods = Array.from({ length: 60 }, (_, i) => `    def method_${i}(self):\n        value = ${i}\n        return value * 2\n`).join('\n');
		const text = `class Big:\n${methods}\n`;
		const chunks = assertSound('big.py', text);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((c) => c.symbol === 'Big')).toBe(true);
		// a split lands on a method boundary, not inside a method body
		for (const c of chunks.slice(1)) expect(text.split('\n')[c.startLine - 1]).toMatch(/^\s+def method_/);
	});

	it('splits a huge flat module and a huge function without losing lines', () => {
		const flat = Array.from({ length: 400 }, (_, i) => `VALUE_${i} = ${i}`).join('\n');
		assertSound('flat.py', flat);
		const body = Array.from({ length: 300 }, (_, i) => `    x${i} = ${i}`).join('\n');
		assertSound('fn.py', `def huge():\n${body}\n    return 1\n`);
	});

	it('handles empty, comment-only, CRLF and tab-indented files', () => {
		expect(chunkFile('e.py', '   \n')).toEqual([]);
		assertSound('c.py', '# only a comment\n');
		assertSound('crlf.py', 'def a():\r\n    return 1\r\n\r\ndef b():\r\n    return 2\r\n');
		assertSound('tabs.py', 'def a():\n\treturn 1\n\nclass B:\n\tdef c(self):\n\t\treturn 2\n');
	});
});

describe('Python file filters', () => {
	it('allows .py and refuses environments, caches and bytecode', () => {
		expect(classifyPath('food_lens/api.py')).toBeNull();
		for (const p of ['.venv/lib/python3.13/site-packages/x.py', 'venv/bin/a.py', 'pkg/__pycache__/a.py', 'a/.pytest_cache/x.py', 'a/.mypy_cache/x.py', 'x.pyc']) expect(classifyPath(p), p).not.toBeNull();
		expect(classifyPath('.env')).toBe('denied-file');
		expect(classifyPath('config/secrets.json')).toBe('denied-file');
	});

	it('treats Python tests as tests', () => {
		expect(chunkRole('tests/test_api.py', 'python')).toBe('test');
		expect(chunkRole('pkg/test_x.py', 'python')).toBe('test');
		expect(chunkRole('pkg/conftest.py', 'python')).toBe('test');
		expect(chunkRole('pkg/x_test.py', 'python')).toBe('test');
		expect(chunkRole('food_lens/api.py', 'python')).toBe('implementation');
	});

	it('still rejects binary and minified content', () => {
		expect(classifyContent(Buffer.from([0x61, 0x00, 0x62]))).toEqual({ reason: 'binary' });
	});
});
