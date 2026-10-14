import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { CodeTrailError } from './errors.js';
import { DatabaseSync, type Database } from './sqlite.js';

/**
 * Cross-process lock backed by an OS file lock: an open `BEGIN EXCLUSIVE`
 * transaction on a per-lock SQLite file (SQLite uses POSIX fcntl locks and
 * tracks same-process connections, so it also excludes other code paths in
 * this process).
 *
 * Rules:
 * - Acquire: try `BEGIN EXCLUSIVE` with busy_timeout 0; on SQLITE_BUSY wait with
 *   bounded backoff. A monotonic deadline is checked before every retry, so
 *   LOCK_TIMEOUT always fires and no lock is granted after the deadline.
 * - No stale breaking by age or pid: a live holder — even a paused one — keeps
 *   the lock. If the holder process dies, the OS releases the lock immediately.
 *   (The previous link/guard protocol could hand the lock to two owners.)
 * - Release: ROLLBACK + close in `finally`.
 * - `<name>.owner.json` is written while held for diagnostics only; it never
 *   decides ownership.
 * - Scope: one host, local filesystem (fcntl over network filesystems is not supported).
 */
export interface LockOptions {
	timeoutMs: number;
}

export const LOCK_DEFAULTS = {
	registry: { timeoutMs: 10_000 },
	snapshot: { timeoutMs: 10 * 60_000 },
} as const satisfies Record<string, LockOptions>;

const MAX_BACKOFF_MS = 250;

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

function open(locksDir: string, name: string): { db: Database; ownerFile: string } {
	if (!/^[a-z0-9][a-z0-9.-]{0,120}$/.test(name)) throw new CodeTrailError('USAGE', 'invalid lock name');
	mkdirSync(locksDir, { recursive: true });
	const db = new DatabaseSync(join(locksDir, `${name}.lock.sqlite`));
	db.exec('PRAGMA busy_timeout = 0');
	return { db, ownerFile: join(locksDir, `${name}.owner.json`) };
}

function isBusy(err: unknown): boolean {
	const e = err as { errcode?: number; message?: string };
	return e.errcode === 5 || e.errcode === 6 || /database is locked|database table is locked|SQLITE_BUSY/i.test(e.message ?? '');
}

function tryAcquire(db: Database): boolean {
	try {
		db.exec('BEGIN EXCLUSIVE');
		return true;
	} catch (err) {
		if (isBusy(err)) return false;
		throw err;
	}
}

function holderHint(ownerFile: string): string {
	try {
		const o = JSON.parse(readFileSync(ownerFile, 'utf8')) as { pid?: number; host?: string };
		return ` (last holder pid ${o.pid ?? '?'} on ${o.host ?? '?'})`;
	} catch {
		return '';
	}
}

function timeoutError(name: string, ownerFile: string): CodeTrailError {
	return new CodeTrailError('LOCK_TIMEOUT', `Timed out waiting for lock ${name}${holderHint(ownerFile)}`);
}

function markHeld(ownerFile: string): void {
	try {
		writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, host: hostname(), since: new Date().toISOString() }));
	} catch {
		/* diagnostics only */
	}
}

function release(db: Database): void {
	try {
		db.exec('ROLLBACK');
	} catch {
		/* no open transaction */
	}
	db.close();
}

export interface LockClock {
	/** Monotonic milliseconds. */
	now(): number;
	sleep(ms: number): void;
}

const monotonicNow = (): number => performance.now();
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const realSyncClock: LockClock = { now: monotonicNow, sleep: (ms) => void Atomics.wait(sleeper, 0, 0, ms) };

/**
 * Retry loop shared by both variants. The first attempt always runs; every
 * later attempt happens only if the monotonic deadline has not passed — so a
 * waiter that slept past its deadline (blocked event loop, scheduler delay)
 * fails with LOCK_TIMEOUT instead of entering late.
 */
export function acquireLoopSync(tryAcquire: () => boolean, timeoutMs: number, clock: LockClock = realSyncClock, onTimeout: () => Error = defaultTimeout): void {
	const deadline = clock.now() + timeoutMs;
	let delay = 5;
	if (tryAcquire()) return;
	for (;;) {
		const left = deadline - clock.now();
		if (left <= 0) throw onTimeout();
		clock.sleep(Math.min(delay, left));
		if (clock.now() >= deadline) throw onTimeout();
		if (tryAcquire()) return;
		delay = Math.min(delay * 2, MAX_BACKOFF_MS);
	}
}

export async function acquireLoop(tryAcquire: () => boolean, timeoutMs: number, onTimeout: () => Error = defaultTimeout): Promise<void> {
	const deadline = monotonicNow() + timeoutMs;
	let delay = 5;
	if (tryAcquire()) return;
	for (;;) {
		const left = deadline - monotonicNow();
		if (left <= 0) throw onTimeout();
		await new Promise((r) => setTimeout(r, Math.min(delay, left)));
		if (monotonicNow() >= deadline) throw onTimeout();
		if (tryAcquire()) return;
		delay = Math.min(delay * 2, MAX_BACKOFF_MS);
	}
}

function defaultTimeout(): Error {
	return new CodeTrailError('LOCK_TIMEOUT', 'Timed out waiting for lock');
}

export async function withLock<T>(locksDir: string, name: string, opts: LockOptions, fn: () => Promise<T> | T): Promise<T> {
	const { db, ownerFile } = open(locksDir, name);
	try {
		await acquireLoop(() => tryAcquire(db), opts.timeoutMs, () => timeoutError(name, ownerFile));
	} catch (err) {
		db.close();
		throw err;
	}
	markHeld(ownerFile);
	try {
		return await fn();
	} finally {
		release(db);
	}
}

/** Synchronous variant for short critical sections (registry read–modify–write). */
export function withLockSync<T>(locksDir: string, name: string, opts: LockOptions, fn: () => T): T {
	const { db, ownerFile } = open(locksDir, name);
	try {
		acquireLoopSync(() => tryAcquire(db), opts.timeoutMs, realSyncClock, () => timeoutError(name, ownerFile));
	} catch (err) {
		db.close();
		throw err;
	}
	markHeld(ownerFile);
	try {
		return fn();
	} finally {
		release(db);
	}
}
