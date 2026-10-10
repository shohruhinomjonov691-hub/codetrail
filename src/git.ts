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
 * retry succeeds and `git fsck` is clean. Only failures that match these known
 * transient signatures are retried, with bounded exponential backoff; anything
 * else (permission denied, missing repo, bad ref, spawn errors) runs once.
 */
export const GIT_READ_ATTEMPTS = 3;
export const GIT_RETRY_BASE_MS = 200;

const TRANSIENT_SIGNALS = new Set(['SIGBUS', 'SIGSEGV']);
const TRANSIENT_EXIT_CODES = new Set([135, 138, 139]); // 128 + SIGBUS/SIGSEGV as reported through a shell
const TRANSIENT_STDERR: readonly RegExp[] = [
	/pack-objects died/i,
	/possible repository corruption on the remote side/i,
	/early EOF/i,
	/index-pack failed|invalid index-pack output/i,
	/the remote end hung up unexpectedly/i,
	/RPC failed/i,
	/Connection (reset|timed out)/i,
	/Operation timed out/i,
	/Could not resolve host/i,
];

/** Failure evidence kept on the error object. stderr itself is never stored or printed. */
export interface GitFailure {
	exitCode: number | null;
	signal: string | null;
	transient: boolean;
	attempts: number;
}

export class GitError extends CodeTrailError {
	readonly failure: GitFailure;

	constructor(op: string, failure: GitFailure) {
		const how = failure.signal ? `signal ${failure.signal}` : `exit ${String(failure.exitCode)}`;
		super('GIT_FAILED', `git ${op} failed (${how}, ${failure.transient ? 'transient' : 'permanent'}, attempts ${failure.attempts})`);
		this.failure = failure;
	}
}

export function isTransientGitFailure(exitCode: number | null, signal: string | null, stderr: string): boolean {
	if (signal && TRANSIENT_SIGNALS.has(signal)) return true;
	if (exitCode !== null && TRANSIENT_EXIT_CODES.has(exitCode)) return true;
	return TRANSIENT_STDERR.some((re) => re.test(stderr));
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Runs `op` up to `attempts` times. Retries only when `retryable(err)` is true,
 * waiting GIT_RETRY_BASE_MS * 2^(n-1) between attempts; calls `beforeRetry` first.
 */
export async function withRetry<T>(
	attempts: number,
	op: (attempt: number) => Promise<T>,
	opts: { retryable?: (err: unknown) => boolean; beforeRetry?: () => void; baseMs?: number } = {},
): Promise<T> {
	const retryable = opts.retryable ?? ((err) => err instanceof GitError && err.failure.transient);
	for (let attempt = 1; ; attempt++) {
		try {
			return await op(attempt);
		} catch (err) {
			if (attempt >= attempts || !retryable(err)) throw err;
			opts.beforeRetry?.();
			await sleep((opts.baseMs ?? GIT_RETRY_BASE_MS) * 2 ** (attempt - 1));
		}
	}
}

function opName(args: readonly string[]): string {
	return args.find((a) => !a.startsWith('-')) ?? 'git';
}

/** Runs git without a shell, retrying only known transient failures. */
export function runGit(args: readonly string[], opts: { gitDir?: string; cwd?: string; attempts?: number } = {}): Promise<Buffer> {
	return withRetry(opts.attempts ?? GIT_READ_ATTEMPTS, (attempt) => runGitOnce(args, opts, attempt));
}

function runGitOnce(args: readonly string[], opts: { gitDir?: string; cwd?: string }, attempt: number): Promise<Buffer> {
	return new Promise((resolvePromise, reject) => {
		execFile(
			'git',
			gitArgs(args, opts.gitDir),
			{ cwd: opts.cwd, env: gitEnv(), encoding: 'buffer', maxBuffer: MAX_BUFFER },
			(error, stdout, stderr) => {
				if (error) {
					const e = error as NodeJS.ErrnoException & { code?: unknown; signal?: NodeJS.Signals | null };
					const exitCode = typeof e.code === 'number' ? e.code : null;
					const signal = e.signal ?? null;
					reject(new GitError(opName(args), { exitCode, signal, transient: isTransientGitFailure(exitCode, signal, stderr.toString('utf8')), attempts: attempt }));
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
	return withRetry(GIT_READ_ATTEMPTS, (attempt) => catFileBatchOnce(gitDir, oids, attempt));
}

function catFileBatchOnce(gitDir: string, oids: readonly string[], attempt: number): Promise<Map<string, Buffer>> {
	return new Promise((resolvePromise, reject) => {
		const result = new Map<string, Buffer>();
		if (oids.length === 0) {
			resolvePromise(result);
			return;
		}
		const child = spawn('git', gitArgs(['cat-file', '--batch'], gitDir), { env: gitEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
		const chunks: Buffer[] = [];
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
		child.stderr.on('data', (chunk: Buffer) => {
			if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
		});
		child.stdin.on('error', () => undefined); // EPIPE if git dies early; reported via 'close'
		child.on('error', () => reject(new GitError('cat-file', { exitCode: null, signal: null, transient: false, attempts: attempt })));
		child.on('close', (code, signal) => {
			if (code !== 0) {
				reject(new GitError('cat-file', { exitCode: code, signal, transient: isTransientGitFailure(code, signal, stderr), attempts: attempt }));
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
