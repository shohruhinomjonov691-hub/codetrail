import { execFile, spawn } from 'node:child_process';
import { CodeTrailError } from './errors.js';

/**
 * Options applied to every git invocation.
 *
 * core.packedGitWindowSize=1m: on this machine `git archive` / large blob reads
 * from repos under ~/Desktop crash with SIGBUS (exit 138) while the objects
 * themselves are intact; a small mmap window avoids it (stage A audit).
 * core.hooksPath / fsmonitor: never execute anything configured by a repo.
 */
export const GIT_SAFE_CONFIG: readonly string[] = [
	'-c',
	'core.packedGitWindowSize=1m',
	'-c',
	'core.hooksPath=/dev/null',
	'-c',
	'core.fsmonitor=false',
	'-c',
	'protocol.ext.allow=never',
];

export function gitArgs(args: readonly string[], gitDir?: string): string[] {
	return [...GIT_SAFE_CONFIG, ...(gitDir ? ['--git-dir', gitDir] : []), ...args];
}

function gitEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_TERMINAL_PROMPT: '0',
		GIT_ASKPASS: '',
		SSH_ASKPASS: '',
		GIT_OPTIONAL_LOCKS: '0',
		LC_ALL: 'C',
	};
}

const MAX_BUFFER = 512 * 1024 * 1024;

/**
 * Reads from repos under ~/Desktop fail intermittently (SIGBUS in git or its
 * pack-objects child, "possible repository corruption") while an immediate
 * retry succeeds and `git fsck` is clean. Read-only operations are therefore
 * retried a bounded number of times.
 */
export const GIT_READ_ATTEMPTS = 3;

export async function withRetry<T>(attempts: number, op: () => Promise<T>, beforeRetry?: () => void): Promise<T> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await op();
		} catch (err) {
			lastError = err;
			if (attempt < attempts) beforeRetry?.();
		}
	}
	throw lastError;
}

/** Runs git without a shell, retrying read-only failures. stderr is never echoed into errors. */
export function runGit(args: readonly string[], opts: { gitDir?: string; cwd?: string; attempts?: number } = {}): Promise<Buffer> {
	return withRetry(opts.attempts ?? GIT_READ_ATTEMPTS, () => runGitOnce(args, opts));
}

function runGitOnce(args: readonly string[], opts: { gitDir?: string; cwd?: string }): Promise<Buffer> {
	return new Promise((resolvePromise, reject) => {
		execFile(
			'git',
			gitArgs(args, opts.gitDir),
			{ cwd: opts.cwd, env: gitEnv(), encoding: 'buffer', maxBuffer: MAX_BUFFER },
			(error, stdout) => {
				if (error) {
					const op = args.find((a) => !a.startsWith('-')) ?? 'git';
					reject(new CodeTrailError('GIT_FAILED', `git ${op} failed (exit ${String((error as { code?: unknown }).code ?? '?')})`));
					return;
				}
				resolvePromise(stdout);
			},
		);
	});
}

export async function runGitText(args: readonly string[], opts: { gitDir?: string; cwd?: string; attempts?: number } = {}): Promise<string> {
	return (await runGit(args, opts)).toString('utf8').trim();
}

/**
 * Streams object ids through one `git cat-file --batch` process and returns the
 * raw blob bytes keyed by oid.
 */
export function catFileBatch(gitDir: string, oids: readonly string[]): Promise<Map<string, Buffer>> {
	return withRetry(GIT_READ_ATTEMPTS, () => catFileBatchOnce(gitDir, oids));
}

function catFileBatchOnce(gitDir: string, oids: readonly string[]): Promise<Map<string, Buffer>> {
	return new Promise((resolvePromise, reject) => {
		const result = new Map<string, Buffer>();
		if (oids.length === 0) {
			resolvePromise(result);
			return;
		}
		const child = spawn('git', gitArgs(['cat-file', '--batch'], gitDir), { env: gitEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
		const chunks: Buffer[] = [];
		child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
		child.on('error', () => reject(new CodeTrailError('GIT_FAILED', 'git cat-file failed to start')));
		child.on('close', (code) => {
			if (code !== 0) {
				reject(new CodeTrailError('GIT_FAILED', `git cat-file failed (exit ${String(code)})`));
				return;
			}
			const out = Buffer.concat(chunks);
			let offset = 0;
			for (const expected of oids) {
				const headerEnd = out.indexOf(0x0a, offset);
				if (headerEnd < 0) {
					reject(new CodeTrailError('GIT_FAILED', 'git cat-file output truncated'));
					return;
				}
				const header = out.subarray(offset, headerEnd).toString('utf8').split(' ');
				if (header[1] === 'missing' || header[0] !== expected || header[1] !== 'blob') {
					reject(new CodeTrailError('GIT_FAILED', 'git cat-file returned an unexpected object'));
					return;
				}
				const size = Number(header[2]);
				const start = headerEnd + 1;
				result.set(expected, out.subarray(start, start + size));
				offset = start + size + 1; // trailing LF after content
			}
			resolvePromise(result);
		});
		child.stdin.end(oids.join('\n') + '\n');
	});
}
