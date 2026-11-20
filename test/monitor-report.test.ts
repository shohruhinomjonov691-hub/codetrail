/**
 * Daily report (`monitor run --report`) and the web Check button (/api/monitor/*): the one-message
 * summary and its exact format, dry-run, the unchanged alert behaviour, last-run.json, and the
 * key-protected, rate-limited endpoints. Local health targets and a loopback Telegram mock only.
 * Canary secrets are assembled at runtime. No real network, no real Telegram.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AnswerService } from '../src/answer/service.js';
import { withLock } from '../src/lock.js';
import { parseMonitorConfig } from '../src/monitor/config.js';
import { formatReportMessage, kstStamp, publicReport, summarizeProjects } from '../src/monitor/report.js';
import { lastReport, runMonitor, type ReportItem, type RunOptions, type RunReport } from '../src/monitor/run.js';
import { bearerMatches, createHttpServer } from '../src/server/http.js';
import { CodeTrailError } from '../src/errors.js';
import { DIST, tempDir } from './helpers.js';

const TOKEN = ['1234567890', 'AAF' + 'q9Zr'.repeat(8)].join(':');
const CHAT = '424242';
const KEY = ['monitor', 'access', 'key', 'for', 'tests', '0123'].join('-'); // 16+ characters, built at runtime
const PW = ['Rep0rt', 'Passw0rd', '7zK'].join('');

// ------------------------------------------------------------------ local servers

let target: Server;
let targetUrl = '';
let targetStatus = 200;
let targetDelayMs = 0;
let telegram: Server;
let telegramUrl = '';
let telegramStatus = 200;
const telegramHits: string[] = [];

const listen = (server: Server): Promise<string> => new Promise((resolve) => void server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
const readBody = (req: IncomingMessage): Promise<string> =>
	new Promise((resolve) => {
		let raw = '';
		req.on('data', (c) => (raw += c));
		req.on('end', () => resolve(raw));
	});

beforeAll(async () => {
	target = createServer((_req, res) => {
		setTimeout(() => {
			res.writeHead(targetStatus, { 'Content-Type': 'text/plain' });
			res.end('body');
		}, targetDelayMs);
	});
	telegram = createServer(async (req, res) => {
		telegramHits.push(`${req.url ?? ''}\n${await readBody(req)}`);
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
	targetStatus = 200;
	targetDelayMs = 0;
	telegramStatus = 200;
	telegramHits.length = 0;
});

const tg = () => ({ token: TOKEN, chatId: CHAT, apiBase: telegramUrl });
/** The message text as Telegram received it (form-decoded). */
const sentText = (i = 0): string => new URLSearchParams(telegramHits[i]!.split('\n')[1]).get('text') ?? '';

// ------------------------------------------------------------------ message format

const item = (project_id: string, project: string, level: ReportItem['level'], summary: string): ReportItem => ({ project_id, project, source: 'Health Check', check: 'site', level, summary, analysis: null, alert: null });
const ok = (id: string, name: string): ReportItem => item(id, name, 'OK', 'site: HTTP 200 in 120 ms');
const AT = '2026-11-21T00:00:00.000Z'; // 09:00 in Asia/Seoul

