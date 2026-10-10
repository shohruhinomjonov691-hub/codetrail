import { describe, expect, it } from 'vitest';
import { classifyContent, classifyPath, FILTER_LIMITS, globToRegExp } from '../src/filters.js';
import { isSafeRepoPath } from '../src/paths.js';

describe('repo path safety', () => {
	it.each(['src/a.ts', 'a.ts', 'deep/er/x.tsx', '.github/workflows/ci.yml'])('accepts %s', (p) => expect(isSafeRepoPath(p)).toBe(true));
	it.each(['', '/etc/passwd', '../x.ts', 'a/../b.ts', 'a/./b.ts', 'a//b.ts', 'a\\b.ts', 'C:/x.ts', 'a\u0000b.ts', 'a\nb.ts', 'a/'])(
		'rejects %j',
		(p) => expect(isSafeRepoPath(p)).toBe(false),
	);
});

describe('path classification', () => {
	it.each([
		['src/app.ts', null],
		['pages/index.tsx', null],
		['README.md', null],
		['schema.graphql', null],
		['docker-compose.yml', null],
		['.env', 'denied-file'],
		['.env.local', 'denied-file'],
		['config/.env.example', 'denied-file'],
		['node_modules/x/index.js', 'denied-dir'],
		['packages/a/node_modules/b.js', 'denied-dir'],
		['dist/main.js', 'denied-dir'],
		['.next/server.js', 'denied-dir'],
		['uploads/a.json', 'denied-dir'],
		['.agents/skills/x/SKILL.md', 'denied-dir'],
		['.claude/settings.local.json', 'denied-dir'],
		['package-lock.json', 'denied-file'],
		['yarn.lock', 'denied-file'],
		['pnpm-lock.yaml', 'denied-file'],
		['certs/server.pem', 'denied-file'],
		['keys/id_rsa', 'denied-file'],
		['config/secrets.json', 'denied-file'],
		['credentials.json', 'denied-file'],
		['public/app.min.js', 'denied-file'],
		['types/global.d.ts', 'denied-file'],
		['img/logo.png', 'extension'],
		['public/img/banner.svg', 'extension'],
		['a/../b.ts', 'unsafe-path'],
	])('%s → %s', (path, reason) => expect(classifyPath(path)).toBe(reason));

	it('applies project exclude globs', () => {
		const ex = [globToRegExp('**/*.spec.ts'), globToRegExp('scripts/**')];
		expect(classifyPath('src/a.spec.ts', ex)).toBe('project-exclude');
		expect(classifyPath('a.spec.ts', ex)).toBe('project-exclude');
		expect(classifyPath('scripts/x/y.ts', ex)).toBe('project-exclude');
		expect(classifyPath('src/a.ts', ex)).toBeNull();
	});
});

describe('content classification', () => {
	it('accepts normal UTF-8 text', () => {
		expect(classifyContent(Buffer.from('export const a = 1;\n'))).toEqual({ text: 'export const a = 1;\n' });
	});
	it('rejects binary, invalid UTF-8, oversized, long-line and minified content', () => {
		expect(classifyContent(Buffer.from([0x61, 0x00, 0x62]))).toEqual({ reason: 'binary' });
		expect(classifyContent(Buffer.from([0xc3, 0x28]))).toEqual({ reason: 'not-utf8' });
		expect(classifyContent(Buffer.alloc(FILTER_LIMITS.maxFileBytes + 1, 0x61))).toEqual({ reason: 'too-large' });
		expect(classifyContent(Buffer.from('a'.repeat(FILTER_LIMITS.maxLineChars + 1)))).toEqual({ reason: 'long-line' });
		expect(classifyContent(Buffer.from(('x'.repeat(400) + '\n').repeat(5)))).toEqual({ reason: 'minified' });
	});
});
