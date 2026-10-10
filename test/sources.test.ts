import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodeTrailError } from '../src/errors.js';
import { assertId } from '../src/ids.js';
import { normalizeGithubUrl, resolveLocalSource } from '../src/sources.js';
import { makeRepo, tempDir } from './helpers.js';

const code = (fn: () => unknown): string | undefined => {
	try {
		fn();
		return undefined;
	} catch (err) {
		return err instanceof CodeTrailError ? err.code : 'OTHER';
	}
};

describe('GitHub URL validation', () => {
	it('accepts and canonicalizes plain repository URLs', () => {
		expect(normalizeGithubUrl('https://github.com/sindresorhus/ky')).toBe('https://github.com/sindresorhus/ky.git');
		expect(normalizeGithubUrl('https://github.com/a-b/c.d_e.git')).toBe('https://github.com/a-b/c.d_e.git');
		expect(normalizeGithubUrl('https://github.com/owner/repo/')).toBe('https://github.com/owner/repo.git');
	});

	it.each([
		'http://github.com/owner/repo',
		'https://gitlab.com/owner/repo',
		'https://github.com.evil.com/owner/repo',
		'https://user:pass@github.com/owner/repo',
		'https://token@github.com/owner/repo',
		'git@github.com:owner/repo.git',
		'ssh://git@github.com/owner/repo',
		'file:///etc/passwd',
		'https://github.com/owner/repo?x=1',
		'https://github.com/owner/repo#frag',
		'https://github.com/owner/repo/tree/main',
		'https://github.com:443/owner/repo',
		'https://github.com/owner/..',
		'https://github.com/owner/.hidden',
		'https://github.com/../etc',
		'https://github.com/owner/repo%2F..',
		' --upload-pack=evil',
		'https://github.com/owner',
	])('rejects %s', (url) => {
		expect(code(() => normalizeGithubUrl(url))).toBe('INVALID_GITHUB_URL');
	});
});

describe('local source validation', () => {
	const root = tempDir('roots');
	const allowed = join(root, 'allowed');
	const outside = join(root, 'outside');
	mkdirSync(allowed);
	mkdirSync(outside);
	const inRepo = makeRepo(allowed, 'repo', { 'a.ts': 'export const a = 1;\n' });
	const outRepo = makeRepo(outside, 'repo', { 'a.ts': 'export const a = 1;\n' });
	mkdirSync(join(allowed, 'plain'));
	symlinkSync(outRepo.dir, join(allowed, 'link-out'));

	it('accepts a repo inside a configured root', () => {
		expect(resolveLocalSource(inRepo.dir, [allowed])).toMatch(/allowed\/repo$/);
	});
	it('rejects repos outside the roots', () => {
		expect(code(() => resolveLocalSource(outRepo.dir, [allowed]))).toBe('LOCAL_PATH_OUTSIDE_ROOTS');
	});
	it('rejects a symlink inside the root that points outside', () => {
		expect(code(() => resolveLocalSource(join(allowed, 'link-out'), [allowed]))).toBe('LOCAL_PATH_OUTSIDE_ROOTS');
	});
	it('rejects ../ escapes', () => {
		expect(code(() => resolveLocalSource(`${allowed}/../outside/repo`, [allowed]))).toBe('LOCAL_PATH_OUTSIDE_ROOTS');
	});
	it('rejects relative paths, missing paths, non-repos and disabled roots', () => {
		expect(code(() => resolveLocalSource('relative/repo', [allowed]))).toBe('INVALID_LOCAL_PATH');
		expect(code(() => resolveLocalSource(join(allowed, 'missing'), [allowed]))).toBe('INVALID_LOCAL_PATH');
		expect(code(() => resolveLocalSource(join(allowed, 'plain'), [allowed]))).toBe('NOT_A_GIT_REPO');
		expect(code(() => resolveLocalSource(inRepo.dir, []))).toBe('LOCAL_PATH_OUTSIDE_ROOTS');
	});
	it('rejects a root prefix that is not a parent directory', () => {
		expect(code(() => resolveLocalSource(inRepo.dir, [join(root, 'allow')]))).toBe('LOCAL_PATH_OUTSIDE_ROOTS');
	});
});

describe('ids', () => {
	it.each(['gotrip', 'go-trip', 'a', 'x1'])('accepts %s', (id) => expect(assertId('project', id)).toBe(id));
	it.each(['', 'GoTrip', '-a', 'a-', '../x', 'a/b', 'a'.repeat(41), 'a_b'])('rejects %s', (id) => {
		expect(code(() => assertId('project', id))).toBe('INVALID_ID');
	});
});
