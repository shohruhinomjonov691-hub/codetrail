import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitArgs, gitEnv } from '../git.js';
import type { HealthTarget, LogTarget } from './config.js';
import { brief } from './redact.js';

const execFileAsync = promisify(execFile);

export type CheckSource = 'Health Check' | 'Repo / Log Check';
export type Severity = 'ok' | 'warning' | 'critical';

/** One check outcome. Every text field is already redacted and short. */
export interface CheckResult {
	project_id: string;
	source: CheckSource;
	/** Target name from the config (e.g. "site", "app-log", "repo"). */
	check: string;
	severity: Severity;
	/** Stable failure class used for dedup (e.g. http-502, timeout, log:ERROR:<hash>); empty when ok. */
	fingerprint: string;
	summary: string;
	/** Redacted facts for the root-cause step. */
	facts: {
		url?: string;
		status?: number;
		latency_ms?: number;
		error_class?: 'timeout' | 'refused' | 'dns' | 'tls' | 'network' | 'http';
		log_lines?: string[];
		repo_path?: string;
	};
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function errorClass(err: unknown): NonNullable<CheckResult['facts']['error_class']> {
	const e = err as { name?: string; cause?: { code?: string; message?: string }; message?: string };
	const code = e.cause?.code ?? '';
	const msg = `${code} ${e.cause?.message ?? ''} ${e.message ?? ''}`;
	if (e.name === 'TimeoutError' || e.name === 'AbortError' || /ETIMEDOUT|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT/.test(msg)) return 'timeout';
	if (/ECONNREFUSED/.test(msg)) return 'refused';
	if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return 'dns';
	if (/CERT|TLS|SSL|ERR_TLS|UNABLE_TO_VERIFY/i.test(msg)) return 'tls';
	return 'network';
}

/**
 * One health target. A failure is retried (`retries`, 1.5 s apart) before it is reported, so a
 * single dropped request does not alert. Healthy = the expected status (default any 2xx/3xx) in
 * time; slower than `slow_ms` is a Warning; 5xx, a refused/timed-out/unresolvable connection or a
 * TLS failure is Critical / Down; any other unexpected status is a Warning.
 */
export async function healthCheck(projectId: string, t: HealthTarget, fetchImpl: typeof fetch = fetch, retryDelayMs = 1500): Promise<CheckResult> {
	const base = { project_id: projectId, source: 'Health Check' as const, check: t.name };
	let last: CheckResult | null = null;
	for (let attempt = 0; attempt <= t.retries; attempt++) {
		if (attempt > 0) await sleep(retryDelayMs);
		const started = Date.now();
		try {
			const res = await fetchImpl(t.url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(t.timeout_ms), headers: { 'User-Agent': 'codetrail-monitor', Accept: '*/*' } });
			const latency = Date.now() - started;
			void res.body?.cancel().catch(() => {});
			const ok = t.expect_status ? res.status === t.expect_status : res.status >= 200 && res.status < 400;
			const facts = { url: t.url, status: res.status, latency_ms: latency, error_class: 'http' as const };
			if (ok) {
				if (latency > t.slow_ms) return { ...base, severity: 'warning', fingerprint: 'slow', summary: `${t.name}: slow response (${latency} ms, limit ${t.slow_ms} ms)`, facts };
				return { ...base, severity: 'ok', fingerprint: '', summary: `${t.name}: HTTP ${res.status} in ${latency} ms`, facts };
			}
			last = { ...base, severity: res.status >= 500 ? 'critical' : 'warning', fingerprint: `http-${res.status}`, summary: `${t.name}: HTTP ${res.status}${t.expect_status ? ` (expected ${t.expect_status})` : ''}`, facts };
		} catch (err) {
			const cls = errorClass(err);
			const latency = Date.now() - started;
			last = { ...base, severity: 'critical', fingerprint: cls, summary: `${t.name}: ${cls === 'timeout' ? `no answer within ${t.timeout_ms} ms` : cls === 'refused' ? 'connection refused' : cls === 'dns' ? 'domain does not resolve' : cls === 'tls' ? 'TLS/certificate error' : 'network error'}`, facts: { url: t.url, latency_ms: latency, error_class: cls } };
		}
	}
	return last as CheckResult;
}

// ---------------------------------------------------------------- logs

const FATAL = /\b(FATAL|panic:|out of memory|OOMKilled|segmentation fault|Unhandled(?:Promise)?Rejection|uncaught exception)\b/i;
const ERROR = /\b(ERROR|CRITICAL|Traceback \(most recent call last\)|Exception|ECONNREFUSED|EADDRINUSE|ETIMEDOUT|ENOSPC|EACCES)\b/;
const BENIGN = /\b(0 errors?|no errors?|errors?[:=] ?0|error_count[:=] ?0)\b/i;

/** Where a log scan stopped, so the next run reads only new bytes. */
export interface LogCursor {
	size: number;
	ino: number;
}

const MAX_READ = 64 * 1024;

