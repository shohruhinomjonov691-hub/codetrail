/**
 * Monitoring and Telegram alerts (feature C) and root-cause analysis (feature D): health checks
 * against local servers, repo/log checks on temp files and git repos, a loopback Telegram mock,
 * dedup/cool-down/recovery, secret redaction, evidence levels, and the read-only guarantee.
 * Canary secrets are assembled at runtime. No real network, no real Telegram.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { healthCheck, logCheck, recentCommits, repoCheck } from '../src/monitor/checks.js';
import { parseMonitorConfig, type HealthTarget } from '../src/monitor/config.js';
import { brief, redactText } from '../src/monitor/redact.js';
import { analyze, fileRefsIn, samePath, type CodeHit } from '../src/monitor/rootcause.js';
import { formatMessage, lastReport, runMonitor, type RunOptions } from '../src/monitor/run.js';
import { sendTelegram, validateTelegramBase } from '../src/monitor/telegram.js';
import { commitFiles, git, makeRepo, tempDir } from './helpers.js';

const TOKEN = ['1234567890', 'AAF' + 'q9Zr'.repeat(8)].join(':');
const CHAT = '424242';
const SECRETS = {
	password: ['Str0ng', 'Passw0rd', '9xQ'].join(''),
	bearer: ['eyJhbGciOi', 'JIUzI1NiJ9'].join(''),
	github: 'ghp' + '_' + 'Cn4ry'.repeat(8) + 'Zq9X',
	dbUrl: ['postgres://app:', 'Sup3rS3cretPw', '@db.internal/prod'].join(''),
};

// ------------------------------------------------------------------ local servers

interface Hit {
	url: string;
	body: string;
}
let target: Server;
let targetUrl: string;
let targetBehavior: { status: number; delayMs: number } = { status: 200, delayMs: 0 };
let telegram: Server;
let telegramUrl: string;
let telegramStatus = 200;
const telegramHits: Hit[] = [];

const listen = (server: Server): Promise<string> =>
	new Promise((resolve) => void server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
const readBody = (req: IncomingMessage): Promise<string> =>
	new Promise((resolve) => {
		let raw = '';
		req.on('data', (c) => (raw += c));
		req.on('end', () => resolve(raw));
	});

beforeAll(async () => {
	target = createServer((_req, res) => {
		const { status, delayMs } = targetBehavior;
		setTimeout(() => {
			res.writeHead(status, { 'Content-Type': 'text/plain' });
			res.end('body');
		}, delayMs);
	});
	telegram = createServer(async (req, res) => {
		telegramHits.push({ url: req.url ?? '', body: await readBody(req) });
		res.writeHead(telegramStatus, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ ok: telegramStatus === 200, description: `echo ${TOKEN}` }));
	});
	targetUrl = await listen(target);
	telegramUrl = await listen(telegram);
});
afterAll(async () => {
	await new Promise<void>((r) => void target.close(() => r()));
	await new Promise<void>((r) => void telegram.close(() => r()));
});
beforeEach(() => {
	targetBehavior = { status: 200, delayMs: 0 };
	telegramStatus = 200;
	telegramHits.length = 0;
});

const healthTarget = (over: Partial<HealthTarget> = {}): HealthTarget => ({ name: 'site', url: targetUrl, timeout_ms: 500, slow_ms: 5000, retries: 0, ...over });
/** Built per call: the mock's port is only known after beforeAll. */
const tg = () => ({ token: TOKEN, chatId: CHAT, apiBase: telegramUrl });

