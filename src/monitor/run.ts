import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_CATALOG } from '../catalog.js';
import { withLock } from '../lock.js';
import { healthCheck, logCheck, recentCommits, repoCheck, type CheckResult, type LogCursor, type Severity } from './checks.js';
import type { MonitorConfig } from './config.js';
import { brief } from './redact.js';
import { formatReportMessage } from './report.js';
import { analyze, type Analysis, type RagSearch } from './rootcause.js';
import { sendTelegram, type SendResult, type TelegramConfig } from './telegram.js';

export type AlertOutcome = 'Sent' | 'Deduplicated' | 'Failed' | 'DryRun';

interface AlertEntry {
	first_sent: string;
	last_sent: string;
	suppressed: number;
}
interface CheckState {
	ok_streak: number;
	cursor?: LogCursor;
}
export interface MonitorState {
	schema: 1;
	alerts: Record<string, AlertEntry>;
	checks: Record<string, CheckState>;
}

export interface ReportItem {
	project_id: string;
	project: string;
	source: CheckResult['source'];
	check: string;
	level: 'OK' | 'Warning' | 'Critical / Down';
	summary: string;
	analysis: Analysis | null;
	alert: { outcome: AlertOutcome; reason: string | null } | null;
}

/** What happened to the one summary message of a `--report` run. */
export interface ReportTelegram {
	outcome: 'Sent' | 'Failed' | 'DryRun' | 'not_configured';
	/** Failure class only (`http_401`, `timeout`, `network`); never the token or Telegram's reply. */
	reason: string | null;
}

export interface RunReport {
	at: string;
	items: ReportItem[];
	/** Projects with nothing configured to check (never an alert: unknown is not failing). */
	not_configured: string[];
	/** Present only when the run was a `--report` run. Same file, same schema, one optional field. */
	telegram?: ReportTelegram;
}

export interface RunOptions {
	dataDir: string;
	stateDir: string;
	config: MonitorConfig;
	/** Limit to these project ids (default: every configured project). */
	only?: readonly string[];
	telegram: TelegramConfig | null;
	fetchImpl?: typeof fetch;
	rag?: RagSearch | null;
	/** Evaluate and report, but send nothing and record no alert state. */
	dryRun?: boolean;
	now?: () => number;
	log?: (line: string) => void;
	retryDelayMs?: number;
	/**
	 * Report mode: run every check, then send ONE summary message whatever the outcome. Individual failure
	 * alerts are not sent in this mode (the summary carries them), no alert state changes and log cursors
	 * are left where they were, so the next normal run still alerts on what this one only reported.
	 */
	report?: boolean;
	/** Called with the summary text in report mode just before it is sent, or instead of sending when dryRun. */
	onReportMessage?: (text: string) => void;
	/** How long to wait for another run to finish before giving up with LOCK_TIMEOUT (default 15 s). */
	lockTimeoutMs?: number;
}

const LEVEL: Record<Severity, ReportItem['level']> = { ok: 'OK', warning: 'Warning', critical: 'Critical / Down' };

function emptyState(): MonitorState {
	return { schema: 1, alerts: {}, checks: {} };
}

export function loadState(stateDir: string): MonitorState {
	try {
		const v = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8')) as MonitorState;
		if (v.schema === 1 && v.alerts && v.checks) return v;
	} catch {
		/* first run or unreadable: start empty */
	}
	return emptyState();
}

function saveJson(stateDir: string, name: string, value: unknown): void {
	mkdirSync(stateDir, { recursive: true });
	const tmp = join(stateDir, `${name}.${process.pid}.tmp`);
	writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
	renameSync(tmp, join(stateDir, name));
}

export function lastReport(stateDir: string): RunReport | null {
	try {
		return JSON.parse(readFileSync(join(stateDir, 'last-run.json'), 'utf8')) as RunReport;
	} catch {
		return null;
	}
}

/** Same incident = same project, source, check, severity and failure class. */
export function alertKey(r: CheckResult): string {
	return createHash('sha256').update([r.project_id, r.source, r.check, r.severity, r.fingerprint].join('|')).digest('hex').slice(0, 20);
}

/** The short Telegram text: Muammo / Ehtimoliy sabab / Nima qilish kerak. Redacted, plain text. */
export function formatMessage(projectName: string, r: CheckResult, a: Analysis): string {
	const head = `${r.severity === 'critical' ? '🔴 Critical / Down' : '🟠 Warning'} · ${r.source}`;
	return [
		head,
		`Muammo: ${projectName} — ${brief(r.summary, 220)}`,
		`Ehtimoliy sabab (${a.confidence}): ${brief(a.cause, 360)}`,
		`Nima qilish kerak: ${brief(a.steps[0] ?? 'Loglarni tekshiring.', 220)}`,
	].join('\n');
}