/** Reads up to MAX_READ bytes of `path` starting at `from` (the tail when the range is larger). */
function readRange(path: string, from: number): { text: string; size: number; ino: number; mtimeMs: number } | null {
	let fd: number | null = null;
	try {
		fd = openSync(path, 'r');
		const st = fstatSync(fd);
		if (!st.isFile()) return null;
		const start = Math.max(from, st.size - MAX_READ, 0);
		const buf = Buffer.alloc(Math.max(0, st.size - start));
		if (buf.length) readSync(fd, buf, 0, buf.length, start);
		return { text: buf.toString('utf8'), size: st.size, ino: st.ino, mtimeMs: st.mtimeMs };
	} catch {
		return null;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

function hash(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
	return h.toString(36);
}

/**
 * Scans only the bytes written since `cursor` (first run: the last 64 KB, if the file was modified
 * within `max_age_minutes`). Lines with FATAL-class markers make it Critical, other error markers
 * a Warning. A missing or unreadable log file is a Warning. Returns the new cursor.
 */
export function logCheck(projectId: string, t: LogTarget, cursor: LogCursor | null, now = Date.now()): { result: CheckResult; cursor: LogCursor | null } {
	const base = { project_id: projectId, source: 'Repo / Log Check' as const, check: t.name };
	if (!existsSync(t.path)) return { result: { ...base, severity: 'warning', fingerprint: 'log-missing', summary: `${t.name}: log file not found`, facts: {} }, cursor };
	const sameFile = cursor && (() => { try { const st = statSync(t.path); return st.ino === cursor.ino && st.size >= cursor.size; } catch { return false; } })();
	const read = readRange(t.path, sameFile && cursor ? cursor.size : 0);
	if (!read) return { result: { ...base, severity: 'warning', fingerprint: 'log-unreadable', summary: `${t.name}: log file is not readable`, facts: {} }, cursor };
	const next: LogCursor = { size: read.size, ino: read.ino };
	const stale = !sameFile && now - read.mtimeMs > t.max_age_minutes * 60_000;
	if (stale) return { result: { ...base, severity: 'ok', fingerprint: '', summary: `${t.name}: no recent log activity`, facts: {} }, cursor: next };
	const lines = read.text.split('\n').filter((l) => l.trim() && !BENIGN.test(l));
	const fatal = lines.filter((l) => FATAL.test(l));
	const errors = lines.filter((l) => fatal.includes(l) || ERROR.test(l));
	if (errors.length === 0) return { result: { ...base, severity: 'ok', fingerprint: '', summary: `${t.name}: no new errors`, facts: {} }, cursor: next };
	const shown = (fatal.length ? fatal : errors).slice(-5).map((l) => brief(l, 220));
	// Fingerprint = the first error line without digits/hex noise, so the same error repeating does not look new.
	const key = brief((fatal[0] ?? errors[0]) as string, 160).replace(/[0-9a-f]{6,}|\d+/gi, '#');
	return {
		result: { ...base, severity: fatal.length ? 'critical' : 'warning', fingerprint: `log:${fatal.length ? 'FATAL' : 'ERROR'}:${hash(key)}`, summary: `${t.name}: ${errors.length} error line(s)${fatal.length ? `, ${fatal.length} fatal` : ''} in new log output`, facts: { log_lines: shown } },
		cursor: next,
	};
}

// ---------------------------------------------------------------- repo

async function git(repo: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync('git', gitArgs(args), { cwd: repo, env: gitEnv(), timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
	return stdout.trim();
}

/** The repository must exist and have a resolvable HEAD; otherwise Warning. Read-only (rev-parse). */
export async function repoCheck(projectId: string, repoPath: string): Promise<CheckResult> {
	const base = { project_id: projectId, source: 'Repo / Log Check' as const, check: 'repo', facts: { repo_path: brief(repoPath, 120) } };
	if (!existsSync(repoPath)) return { ...base, severity: 'warning', fingerprint: 'repo-missing', summary: 'repo: directory not found' };
	try {
		await git(repoPath, ['rev-parse', '--verify', 'HEAD']);
		return { ...base, severity: 'ok', fingerprint: '', summary: 'repo: HEAD resolves' };
	} catch {
		return { ...base, severity: 'warning', fingerprint: 'repo-unreadable', summary: 'repo: not a readable git repository' };
	}
}

export interface RecentCommit {
	hash: string;
	when: string;
	subject: string;
	files: string[];
}

/** Last commits (read-only `git log`), subjects redacted. Returns [] when the repo cannot be read. */
export async function recentCommits(repoPath: string, sinceHours = 72, max = 5): Promise<RecentCommit[]> {
	try {
		const out = await git(repoPath, ['log', `-n${max}`, `--since=${sinceHours}.hours.ago`, '--no-merges', '--name-only', '--format=%x01%h%x02%cI%x02%s']);
		return out
			.split('\u0001')
			.filter(Boolean)
			.map((block) => {
				const [head = '', ...files] = block.split('\n');
				const [h = '', when = '', subject = ''] = head.split('\u0002');
				return { hash: h, when, subject: brief(subject, 100), files: files.map((f) => f.trim()).filter((f) => f && !/(^|\/)\.env/.test(f)).slice(0, 30) };
			});
	} catch {
		return [];
	}
}