describe('report message format', () => {
	it('shows the time in Asia/Seoul (UTC+9, no daylight saving)', () => {
		expect(kstStamp(Date.parse('2026-11-21T00:00:00Z'))).toBe('2026-11-21 09:00 KST');
		expect(kstStamp(Date.parse('2026-11-20T23:59:00Z'))).toBe('2026-11-21 08:59 KST');
		expect(kstStamp(Date.parse('2026-07-01T15:30:00Z'))).toBe('2026-07-02 00:30 KST');
	});

	it('lists healthy projects on one line and each problem on its own line', () => {
		const text = formatReportMessage({
			at: AT,
			not_configured: [],
			items: [ok('gotrip', 'GoTrip'), item('kervan', 'Kervan', 'Critical / Down', 'site: TLS/certificate error'), ok('camera-studio', 'Camera Studio'), ok('codetrail', 'CodeTrail'), ok('findit', 'FindIt'), ok('food-lens', 'Food Lens')],
		});
		expect(text).toBe(
			['📊 CodeTrail monitor — 2026-11-21 09:00 KST', '✅ GoTrip · ✅ Camera Studio · ✅ CodeTrail · ✅ FindIt · ✅ Food Lens', '❌ Kervan — TLS/certificate error'].join('\n'),
		);
	});

	it('everything healthy: one short line "✅ 6/6 — hammasi ishlayapti"', () => {
		const items = [ok('gotrip', 'GoTrip'), ok('kervan', 'Kervan'), ok('camera-studio', 'Camera Studio'), ok('codetrail', 'CodeTrail'), ok('findit', 'FindIt'), ok('food-lens', 'Food Lens')];
		expect(formatReportMessage({ at: AT, items, not_configured: [] })).toBe('📊 CodeTrail monitor — 2026-11-21 09:00 KST\n✅ 6/6 — hammasi ishlayapti');
	});

	it('a project is as bad as its worst check; a warning is shown as a warning, not as down', () => {
		const items = [
			item('gotrip', 'GoTrip', 'OK', 'site: HTTP 200 in 100 ms'),
			{ ...item('gotrip', 'GoTrip', 'Warning', 'api: slow response (6000 ms, limit 5000 ms)'), check: 'api' },
			item('kervan', 'Kervan', 'Critical / Down', 'site: HTTP 502'),
		];
		const rows = summarizeProjects({ items });
		expect(rows.map((r) => [r.project_id, r.status, r.reason])).toEqual([
			['gotrip', 'warning', 'slow response (6000 ms, limit 5000 ms)'],
			['kervan', 'critical', 'HTTP 502'],
		]);
		const text = formatReportMessage({ at: AT, items, not_configured: [] });
		expect(text).toContain('⚠️ GoTrip — slow response');
		expect(text).toContain('❌ Kervan — HTTP 502');
		expect(text).not.toContain('hammasi ishlayapti');
	});

	it('names projects that have nothing configured instead of counting them as healthy or failing', () => {
		const text = formatReportMessage({ at: AT, items: [ok('gotrip', 'GoTrip')], not_configured: ['kervan'] });
		expect(text).toContain('✅ 1/1 — hammasi ishlayapti');
		expect(text).toContain('➖ sozlanmagan: Kervan');
	});

	it('never carries a secret from a check text, and the public report drops the root-cause details', () => {
		const dirty = item('gotrip', 'GoTrip', 'Critical / Down', `site: login failed password=${PW} token=${TOKEN}`);
		const text = formatReportMessage({ at: AT, items: [dirty], not_configured: [] });
		expect(text).not.toContain(PW);
		expect(text).not.toContain(TOKEN);
		const report: RunReport = { at: AT, items: [{ ...dirty, analysis: { confidence: 'High', cause: `leaked ${PW}`, steps: [], evidence: [] } as unknown as ReportItem['analysis'] }], not_configured: [], telegram: { outcome: 'Sent', reason: null } };
		const pub = JSON.stringify(publicReport(report));
		expect(pub).not.toContain(PW);
		expect(pub).not.toContain(TOKEN);
		expect(pub).not.toContain('analysis');
		expect(pub).toContain('"outcome":"Sent"');
	});
});

// ------------------------------------------------------------------ report mode of runMonitor