/** One monitoring pass over the configured projects. Sends Telegram alerts for failures only. */
export async function runMonitor(opts: RunOptions): Promise<RunReport> {
	const now = opts.now ?? Date.now;
	const log = opts.log ?? (() => {});
	const names = new Map(PROJECT_CATALOG.map((p) => [p.id, p.name]));
	const ids = PROJECT_CATALOG.map((p) => p.id).filter((id) => !opts.only || opts.only.includes(id));
	mkdirSync(opts.stateDir, { recursive: true });
	return withLock(join(opts.stateDir, 'locks'), 'monitor', { timeoutMs: opts.lockTimeoutMs ?? 15_000 }, async () => {
		const state = loadState(opts.stateDir);
		const items: ReportItem[] = [];
		const notConfigured: string[] = [];
		const stamp = new Date(now()).toISOString();

		for (const id of ids) {
			const cfg = opts.config.projects[id];
			if (!cfg || (cfg.health.length === 0 && cfg.logs.length === 0 && !cfg.repo)) {
				notConfigured.push(id);
				continue;
			}
			const results: CheckResult[] = [];
			// A log check whose alert could not be sent must be read again by the next run: undo its cursor move.
			const undoCursor = new Map<CheckResult, () => void>();
			for (const h of cfg.health) results.push(await healthCheck(id, h, opts.fetchImpl, opts.retryDelayMs));
			if (cfg.repo) results.push(await repoCheck(id, cfg.repo.path));
			for (const l of cfg.logs) {
				const key = `${id}|Repo / Log Check|${l.name}`;
				const before = state.checks[key]?.cursor ?? null;
				const { result, cursor } = logCheck(id, l, before, now());
				if (cursor) (state.checks[key] ??= { ok_streak: 0 }).cursor = cursor;
				undoCursor.set(result, () => {
					const cs = state.checks[key];
					if (!cs) return;
					if (before) cs.cursor = before;
					else delete cs.cursor;
				});
				results.push(result);
			}
			// A report run only observes: it must not consume log lines the next normal run should alert on.
			if (opts.report) for (const undo of undoCursor.values()) undo();
			const commits = cfg.repo && results.some((r) => r.severity !== 'ok') ? await recentCommits(cfg.repo.path) : [];

			for (const r of results) {
				const ckey = `${id}|${r.source}|${r.check}`;
				const cs = (state.checks[ckey] ??= { ok_streak: 0 });
				if (r.severity === 'ok') {
					cs.ok_streak++;
					// Two healthy runs in a row end the incident: the next failure alerts at once.
					if (cs.ok_streak >= 2) for (const k of Object.keys(state.alerts)) if (state.alerts[k] && k.startsWith(`${ckey}#`)) delete state.alerts[k];
					items.push({ project_id: id, project: names.get(id) as string, source: r.source, check: r.check, level: 'OK', summary: r.summary, analysis: null, alert: null });
					continue;
				}
				cs.ok_streak = 0;
				const analysis = await analyze(r, { projectName: names.get(id) as string, commits, rag: opts.rag ?? null, siblings: results });
				if (opts.report) {
					items.push({ project_id: id, project: names.get(id) as string, source: r.source, check: r.check, level: LEVEL[r.severity], summary: brief(r.summary, 240), analysis, alert: null });
					continue;
				}
				const key = `${ckey}#${alertKey(r)}`;
				const cooldownMs = (r.severity === 'critical' ? opts.config.cooldown_minutes.critical : opts.config.cooldown_minutes.warning) * 60_000;
				const prev = state.alerts[key];
				let outcome: AlertOutcome;
				let reason: string | null = null;
				if (prev && now() - Date.parse(prev.last_sent) < cooldownMs) {
					outcome = 'Deduplicated';
					prev.suppressed++;
				} else if (opts.dryRun) outcome = 'DryRun';
				else {
					const sent: SendResult = await sendTelegram(opts.telegram, formatMessage(names.get(id) as string, r, analysis), opts.fetchImpl);
					if (sent.ok) {
						outcome = 'Sent';
						state.alerts[key] = { first_sent: prev?.first_sent ?? stamp, last_sent: stamp, suppressed: prev?.suppressed ?? 0 };
					} else {
						// A failed send is not recorded as sent: the next run tries again (a log is re-read from the same place).
						outcome = 'Failed';
						reason = sent.reason;
						undoCursor.get(r)?.();
					}
				}
				if (outcome !== 'DryRun') {
					try {
						appendFileSync(join(opts.stateDir, 'alerts.log.jsonl'), JSON.stringify({ at: stamp, project_id: id, source: r.source, check: r.check, severity: r.severity, outcome, reason }) + '\n');
					} catch {
						/* the log must not break the run */
					}
				}
				log(`alert ${outcome} project=${id} source=${r.source.replace(/ \/ /g, '-').replace(/ /g, '-')} severity=${r.severity}${reason ? ` reason=${reason}` : ''}`);
				items.push({ project_id: id, project: names.get(id) as string, source: r.source, check: r.check, level: LEVEL[r.severity], summary: brief(r.summary, 240), analysis, alert: { outcome, reason } });
			}
		}

		// forget alert entries older than 7 days
		for (const [k, v] of Object.entries(state.alerts)) if (now() - Date.parse(v.last_sent) > 7 * 86_400_000) delete state.alerts[k];
		const report: RunReport = { at: stamp, items, not_configured: notConfigured };
		if (opts.report) {
			const text = formatReportMessage(report);
			opts.onReportMessage?.(text);
			let telegram: ReportTelegram;
			if (opts.dryRun) telegram = { outcome: 'DryRun', reason: null };
			else {
				const sent: SendResult = await sendTelegram(opts.telegram, text, opts.fetchImpl);
				telegram = sent.ok ? { outcome: 'Sent', reason: null } : sent.reason === 'not_configured' ? { outcome: 'not_configured', reason: null } : { outcome: 'Failed', reason: sent.reason };
				try {
					appendFileSync(join(opts.stateDir, 'alerts.log.jsonl'), JSON.stringify({ at: stamp, kind: 'report', outcome: telegram.outcome, reason: telegram.reason }) + '\n');
				} catch {
					/* the log must not break the run */
				}
			}
			report.telegram = telegram;
			log(`report ${telegram.outcome}${telegram.reason ? ` reason=${telegram.reason}` : ''}`);
		}
		if (!opts.dryRun) saveJson(opts.stateDir, 'state.json', state);
		saveJson(opts.stateDir, 'last-run.json', report);
		return report;
	});
}
