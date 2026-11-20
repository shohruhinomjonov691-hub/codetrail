import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { PROJECT_CATALOG } from '../catalog.js';
import { CodeTrailError } from '../errors.js';

/**
 * Monitor configuration: which URLs, repositories and log files belong to which of the six
 * projects. It lives outside the repository (default `<data dir>/monitor.json`, git-ignored)
 * because it holds machine-specific paths. Nothing here is a secret; the Telegram bot token
 * and chat id come only from the environment.
 */
export interface HealthTarget {
	name: string;
	url: string;
	/** Status that counts as healthy; default: any 2xx or 3xx. */
	expect_status?: number;
	timeout_ms: number;
	/** A healthy answer slower than this is a Warning. */
	slow_ms: number;
	/** Extra attempts before a failure is reported (default 1, 1.5 s apart). */
	retries: number;
}

export interface LogTarget {
	name: string;
	path: string;
	/** Log files not modified within this many minutes are ignored (old errors never alert). Default 1440. */
	max_age_minutes: number;
}

export interface ProjectMonitor {
	health: HealthTarget[];
	repo: { path: string } | null;
	logs: LogTarget[];
}

export interface MonitorConfig {
	cooldown_minutes: { warning: number; critical: number };
	projects: Record<string, ProjectMonitor>;
}

export const DEFAULT_COOLDOWN = { warning: 60, critical: 15 } as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function int(v: unknown, fallback: number, min: number, max: number, what: string): number {
	if (v === undefined) return fallback;
	if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new CodeTrailError('USAGE', `monitor config: ${what} must be an integer in ${min}..${max}`);
	return v;
}

function str(v: unknown, what: string, max = 300): string {
	if (typeof v !== 'string' || !v.trim() || v.length > max) throw new CodeTrailError('USAGE', `monitor config: ${what} must be a non-empty string`);
	return v.trim();
}

/** Health URLs must be plain http(s) without embedded credentials. */
export function checkHealthUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new CodeTrailError('USAGE', 'monitor config: a health url is not a valid URL');
	}
	if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) throw new CodeTrailError('USAGE', 'monitor config: health urls must be http(s) without credentials');
	return url.toString();
}

export function parseMonitorConfig(raw: unknown): MonitorConfig {
	if (!isObj(raw) || raw.schema !== 1 || !isObj(raw.projects)) throw new CodeTrailError('USAGE', 'monitor config: expected {"schema":1,"projects":{…}}');
	const known = new Set(PROJECT_CATALOG.map((p) => p.id));
	const cd = isObj(raw.cooldown_minutes) ? raw.cooldown_minutes : {};
	const projects: Record<string, ProjectMonitor> = {};
	for (const [id, v] of Object.entries(raw.projects)) {
		if (!known.has(id)) throw new CodeTrailError('USAGE', `monitor config: unknown project "${id}"`);
		if (!isObj(v)) throw new CodeTrailError('USAGE', `monitor config: ${id} must be an object`);
		const health = (Array.isArray(v.health) ? v.health : []).map((h: unknown, i): HealthTarget => {
			if (!isObj(h)) throw new CodeTrailError('USAGE', `monitor config: ${id}.health[${i}] must be an object`);
			return {
				name: str(h.name ?? `health-${i + 1}`, `${id}.health[${i}].name`, 60),
				url: checkHealthUrl(str(h.url, `${id}.health[${i}].url`, 500)),
				...(h.expect_status === undefined ? {} : { expect_status: int(h.expect_status, 200, 100, 599, `${id}.health[${i}].expect_status`) }),
				timeout_ms: int(h.timeout_ms, 8000, 500, 60_000, `${id}.health[${i}].timeout_ms`),
				slow_ms: int(h.slow_ms, 5000, 100, 120_000, `${id}.health[${i}].slow_ms`),
				retries: int(h.retries, 1, 0, 3, `${id}.health[${i}].retries`),
			};
		});
		const repoPath = isObj(v.repo) ? str(v.repo.path, `${id}.repo.path`, 500) : null;
		if (repoPath && !isAbsolute(repoPath)) throw new CodeTrailError('USAGE', `monitor config: ${id}.repo.path must be absolute`);
		const logs = (Array.isArray(v.logs) ? v.logs : []).map((l: unknown, i): LogTarget => {
			if (!isObj(l)) throw new CodeTrailError('USAGE', `monitor config: ${id}.logs[${i}] must be an object`);
			const path = str(l.path, `${id}.logs[${i}].path`, 500);
			if (!isAbsolute(path)) throw new CodeTrailError('USAGE', `monitor config: ${id}.logs[${i}].path must be absolute`);
			return { name: str(l.name ?? `log-${i + 1}`, `${id}.logs[${i}].name`, 60), path, max_age_minutes: int(l.max_age_minutes, 1440, 1, 60 * 24 * 30, `${id}.logs[${i}].max_age_minutes`) };
		});
		projects[id] = { health, repo: repoPath ? { path: repoPath } : null, logs };
	}
	return { cooldown_minutes: { warning: int(cd.warning, DEFAULT_COOLDOWN.warning, 1, 10_080, 'cooldown_minutes.warning'), critical: int(cd.critical, DEFAULT_COOLDOWN.critical, 1, 10_080, 'cooldown_minutes.critical') }, projects };
}

export function monitorDir(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
	return env.CODETRAIL_MONITOR_DIR?.trim() || join(dataDir, 'monitor');
}

export function loadMonitorConfig(dataDir: string, env: NodeJS.ProcessEnv = process.env): MonitorConfig {
	const file = env.CODETRAIL_MONITOR_CONFIG?.trim() || join(dataDir, 'monitor.json');
	if (!existsSync(file)) throw new CodeTrailError('USAGE', `monitor config not found (set CODETRAIL_MONITOR_CONFIG or create <data dir>/monitor.json)`);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		throw new CodeTrailError('USAGE', 'monitor config is not valid JSON');
	}
	return parseMonitorConfig(raw);
}
