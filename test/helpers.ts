import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Real path (macOS tmpdir is behind the /var → /private/var symlink, and sources are stored as real paths). */
/** Compiled output built once by test/global-setup.ts (never the shared dist/). */
export const DIST = join(import.meta.dirname, '..', 'dist-test');

export function tempDir(prefix: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), `codetrail-${prefix}-`)));
}

export function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' },
	}).trim();
}

export type FixtureFiles = Record<string, string | Buffer | { symlink: string }>;

export function writeFiles(dir: string, files: FixtureFiles): void {
	for (const [path, content] of Object.entries(files)) {
		const full = join(dir, path);
		mkdirSync(dirname(full), { recursive: true });
		if (typeof content === 'object' && !Buffer.isBuffer(content)) symlinkSync(content.symlink, full);
		else writeFileSync(full, content);
	}
}

/** Creates a git repo with one commit containing `files`; returns its path and HEAD sha. */
export function makeRepo(root: string, name: string, files: FixtureFiles): { dir: string; sha: string } {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	git(dir, 'init', '-q', '-b', 'main');
	writeFiles(dir, files);
	git(dir, 'add', '-A');
	git(dir, 'commit', '-q', '-m', 'fixture');
	return { dir, sha: git(dir, 'rev-parse', 'HEAD') };
}

export function commitFiles(dir: string, files: FixtureFiles, message = 'update'): string {
	writeFiles(dir, files);
	git(dir, 'add', '-A');
	git(dir, 'commit', '-q', '-m', message);
	return git(dir, 'rev-parse', 'HEAD');
}

/** Every byte under `dir`, concatenated — used to prove a canary never reached disk. */
export function readAllBytes(dir: string): Buffer {
	const parts: Buffer[] = [];
	const walk = (d: string): void => {
		for (const name of readdirSync(d)) {
			const full = join(d, name);
			const st = statSync(full);
			if (st.isDirectory()) walk(full);
			else parts.push(readFileSync(full));
		}
	};
	walk(dir);
	return Buffer.concat(parts);
}

/**
 * Canary secrets are assembled at runtime so the CodeTrail repository itself
 * never contains a literal credential-shaped string.
 */
export const CANARY = {
	awsKey: ['AKIA', 'Z7Q3', 'CANA', 'RY00', 'TEST'].join(''),
	githubToken: 'ghp' + '_' + 'Cn4ry'.repeat(8) + 'Zq9X',
	privateKeyHeader: ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' '),
	genericValue: 'q7' + 'Zr9Kx2Lm4Np8Vt' + 'W3',
};