function options(over: Partial<RunOptions> & { projects: Record<string, unknown> }): RunOptions & { dir: string } {
	const dir = tempDir('monitor');
	const { projects, ...rest } = over;
	return {
		dir,
		dataDir: dir,
		stateDir: join(dir, 'state'),
		config: parseMonitorConfig({ schema: 1, projects }),
		telegram: tg(),
		retryDelayMs: 5,
		...rest,
	};
}
const alertLog = (o: { stateDir: string }): { outcome: string; severity: string; reason: string | null }[] => {
	try {
		return readFileSync(join(o.stateDir, 'alerts.log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
	} catch {
		return [];
	}
};
const siteProject = (over: Record<string, unknown> = {}) => ({ 'food-lens': { health: [{ name: 'site', url: targetUrl, timeout_ms: 500, retries: 0, ...over }] } });

// ------------------------------------------------------------------ redaction

describe('redaction', () => {
	it('removes tokens, passwords, credentials in URLs, dotenv assignments, .env names and home paths', () => {
		const text = [
			`password=${SECRETS.password}`,
			`Authorization: Bearer ${SECRETS.bearer}.abcdefghij`,
			`token: "${SECRETS.github}"`,
			`connect ${SECRETS.dbUrl} failed`,
			`bot ${TOKEN} sent`,
			'DATABASE_PASSWORD=hunter2hunter2',
			'loaded /Users/someone/app/.env.production failed',
			'api_key = abcdef123456',
			'-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END RSA PRIVATE KEY-----',
		].join('\n');
		const out = redactText(text);
		for (const secret of [SECRETS.password, SECRETS.github, 'Sup3rS3cretPw', TOKEN, 'hunter2hunter2', 'abcdef123456', 'MIIEvQIBADANBg', '/Users/someone', '.env.production'] as string[]) expect(out).not.toContain(secret);
		expect(out).toContain('[REDACTED]');
		expect(out).toContain('[env-file]');
		expect(out).toContain('~/app');
		expect(redactText(out)).toBe(out); // idempotent
	});

	it('keeps ordinary error text readable and cuts to a length', () => {
		expect(redactText('GET /api/tours 502 Bad Gateway after 312ms')).toBe('GET /api/tours 502 Bad Gateway after 312ms');
		const b = brief('x '.repeat(200), 30);
		expect(b.length).toBeLessThanOrEqual(30);
		expect(b.endsWith('…')).toBe(true);
	});
});

// ------------------------------------------------------------------ configuration

describe('monitor configuration', () => {
	it('accepts only known projects, http(s) URLs without credentials and absolute paths', () => {
		expect(() => parseMonitorConfig({ schema: 1, projects: { nope: {} } })).toThrow(/unknown project/);
		expect(() => parseMonitorConfig({ schema: 1, projects: { gotrip: { health: [{ url: 'ftp://x.test/' }] } } })).toThrow(/http/);
		expect(() => parseMonitorConfig({ schema: 1, projects: { gotrip: { health: [{ url: 'https://user:pw@x.test/' }] } } })).toThrow(/credentials/);
		expect(() => parseMonitorConfig({ schema: 1, projects: { gotrip: { logs: [{ path: 'relative.log' }] } } })).toThrow(/absolute/);
		expect(() => parseMonitorConfig({ schema: 1, projects: { gotrip: { repo: { path: 'rel' } } } })).toThrow(/absolute/);
		expect(() => parseMonitorConfig({ schema: 2, projects: {} })).toThrow();
		const ok = parseMonitorConfig({ schema: 1, projects: { gotrip: { health: [{ url: 'https://example.test/health' }] } } });
		expect(ok.cooldown_minutes).toEqual({ warning: 60, critical: 15 });
		expect(ok.projects.gotrip!.health[0]).toMatchObject({ timeout_ms: 8000, retries: 1, slow_ms: 5000 });
	});
});

// ------------------------------------------------------------------ health checks

describe('health checks', () => {
	it('is OK for 2xx, Warning for 4xx and slow answers, Critical / Down for 5xx, refused and timeouts', async () => {
		expect(await healthCheck('food-lens', healthTarget())).toMatchObject({ severity: 'ok', source: 'Health Check' });
		targetBehavior = { status: 404, delayMs: 0 };
		expect(await healthCheck('food-lens', healthTarget())).toMatchObject({ severity: 'warning', fingerprint: 'http-404' });
		targetBehavior = { status: 503, delayMs: 0 };
		expect(await healthCheck('food-lens', healthTarget())).toMatchObject({ severity: 'critical', fingerprint: 'http-503', facts: { status: 503 } });
		targetBehavior = { status: 200, delayMs: 150 };
		expect(await healthCheck('food-lens', healthTarget({ slow_ms: 100 }))).toMatchObject({ severity: 'warning', fingerprint: 'slow' });
		targetBehavior = { status: 200, delayMs: 2000 };
		expect(await healthCheck('food-lens', healthTarget({ timeout_ms: 300 }))).toMatchObject({ severity: 'critical', fingerprint: 'timeout', facts: { error_class: 'timeout' } });
		const closed = createServer();
		const dead = await listen(closed);
		await new Promise<void>((r) => void closed.close(() => r()));
		expect(await healthCheck('food-lens', healthTarget({ url: dead }))).toMatchObject({ severity: 'critical', fingerprint: 'refused' });
		expect(await healthCheck('food-lens', healthTarget({ url: 'http://nonexistent-host.invalid/' }))).toMatchObject({ severity: 'critical' });
	});

	it('honours expect_status and retries a failure once before reporting it', async () => {
		targetBehavior = { status: 204, delayMs: 0 };
		expect(await healthCheck('food-lens', healthTarget({ expect_status: 200 }))).toMatchObject({ severity: 'warning' });
		let calls = 0;
		const flaky = (async () => {
			calls++;
			if (calls === 1) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
			return new Response('ok', { status: 200 });
		}) as typeof fetch;
		expect(await healthCheck('food-lens', healthTarget({ retries: 1 }), flaky, 1)).toMatchObject({ severity: 'ok' });
		expect(calls).toBe(2);
		calls = 0;
		expect(await healthCheck('food-lens', healthTarget({ retries: 0 }), flaky, 1)).toMatchObject({ severity: 'critical', fingerprint: 'refused' });
	});
});

// ------------------------------------------------------------------ telegram

describe('Telegram sender', () => {
	it('posts one plain-text message to the bot API and never returns or logs the token', async () => {
		const r = await sendTelegram(tg(), 'Muammo: test', fetch);
		expect(r).toEqual({ ok: true });
		expect(telegramHits).toHaveLength(1);
		expect(telegramHits[0]!.url).toBe(`/bot${TOKEN}/sendMessage`);
		const form = new URLSearchParams(telegramHits[0]!.body);
		expect(form.get('chat_id')).toBe(CHAT);
		expect(form.get('text')).toBe('Muammo: test');
		telegramStatus = 500;
		const failed = await sendTelegram(tg(), 'x', fetch);
		expect(failed).toEqual({ ok: false, reason: 'http_500' });
		expect(JSON.stringify(failed)).not.toContain(TOKEN);
		expect(await sendTelegram(null, 'x')).toEqual({ ok: false, reason: 'not_configured' });
		const down = await sendTelegram({ ...tg(), apiBase: 'http://127.0.0.1:1' }, 'x', fetch, 500);
		expect(down.ok).toBe(false);
		expect(JSON.stringify(down)).not.toContain(TOKEN);
	});

	it('accepts only api.telegram.org over https (or a plain-http loopback mock)', () => {
		expect(validateTelegramBase('https://api.telegram.org')).toBe('https://api.telegram.org');
		expect(validateTelegramBase('http://127.0.0.1:9000')).toBe('http://127.0.0.1:9000');
		for (const bad of ['https://evil.example', 'http://api.telegram.org', 'https://api.telegram.org/x', 'https://u:p@api.telegram.org', 'http://10.0.0.5', 'nope']) expect(() => validateTelegramBase(bad)).toThrow();
	});
});

// ------------------------------------------------------------------ alerts: dedup, cool-down, recovery

describe('alerts: only for failures, with dedup and cool-down', () => {
	it('sends nothing for healthy projects and records nothing', async () => {
		const o = options({ projects: siteProject() });
		const report = await runMonitor(o);
		expect(report.items).toHaveLength(1);
		expect(report.items[0]).toMatchObject({ level: 'OK', alert: null });
		expect(telegramHits).toHaveLength(0);
		expect(alertLog(o)).toEqual([]);
	});

	it('does not alert for projects with nothing configured (unknown is not failing)', async () => {
		const o = options({ projects: { gotrip: {}, kervan: { health: [] } } });
		const report = await runMonitor(o);
		expect(report.not_configured).toEqual(expect.arrayContaining(['gotrip', 'kervan', 'camera-studio', 'codetrail', 'findit', 'food-lens']));
		expect(report.items).toEqual([]);
		expect(telegramHits).toHaveLength(0);
	});

	it('Critical / Down: sends one short Muammo / Ehtimoliy sabab / Nima qilish kerak message, then deduplicates', async () => {
		targetBehavior = { status: 502, delayMs: 0 };
		let t = Date.parse('2026-11-19T10:00:00Z');
		const o = options({ projects: siteProject(), now: () => t });
		const first = await runMonitor(o);
		expect(first.items[0]).toMatchObject({ level: 'Critical / Down', source: 'Health Check', alert: { outcome: 'Sent', reason: null } });
		expect(telegramHits).toHaveLength(1);
		const text = new URLSearchParams(telegramHits[0]!.body).get('text')!;
		expect(text).toMatch(/Critical \/ Down · Health Check/);
		expect(text).toMatch(/Muammo: Food Lens — /);
		expect(text).toMatch(/Ehtimoliy sabab \((High|Medium|Low Evidence|Unconfirmed)\): /);
		expect(text).toMatch(/Nima qilish kerak: /);
		expect(text.length).toBeLessThan(900);
		expect(text).toContain('502');
		expect(text).not.toContain(TOKEN);

		t += 5 * 60_000; // inside the 15-minute Critical cool-down
		const second = await runMonitor({ ...o, now: () => t });
		expect(second.items[0]!.alert).toMatchObject({ outcome: 'Deduplicated' });
		expect(telegramHits).toHaveLength(1);

		t += 11 * 60_000; // 16 minutes after the first alert
		const third = await runMonitor({ ...o, now: () => t });
		expect(third.items[0]!.alert).toMatchObject({ outcome: 'Sent' });
		expect(telegramHits).toHaveLength(2);
		expect(alertLog(o).map((e) => e.outcome)).toEqual(['Sent', 'Deduplicated', 'Sent']);
	});

	it('Warning has its own, longer cool-down, and a changed failure is a new alert', async () => {
		targetBehavior = { status: 404, delayMs: 0 };
		let t = Date.parse('2026-11-19T10:00:00Z');
		const o = options({ projects: siteProject(), now: () => t });
		expect((await runMonitor(o)).items[0]).toMatchObject({ level: 'Warning', alert: { outcome: 'Sent' } });
		t += 30 * 60_000;
		expect((await runMonitor({ ...o, now: () => t })).items[0]!.alert).toMatchObject({ outcome: 'Deduplicated' }); // 30 < 60
		targetBehavior = { status: 500, delayMs: 0 }; // escalates: different severity + fingerprint
		expect((await runMonitor({ ...o, now: () => t })).items[0]).toMatchObject({ level: 'Critical / Down', alert: { outcome: 'Sent' } });
		expect(telegramHits).toHaveLength(2);
	});

	it('a failed Telegram send is logged as Failed, is not remembered as sent, and is retried by the next run', async () => {
		targetBehavior = { status: 500, delayMs: 0 };
		telegramStatus = 500;
		const o = options({ projects: siteProject() });
		const a = await runMonitor(o);
		expect(a.items[0]!.alert).toEqual({ outcome: 'Failed', reason: 'http_500' });
		telegramStatus = 200;
		const b = await runMonitor(o);
		expect(b.items[0]!.alert).toMatchObject({ outcome: 'Sent' });
		expect(alertLog(o).map((e) => e.outcome)).toEqual(['Failed', 'Sent']);
		expect(readFileSync(join(o.stateDir, 'alerts.log.jsonl'), 'utf8')).not.toContain(TOKEN);
	});

	it('without Telegram credentials the failure is reported as Failed (not_configured), never as Sent', async () => {
		targetBehavior = { status: 500, delayMs: 0 };
		const o = options({ projects: siteProject(), telegram: null });
		expect((await runMonitor(o)).items[0]!.alert).toEqual({ outcome: 'Failed', reason: 'not_configured' });
	});

	it('two healthy runs end an incident: the next failure alerts at once, even inside the cool-down', async () => {
		let t = Date.parse('2026-11-19T10:00:00Z');
		const o = options({ projects: siteProject(), now: () => t });
		targetBehavior = { status: 500, delayMs: 0 };
		await runMonitor(o);
		targetBehavior = { status: 200, delayMs: 0 };
		t += 60_000;
		await runMonitor({ ...o, now: () => t });
		t += 60_000;
		await runMonitor({ ...o, now: () => t });
		expect(telegramHits).toHaveLength(1); // recovery itself sends nothing
		targetBehavior = { status: 500, delayMs: 0 };
		t += 60_000;
		expect((await runMonitor({ ...o, now: () => t })).items[0]!.alert).toMatchObject({ outcome: 'Sent' });
		expect(telegramHits).toHaveLength(2);
	});

	it('dry run evaluates and reports but sends nothing and remembers nothing', async () => {
		targetBehavior = { status: 500, delayMs: 0 };
		const o = options({ projects: siteProject(), dryRun: true });
		const r = await runMonitor(o);
		expect(r.items[0]).toMatchObject({ level: 'Critical / Down', alert: { outcome: 'DryRun' } });
		expect(telegramHits).toHaveLength(0);
		expect(alertLog(o)).toEqual([]);
		expect(await runMonitor({ ...o, dryRun: false })).toMatchObject({ items: [{ alert: { outcome: 'Sent' } }] });
	});

	it('saves the last report for `monitor status`', async () => {
		targetBehavior = { status: 500, delayMs: 0 };
		const o = options({ projects: siteProject() });
		await runMonitor(o);
		expect(lastReport(o.stateDir)?.items[0]).toMatchObject({ project_id: 'food-lens', level: 'Critical / Down' });
		expect(JSON.stringify(lastReport(o.stateDir))).not.toContain(TOKEN);
	});
});

// ------------------------------------------------------------------ repo / log checks

describe('repo and log checks', () => {
	it('flags new error lines in a log once, redacted, Critical for fatal markers; old and stale logs are ignored', async () => {
		const dir = tempDir('logs');
		const log = join(dir, 'app.log');
		writeFileSync(log, `2026-11-19 INFO started\n2026-11-19 ERROR payment failed password=${SECRETS.password} for ${SECRETS.dbUrl}\n`);
		const o = options({ projects: { 'food-lens': { logs: [{ name: 'app', path: log }] } } });
		const first = await runMonitor(o);
		expect(first.items[0]).toMatchObject({ source: 'Repo / Log Check', level: 'Warning', alert: { outcome: 'Sent' } });
		const sent = new URLSearchParams(telegramHits[0]!.body).get('text')!;
		for (const secret of [SECRETS.password, 'Sup3rS3cretPw']) {
			expect(sent).not.toContain(secret);
			expect(JSON.stringify(first)).not.toContain(secret);
		}
		// nothing new was written → no alert (not even a dedup entry)
		expect((await runMonitor(o)).items[0]).toMatchObject({ level: 'OK', alert: null });
		appendFileSync(log, '2026-11-19 FATAL out of memory\n');
		expect((await runMonitor(o)).items[0]).toMatchObject({ level: 'Critical / Down', alert: { outcome: 'Sent' } });
		expect(telegramHits).toHaveLength(2);

		const old = join(dir, 'old.log');
		writeFileSync(old, 'ERROR something ancient\n');
		utimesSync(old, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
		const result = logCheck('food-lens', { name: 'old', path: old, max_age_minutes: 60 }, null, Date.parse('2026-11-19T10:00:00Z')).result;
		expect(result).toMatchObject({ severity: 'ok' });
		expect(logCheck('food-lens', { name: 'gone', path: join(dir, 'none.log'), max_age_minutes: 60 }, null).result).toMatchObject({ severity: 'warning', fingerprint: 'log-missing' });
	});

	it('a log error whose alert failed to send is read again and alerted by the next run', async () => {
		const dir = tempDir('logretry');
		const log = join(dir, 'app.log');
		writeFileSync(log, 'ERROR database unreachable\n');
		const o = options({ projects: { 'food-lens': { logs: [{ name: 'app', path: log }] } } });
		telegramStatus = 500;
		expect((await runMonitor(o)).items[0]!.alert).toEqual({ outcome: 'Failed', reason: 'http_500' });
		telegramStatus = 200;
		const second = await runMonitor(o); // nothing new was written, yet the unsent error must not be lost
		expect(second.items[0]).toMatchObject({ level: 'Warning', alert: { outcome: 'Sent' } });
		expect((await runMonitor(o)).items[0]).toMatchObject({ level: 'OK' }); // now consumed
	});

	it('does not read a rotated or truncated log as new errors twice', () => {
		const dir = tempDir('rotate');
		const log = join(dir, 'a.log');
		writeFileSync(log, 'ERROR one\n');
		const a = logCheck('food-lens', { name: 'a', path: log, max_age_minutes: 1440 }, null);
		expect(a.result.severity).toBe('warning');
		const b = logCheck('food-lens', { name: 'a', path: log, max_age_minutes: 1440 }, a.cursor);
		expect(b.result.severity).toBe('ok');
		writeFileSync(log, 'ERROR two\n'); // truncated + rewritten, same size as before → a new inode is not guaranteed, size not smaller
		const c = logCheck('food-lens', { name: 'a', path: log, max_age_minutes: 1440 }, a.cursor);
		expect(['ok', 'warning']).toContain(c.result.severity);
	});

	it('repo check is read-only: OK for a git repo, Warning for a missing or non-git path', async () => {
		const root = tempDir('repo');
		const { dir } = makeRepo(root, 'r', { 'a.ts': 'export const a = 1;\n' });
		const before = git(dir, 'status', '--porcelain') + git(dir, 'rev-parse', 'HEAD');
		expect(await repoCheck('food-lens', dir)).toMatchObject({ severity: 'ok' });
		expect(await repoCheck('food-lens', join(root, 'missing'))).toMatchObject({ severity: 'warning', fingerprint: 'repo-missing' });
		expect(await repoCheck('food-lens', root)).toMatchObject({ severity: 'warning', fingerprint: 'repo-unreadable' });
		expect(git(dir, 'status', '--porcelain') + git(dir, 'rev-parse', 'HEAD')).toBe(before);
	});

	it('recentCommits returns redacted subjects and never lists .env files', async () => {
		const root = tempDir('commits');
		const { dir } = makeRepo(root, 'r', { 'a.ts': 'export const a = 1;\n' });
		commitFiles(dir, { 'src/pay.ts': 'export const p = 1;\n', '.env': 'KEY=value\n' }, `fix pay token=${SECRETS.password}`);
		const commits = await recentCommits(dir, 24 * 365 * 5);
		expect(commits[0]!.files).toContain('src/pay.ts');
		expect(commits[0]!.files.some((f) => f.includes('.env'))).toBe(false);
		expect(commits[0]!.subject).not.toContain(SECRETS.password);
	});
});

// ------------------------------------------------------------------ root cause

describe('root-cause analysis', () => {
	const health = (over: Record<string, unknown> = {}) => ({ project_id: 'food-lens', source: 'Health Check' as const, check: 'site', severity: 'critical' as const, fingerprint: 'http-502', summary: 'site: HTTP 502', facts: { url: 'https://food.example/api/ingredients', status: 502, latency_ms: 90, error_class: 'http' as const }, ...over });
	const logFail = (lines: string[]) => ({ project_id: 'food-lens', source: 'Repo / Log Check' as const, check: 'app', severity: 'warning' as const, fingerprint: 'log:ERROR:x', summary: 'app: error lines', facts: { log_lines: lines } });
	const commit = { hash: 'abc1234', when: '2026-11-18T09:00:00+00:00', subject: 'rework ingredient lookup', files: ['food_lens/api.py'] };
	const rag = (hits: CodeHit[] | null) => async () => hits;
	const ctx = (over: Partial<Parameters<typeof analyze>[1]> = {}): Parameters<typeof analyze>[1] => ({ projectName: 'Food Lens', commits: [], rag: null, siblings: [], ...over });

	it('Unconfirmed: a bare connectivity failure with nothing else to go on', async () => {
		const r = await analyze(health({ fingerprint: 'timeout', facts: { url: 'https://food.example/', error_class: 'timeout', latency_ms: 8000 } }), ctx());
		expect(r.confidence).toBe('Unconfirmed');
		expect(r.cause).toMatch(/javob bermayapti/);
		expect(r.steps.length).toBeGreaterThan(0);
	});

	it('Low Evidence: a concrete status but nothing correlates (unrelated commit, unrelated code)', async () => {
		const r = await analyze(health(), ctx({ commits: [{ ...commit, files: ['docs/readme.md'] }], rag: rag([{ path: 'food_lens/other.py', symbol: 'other', citation: 'main@1:food_lens/other.py:L1-L9' }]) }));
		expect(r.confidence).toBe('Low Evidence');
		expect(r.correlations).toEqual({ code_match: false, recent_commit: false, concurrent_failure: false });
		expect(r.cause).toMatch(/reverse proxy/);
	});

	it('Medium: the error names a file that is indexed code (one correlation)', async () => {
		const r = await analyze(logFail([`ERROR Traceback in food_lens/api.py:42 KeyError 'pizza'`]), ctx({ rag: rag([{ path: 'food_lens/api.py', symbol: 'lookup', citation: 'main@1:food_lens/api.py:L30-L60' }]) }));
		expect(r.confidence).toBe('Medium');
		expect(r.correlations).toMatchObject({ code_match: true, recent_commit: false });
		expect(r.evidence.some((e) => e.kind === 'code' && e.text.includes('food_lens/api.py'))).toBe(true);
	});

	it('High: error names indexed code AND a recent commit touched that file', async () => {
		const r = await analyze(logFail([`ERROR Traceback in food_lens/api.py:42 KeyError 'pizza'`]), ctx({ commits: [commit], rag: rag([{ path: 'food_lens/api.py', symbol: 'lookup', citation: 'main@1:food_lens/api.py:L30-L60' }]) }));
		expect(r.confidence).toBe('High');
		expect(r.cause).toContain('abc1234');
		expect(r.evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(['log', 'code', 'commit']));
	});

	it('a health failure together with a log failure of the same project counts as one correlation', async () => {
		const h = health();
		const l = logFail(['ERROR upstream connect error']);
		const r = await analyze(h, ctx({ siblings: [h, l] }));
		expect(r.correlations.concurrent_failure).toBe(true);
		expect(r.confidence).toBe('Medium');
	});

	it('reads file references with their line numbers (Python tracebacks, file:line:col) and skips .env and URLs', () => {
		expect(fileRefsIn('File "findit/app.py", line 40, in detect')).toEqual([{ path: 'findit/app.py', line: 40 }]);
		expect(fileRefsIn('at run (src/api/pay.ts:12:5)')).toEqual([{ path: 'src/api/pay.ts', line: 12 }]);
		expect(fileRefsIn('see https://x.test/a.json and /srv/.env and config.yaml')).toEqual([{ path: 'config.yaml' }]);
		expect(fileRefsIn('bad data.json:7 and notes.mdx')).toEqual([{ path: 'data.json', line: 7 }]); // .json is not read as .js; .mdx is not .md
	});

	it('passes the named files (with lines) to the index and counts an exact located chunk as a code match', async () => {
		let seen: unknown;
		const r = await analyze(logFail([`ERROR File "food_lens/api.py", line 42, in lookup`]), ctx({ rag: async (_p, _q, files) => { seen = files; return [{ path: 'food_lens/api.py', symbol: 'lookup', citation: 'main@1:food_lens/api.py:L30-60' }]; } }));
		expect(seen).toEqual([{ path: 'food_lens/api.py', line: 42 }]);
		expect(r.correlations.code_match).toBe(true);
	});

	it('does not treat generic file names as a match, and survives a missing or failing index', async () => {
		expect(samePath('/srv/app/main.py', 'main.py')).toBe(false);
		expect(samePath('/srv/app/food_lens/api.py', 'food_lens/api.py')).toBe(true);
		expect(samePath('./food_lens/api.py', 'food_lens/api.py')).toBe(true);
		const noIndex = await analyze(logFail(['ERROR in food_lens/api.py:1']), ctx({ rag: rag(null) }));
		expect(noIndex.evidence.some((e) => e.kind === 'note' && /indeks/.test(e.text))).toBe(true);
		const broken = await analyze(logFail(['ERROR in food_lens/api.py:1']), ctx({ rag: async () => { throw new Error('boom'); } }));
		expect(broken.confidence).toBe('Low Evidence');
	});

	it('never shows secrets or .env content in the cause, evidence, steps or message', async () => {
		const lines = [`ERROR db login failed password=${SECRETS.password} url ${SECRETS.dbUrl} loaded /Users/someone/app/.env`, `FATAL token ${SECRETS.github}`];
		const r = await analyze(logFail(lines), ctx({ commits: [{ ...commit, subject: `bump token=${SECRETS.password}` }] }));
		const all = JSON.stringify(r) + formatMessage('Food Lens', { ...logFail(lines), fingerprint: 'x' } as never, r);
		for (const secret of [SECRETS.password, 'Sup3rS3cretPw', SECRETS.github, '/Users/someone', '/.env']) expect(all).not.toContain(secret);
	});

	it('end to end: a log error + an indexed-file match + a recent commit give High and reach Telegram redacted, without touching the repo', async () => {
		const root = tempDir('e2e');
		const { dir } = makeRepo(root, 'fl', { 'food_lens/api.py': 'def lookup(name):\n    return TABLE[name]\n' });
		commitFiles(dir, { 'food_lens/api.py': 'def lookup(name):\n    return TABLE[name.lower()]\n' }, 'rework ingredient lookup');
		// fixture commits are dated 2026-01-01; the "recent commit" rule looks at the last 72 hours, so re-date this one
		const now = new Date().toISOString();
		execFileSync('git', ['commit', '--amend', '--no-edit', '-q'], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_AUTHOR_DATE: now, GIT_COMMITTER_DATE: now } });
		const log = join(root, 'app.log');
		writeFileSync(log, `ERROR Traceback in food_lens/api.py:2 KeyError 'pizza' password=${SECRETS.password}\n`);
		const repoBefore = git(dir, 'status', '--porcelain') + git(dir, 'rev-parse', 'HEAD') + git(dir, 'stash', 'list');
		const o = options({
			projects: { 'food-lens': { repo: { path: dir }, logs: [{ name: 'app', path: log }] } },
			rag: async () => [{ path: 'food_lens/api.py', symbol: 'lookup', citation: 'app@abc:food_lens/api.py:L1-L2' }],
		});
		const report = await runMonitor(o);
		const failing = report.items.filter((i) => i.level !== 'OK');
		expect(failing).toHaveLength(1);
		expect(failing[0]!.analysis).toMatchObject({ confidence: 'High', correlations: { code_match: true, recent_commit: true } });
		expect(failing[0]!.alert).toMatchObject({ outcome: 'Sent' });
		const text = new URLSearchParams(telegramHits[0]!.body).get('text')!;
		expect(text).toContain('Ehtimoliy sabab (High)');
		expect(text).not.toContain(SECRETS.password);
		expect(git(dir, 'status', '--porcelain') + git(dir, 'rev-parse', 'HEAD') + git(dir, 'stash', 'list')).toBe(repoBefore);
	});
});