function setup(projects: Record<string, unknown>, over: Partial<RunOptions> = {}): RunOptions & { dir: string } {
	const dir = tempDir('report');
	return { dir, dataDir: dir, stateDir: join(dir, 'monitor'), config: parseMonitorConfig({ schema: 1, projects }), telegram: tg(), retryDelayMs: 5, ...over };
}
const site = (url = targetUrl) => ({ health: [{ name: 'site', url, timeout_ms: 800, retries: 0 }] });
const two = () => ({ gotrip: site(), kervan: site() });
const alertLines = (o: { stateDir: string }): Array<Record<string, unknown>> => {
	try {
		return readFileSync(join(o.stateDir, 'alerts.log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
	} catch {
		return [];
	}
};

describe('monitor run --report', () => {
	it('sends exactly ONE message whatever the result: all healthy', async () => {
		const o = setup(two());
		const r = await runMonitor({ ...o, report: true });
		expect(telegramHits).toHaveLength(1);
		expect(sentText()).toContain('✅ 2/2 — hammasi ishlayapti');
		expect(r.telegram).toEqual({ outcome: 'Sent', reason: null });
		expect(r.items.every((i) => i.level === 'OK' && i.alert === null)).toBe(true);
	});

	it('sends exactly ONE message when something fails: no per-failure alert on top of the summary', async () => {
		targetStatus = 502;
		const o = setup(two());
		const r = await runMonitor({ ...o, report: true });
		expect(telegramHits).toHaveLength(1);
		const text = sentText();
		expect(text).toContain('❌ GoTrip — HTTP 502');
		expect(text).toContain('❌ Kervan — HTTP 502');
		expect(r.items.map((i) => [i.level, i.alert])).toEqual([['Critical / Down', null], ['Critical / Down', null]]);
		expect(telegramHits[0]).not.toContain(TOKEN.split(':')[1]!.slice(0, 8) + 'x'); // body has no token (it is only in the URL path)
		expect(alertLines(o)).toEqual([expect.objectContaining({ kind: 'report', outcome: 'Sent' })]);
	});

	it('writes the existing last-run.json schema (+ one optional telegram field), which `monitor status` reads', async () => {
		targetStatus = 500;
		const o = setup({ gotrip: site() });
		await runMonitor({ ...o, report: true });
		const file = JSON.parse(readFileSync(join(o.stateDir, 'last-run.json'), 'utf8')) as RunReport;
		expect(Object.keys(file).sort()).toEqual(['at', 'items', 'not_configured', 'telegram']);
		expect(file.items[0]).toMatchObject({ project_id: 'gotrip', level: 'Critical / Down' });
		expect(file.telegram).toEqual({ outcome: 'Sent', reason: null });
		expect(lastReport(o.stateDir)).toEqual(file);
		expect(JSON.stringify(file)).not.toContain(TOKEN);
	});

	it('a normal run still writes the same file without the telegram field', async () => {
		const o = setup({ gotrip: site() });
		await runMonitor(o);
		expect(Object.keys(JSON.parse(readFileSync(join(o.stateDir, 'last-run.json'), 'utf8'))).sort()).toEqual(['at', 'items', 'not_configured']);
	});

	it('--dry-run: the message goes to onReportMessage only, nothing is sent, the outcome is DryRun', async () => {
		targetStatus = 500;
		const o = setup({ gotrip: site() });
		const printed: string[] = [];
		const r = await runMonitor({ ...o, report: true, dryRun: true, onReportMessage: (t) => printed.push(t) });
		expect(telegramHits).toHaveLength(0);
		expect(printed).toHaveLength(1);
		expect(printed[0]).toContain('❌ GoTrip — HTTP 500');
		expect(r.telegram).toEqual({ outcome: 'DryRun', reason: null });
		expect(alertLines(o)).toEqual([]);
		expect(lastReport(o.stateDir)?.telegram?.outcome).toBe('DryRun');
	});

	it('without Telegram settings it does not fail: outcome not_configured', async () => {
		const o = setup({ gotrip: site() }, { telegram: null });
		const r = await runMonitor({ ...o, report: true });
		expect(r.telegram).toEqual({ outcome: 'not_configured', reason: null });
		expect(telegramHits).toHaveLength(0);
	});

	it('a Telegram error is Failed with a class only; the token and the reply never reach the report, file or log', async () => {
		telegramStatus = 401;
		const o = setup({ gotrip: site() });
		const r = await runMonitor({ ...o, report: true });
		expect(r.telegram).toEqual({ outcome: 'Failed', reason: 'http_401' });
		for (const file of ['last-run.json', 'alerts.log.jsonl']) expect(readFileSync(join(o.stateDir, file), 'utf8')).not.toContain(TOKEN);
	});

	it('does not break the alert behaviour: a report run neither alerts nor uses up the alert cool-down, and leaves the log unread', async () => {
		targetStatus = 500;
		const log = join(tempDir('report-log'), 'app.log');
		writeFileSync(log, `${new Date().toISOString()} INFO started\n`);
		const o = setup({ gotrip: { ...site(), logs: [{ name: 'app', path: log }] } });
		await runMonitor({ ...o }); // baseline: cursor at the end of the log, health alert sent
		expect(telegramHits).toHaveLength(1);
		telegramHits.length = 0;
		appendFileSync(log, `${new Date().toISOString()} ERROR payment failed password=${PW}\n`);

		await runMonitor({ ...o, report: true });
		expect(telegramHits).toHaveLength(1); // the summary only
		expect(sentText()).toContain('❌ GoTrip');
		expect(sentText()).not.toContain(PW);
		telegramHits.length = 0;

		const normal = await runMonitor({ ...o });
		const log1 = normal.items.find((i) => i.source === 'Repo / Log Check')!;
		expect(log1).toMatchObject({ level: 'Warning', alert: { outcome: 'Sent' } }); // the ERROR line was still unread
		expect(normal.items.find((i) => i.source === 'Health Check')!.alert).toMatchObject({ outcome: 'Deduplicated' }); // cool-down from the first normal run
	});
});

// ------------------------------------------------------------------ CLI

describe('cli: monitor run --report --dry-run', () => {
	it('prints the message on stdout, sends nothing and writes last-run.json', async () => {
		targetStatus = 503;
		const dir = tempDir('report-cli');
		const data = join(dir, 'data');
		mkdirSync(data, { recursive: true });
		writeFileSync(join(data, 'monitor.json'), JSON.stringify({ schema: 1, projects: { gotrip: site() } }));
		const env = { ...process.env, CODETRAIL_DATA_DIR: data, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT, CODETRAIL_TELEGRAM_API_BASE: telegramUrl };
		const run = (...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> =>
			new Promise((resolve) => {
				const child = spawn(process.execPath, [join(DIST, 'cli.js'), ...args], { env });
				let stdout = '';
				let stderr = '';
				child.stdout.on('data', (c) => (stdout += c));
				child.stderr.on('data', (c) => (stderr += c));
				child.on('close', (code) => resolve({ code, stdout, stderr }));
			});
		const dry = await run('monitor', 'run', '--report', '--dry-run');
		expect(dry.code).toBe(0);
		expect(dry.stdout).toMatch(/^📊 CodeTrail monitor — \d{4}-\d\d-\d\d \d\d:\d\d KST\n❌ GoTrip — HTTP 503\n➖ sozlanmagan: Kervan[^\n]*\n\n\{/);
		expect(dry.stdout).toContain('"outcome": "DryRun"');
		expect(telegramHits).toHaveLength(0);
		expect(dry.stdout + dry.stderr).not.toContain(TOKEN);
		expect(lastReport(join(data, 'monitor'))?.telegram?.outcome).toBe('DryRun');

		const real = await run('monitor', 'run', '--report');
		expect(real.code).toBe(0);
		expect(telegramHits).toHaveLength(1);
		expect(real.stdout).toContain('"outcome": "Sent"');
		expect(real.stdout + real.stderr).not.toContain(TOKEN);

		const watch = await run('monitor', 'watch', '--report');
		expect(watch.code).not.toBe(0); // a repeated summary would spam the chat
		expect(telegramHits).toHaveLength(1);
	});
});

// ------------------------------------------------------------------ web endpoints

const STUB_SERVICE = { list: () => [], generationModel: null } as unknown as AnswerService;
let servers: Server[] = [];
afterAll(async () => {
	for (const s of servers) await new Promise<void>((r) => void s.close(() => r()));
});

interface Api {
	base: string;
	o: RunOptions & { dir: string };
	logs: string[];
	call: (method: string, path: string, key?: string | null) => Promise<{ status: number; body: Record<string, unknown>; text: string; headers: Headers }>;
}
async function api(projects: Record<string, unknown>, opts: { key?: string | null; telegram?: boolean; intervalMs?: number; broken?: boolean } = {}): Promise<Api> {
	const o = setup(projects, { telegram: opts.telegram === false ? null : tg() });
	const logs: string[] = [];
	const monitor =
		opts.key === null
			? undefined
			: {
					accessKey: opts.key ?? KEY,
					check: () => {
						if (opts.broken) throw new CodeTrailError('USAGE', 'monitor config not found');
						return runMonitor({ ...o, report: true, lockTimeoutMs: 200 });
					},
					last: () => lastReport(o.stateDir),
					...(opts.intervalMs === undefined ? {} : { checkIntervalMs: opts.intervalMs }),
				};
	const server = createHttpServer(STUB_SERVICE, { ...(monitor ? { monitor } : {}), log: (l) => logs.push(l), webDir: o.dir });
	servers.push(server);
	const base = await listen(server);
	return {
		base,
		o,
		logs,
		async call(method, path, key = KEY) {
			const res = await fetch(`${base}${path}`, { method, headers: key ? { Authorization: `Bearer ${key}` } : {} });
			const text = await res.text();
			let body: Record<string, unknown> = {};
			try {
				body = JSON.parse(text) as Record<string, unknown>;
			} catch {
				/* not JSON */
			}
			return { status: res.status, body, text, headers: res.headers };
		},
	};
}

describe('/api/monitor/*', () => {
	it('is off unless the operator set an access key: 403 on both endpoints, and /api/projects says so', async () => {
		const a = await api({ gotrip: site() }, { key: null });
		expect((await a.call('POST', '/api/monitor/check', KEY)).status).toBe(403);
		expect((await a.call('GET', '/api/monitor/last', KEY)).body).toMatchObject({ error: { code: 'MONITOR_DISABLED' } });
		const projects = (await a.call('GET', '/api/projects', null)).body as { monitor: { available: boolean } };
		expect(projects.monitor).toEqual({ available: false });
		expect(telegramHits).toHaveLength(0);
	});

	it('both endpoints need the key: missing, wrong and malformed Authorization are 401 and run nothing', async () => {
		const a = await api({ gotrip: site() });
		for (const [method, path] of [['POST', '/api/monitor/check'], ['GET', '/api/monitor/last']] as const) {
			for (const key of [null, 'wrong-key-wrong-key-wrong', KEY.slice(0, -1), `${KEY}x`]) {
				const r = await a.call(method, path, key);
				expect(r.status).toBe(401);
				expect(r.body).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
			}
		}
		const basic = await fetch(`${a.base}/api/monitor/last`, { headers: { Authorization: `Basic ${Buffer.from(`u:${KEY}`).toString('base64')}` } });
		expect(basic.status).toBe(401);
		const query = await fetch(`${a.base}/api/monitor/last?key=${KEY}`);
		expect(query.status).toBe(401); // the key is never accepted in the URL
		expect(telegramHits).toHaveLength(0);
		expect(lastReport(a.o.stateDir)).toBeNull();
		expect((await a.call('GET', '/api/projects', null)).body).toMatchObject({ monitor: { available: true } });
	});

	it('compares the key in constant time and only as a Bearer token', () => {
		expect(bearerMatches(`Bearer ${KEY}`, KEY)).toBe(true);
		expect(bearerMatches(`bearer ${KEY}`, KEY)).toBe(false);
		expect(bearerMatches(KEY, KEY)).toBe(false);
		expect(bearerMatches(undefined, KEY)).toBe(false);
		expect(bearerMatches(`Bearer ${KEY} extra`, KEY)).toBe(false);
	});

	it('wrong methods are 405', async () => {
		const a = await api({ gotrip: site() });
		expect((await a.call('GET', '/api/monitor/check')).status).toBe(405);
		expect((await a.call('POST', '/api/monitor/last')).status).toBe(405);
	});

	it('POST check runs in report mode: items + telegram outcome, ONE Telegram message, same last-run.json for GET last', async () => {
		targetStatus = 502;
		const a = await api(two());
		const r = await a.call('POST', '/api/monitor/check');
		expect(r.status).toBe(200);
		const body = r.body as unknown as ReturnType<typeof publicReport>;
		expect(body.telegram).toEqual({ outcome: 'Sent', reason: null });
		expect(body.projects.map((p) => [p.project_id, p.status, p.reason])).toEqual([['gotrip', 'critical', 'HTTP 502'], ['kervan', 'critical', 'HTTP 502']]);
		expect(body.items).toHaveLength(2);
		expect(telegramHits).toHaveLength(1);
		expect(sentText()).toContain('❌ Kervan — HTTP 502');
		expect(r.text).not.toContain('analysis');

		const last = await a.call('GET', '/api/monitor/last');
		expect(last.status).toBe(200);
		expect(last.body).toEqual(body);
		expect(publicReport(lastReport(a.o.stateDir)!)).toEqual(body); // the file the CLI's `monitor status` prints
	});

	it('GET last with no run yet is an empty report, not an error', async () => {
		const a = await api({ gotrip: site() });
		expect((await a.call('GET', '/api/monitor/last')).body).toEqual({ at: null, projects: [], items: [], not_configured: [], telegram: null });
	});

	it('without Telegram settings the check still answers 200 with telegram.outcome not_configured', async () => {
		const a = await api({ gotrip: site() }, { telegram: false });
		const r = await a.call('POST', '/api/monitor/check');
		expect(r.status).toBe(200);
		expect(r.body.telegram).toEqual({ outcome: 'not_configured', reason: null });
		expect(r.body.projects).toEqual([expect.objectContaining({ project_id: 'gotrip', status: 'ok' })]);
	});

	it('a Telegram error is reported as Failed (200), never leaking the token or the key', async () => {
		telegramStatus = 401;
		const a = await api({ gotrip: site() });
		const r = await a.call('POST', '/api/monitor/check');
		expect(r.status).toBe(200);
		expect(r.body.telegram).toEqual({ outcome: 'Failed', reason: 'http_401' });
		expect(r.text).not.toContain(TOKEN);
		expect(r.text).not.toContain(KEY);
	});

	it('at most one check per minute: the second is 429 with Retry-After and sends nothing; GET last is not limited by it', async () => {
		const a = await api({ gotrip: site() });
		expect((await a.call('POST', '/api/monitor/check')).status).toBe(200);
		const second = await a.call('POST', '/api/monitor/check');
		expect(second.status).toBe(429);
		expect(second.body).toMatchObject({ error: { code: 'RATE_LIMITED' } });
		expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0);
		expect(Number(second.headers.get('retry-after'))).toBeLessThanOrEqual(60);
		expect(telegramHits).toHaveLength(1);
		expect((await a.call('GET', '/api/monitor/last')).status).toBe(200);
	});

	it('a check while another one is running is 409 MONITOR_BUSY (in this process)', async () => {
		targetDelayMs = 400;
		const a = await api({ gotrip: { health: [{ name: 'site', url: targetUrl, timeout_ms: 2000, retries: 0 }] } }, { intervalMs: 0 });
		const first = a.call('POST', '/api/monitor/check');
		await new Promise((r) => setTimeout(r, 100));
		const second = await a.call('POST', '/api/monitor/check');
		expect(second.status).toBe(409);
		expect(second.body).toMatchObject({ error: { code: 'MONITOR_BUSY' } });
		expect((await first).status).toBe(200);
		expect(telegramHits).toHaveLength(1);
	});

	it('a check while another process holds the monitor lock is 409, and that click does not use up the minute', async () => {
		const a = await api({ gotrip: site() });
		let release: () => void = () => {};
		const held = new Promise<void>((r) => (release = r));
		const holding = withLock(join(a.o.stateDir, 'locks'), 'monitor', { timeoutMs: 1000 }, () => held);
		await new Promise((r) => setTimeout(r, 50));
		const busy = await a.call('POST', '/api/monitor/check');
		expect(busy.status).toBe(409);
		expect(busy.body).toMatchObject({ error: { code: 'MONITOR_BUSY' } });
		release();
		await holding;
		expect((await a.call('POST', '/api/monitor/check')).status).toBe(200);
		expect(telegramHits).toHaveLength(1);
	});

	it('a missing monitor configuration is 503 MONITOR_NOT_CONFIGURED, not a crash', async () => {
		const a = await api({ gotrip: site() }, { broken: true });
		const r = await a.call('POST', '/api/monitor/check');
		expect(r.status).toBe(503);
		expect(r.body).toMatchObject({ error: { code: 'MONITOR_NOT_CONFIGURED' } });
	});

	it('guessing is slowed down: after 20 attempts a minute even the right key gets 429', async () => {
		const a = await api({ gotrip: site() });
		for (let i = 0; i < 20; i++) expect((await a.call('GET', '/api/monitor/last', `guess-${i}-guess-guess-guess`)).status).toBe(401);
		const r = await a.call('GET', '/api/monitor/last');
		expect(r.status).toBe(429);
	});

	it('the key and the token never appear in a response body or a log line', async () => {
		targetStatus = 500;
		const a = await api({ gotrip: site() });
		const seen: string[] = [];
		seen.push((await a.call('POST', '/api/monitor/check')).text, (await a.call('GET', '/api/monitor/last')).text, (await a.call('GET', '/api/monitor/last', 'nope-nope-nope-nope-nope')).text);
		seen.push(...a.logs, readFileSync(join(a.o.stateDir, 'last-run.json'), 'utf8'), readFileSync(join(a.o.stateDir, 'alerts.log.jsonl'), 'utf8'));
		for (const text of seen) {
			expect(text).not.toContain(KEY);
			expect(text).not.toContain(TOKEN);
			expect(text).not.toContain('nope-nope');
		}
		expect(a.logs.some((l) => l.startsWith('POST /api/monitor/check 200'))).toBe(true);
		expect(a.logs.some((l) => /GET \/api\/monitor\/last 401 .*unauthorized/.test(l))).toBe(true);
	});
});

describe('web UI wiring', () => {
	const js = readFileSync(join(import.meta.dirname, '..', 'web', 'app.js'), 'utf8');
	const i18n = readFileSync(join(import.meta.dirname, '..', 'web', 'i18n.js'), 'utf8');
	it('keeps the key out of storage and the URL, and sends it only as a Bearer header', () => {
		expect(js).toMatch(/Authorization: `Bearer \$\{state\.monitor\.key\}`/);
		expect(js).not.toMatch(/sessionStorage/);
		expect(js).not.toMatch(/localStorage\.setItem\([^)]*monitor/i);
		expect(js).not.toMatch(/\/api\/monitor\/[a-z]+\?/);
		expect(js).toMatch(/type = 'password'/);
	});
	it('every Monitor string exists in English and Korean', () => {
		const keys = [...i18n.matchAll(/'((?:nav|monitor)\.monitor?[^']*|monitor\.[^']+)':/g)].map((m) => m[1]);
		const unique = [...new Set(keys)];
		expect(unique.length).toBeGreaterThan(25);
		for (const k of unique) expect(i18n.split(`'${k}':`).length - 1, k).toBe(2);
	});
});

describe('Monitor table presentation', () => {
	const web = join(import.meta.dirname, '..', 'web');
	it('project names never break inside a word', () => {
		const css = readFileSync(join(web, 'style.css'), 'utf8');
		const rule = /\.monitor-name\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
		expect(rule).toMatch(/word-break:\s*normal/);
		expect(rule).toMatch(/overflow-wrap:\s*normal/);
		expect(rule).not.toMatch(/anywhere|break-all|break-word/);
	});

	it('the time column is short: "01:43 KST" today, the date only when it is not today', async () => {
		const { kstShort } = (await import(pathToFileURL(join(web, 'time.js')).href)) as { kstShort: (iso: string, now: number, locale?: string) => string };
		const now = Date.parse('2026-11-20T17:00:00Z'); // 2026-11-21 02:00 in Seoul
		expect(kstShort('2026-11-20T16:43:00Z', now)).toBe('01:43 KST'); // same Seoul day (the UTC date differs)
		expect(kstShort('2026-11-20T14:59:00Z', now)).toBe('20 Nov, 23:59 KST'); // 23:59 on the 20th in Seoul
		expect(kstShort('2026-11-18T00:00:00Z', now)).toBe('18 Nov, 09:00 KST');
		expect(kstShort('2026-11-21T00:05:00Z', Date.parse('2026-11-21T00:10:00Z'))).toBe('09:05 KST');
		expect(kstShort('not a date', now)).toBe('—');
		expect(kstShort('2026-11-20T16:43:00Z', now)).not.toMatch(/\d{4}|:\d\d:\d\d/); // no year, no seconds
	});

	it('the table uses the short time and the page serves the module', () => {
		const js = readFileSync(join(web, 'app.js'), 'utf8');
		expect(js).toContain("import { kstShort } from './time.js'");
		expect(js).toMatch(/const when = kstShort\(report\.at/);
	});
});
