import { PROJECT_CATALOG } from '../catalog.js';
import { brief } from './redact.js';
import type { ReportItem, RunReport } from './run.js';

/** Per-project verdict of one run: the worst level of its checks. */
export type ProjectStatus = 'ok' | 'warning' | 'critical';

export interface ProjectSummary {
	project_id: string;
	name: string;
	status: ProjectStatus;
	/** Short, redacted reason; empty when ok. */
	reason: string;
}

const ORDER = new Map(PROJECT_CATALOG.map((p, i) => [p.id, i]));
const MARK: Record<ProjectStatus, string> = { ok: '✅', warning: '⚠️', critical: '❌' };
const rank = (level: ReportItem['level']): number => (level === 'Critical / Down' ? 2 : level === 'Warning' ? 1 : 0);

/** The check's own text without its "<name>: " prefix, e.g. "TLS/certificate error", "HTTP 502". */
export function shortReason(item: Pick<ReportItem, 'check' | 'summary'>): string {
	const s = item.summary.startsWith(`${item.check}: `) ? item.summary.slice(item.check.length + 2) : item.summary;
	return brief(s, 80);
}

/** One row per checked project, in catalog order. Projects with nothing configured are not included. */
export function summarizeProjects(report: Pick<RunReport, 'items'>): ProjectSummary[] {
	const byProject = new Map<string, ReportItem[]>();
	for (const it of report.items) byProject.set(it.project_id, [...(byProject.get(it.project_id) ?? []), it]);
	return [...byProject.entries()]
		.sort(([a], [b]) => (ORDER.get(a) ?? 99) - (ORDER.get(b) ?? 99))
		.map(([id, items]): ProjectSummary => {
			const worst = Math.max(...items.map((i) => rank(i.level)));
			const bad = items.filter((i) => rank(i.level) > 0).sort((a, b) => rank(b.level) - rank(a.level));
			const reasons = bad.slice(0, 2).map(shortReason);
			if (bad.length > 2) reasons.push(`+${bad.length - 2}`);
			return { project_id: id, name: items[0]?.project ?? id, status: worst === 2 ? 'critical' : worst === 1 ? 'warning' : 'ok', reason: reasons.join('; ') };
		});
}

/** "2026-11-21 09:00 KST": Asia/Seoul is a fixed UTC+9 (no daylight saving), so no time-zone database is needed. */
export function kstStamp(ms: number): string {
	return `${new Date(ms + 9 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')} KST`;
}

/**
 * The one daily-report Telegram message. Only redacted, short check text goes in; the bot token and
 * chat id never reach this function.
 *   📊 CodeTrail monitor — 2026-11-21 09:00 KST
 *   ✅ GoTrip · ✅ Camera Studio · …
 *   ❌ Kervan — TLS/certificate error
 * Everything healthy: "✅ 6/6 — hammasi ishlayapti".
 */
export function formatReportMessage(report: Pick<RunReport, 'at' | 'items' | 'not_configured'>): string {
	const rows = summarizeProjects(report);
	const names = new Map(PROJECT_CATALOG.map((p) => [p.id, p.name]));
	const lines = [`📊 CodeTrail monitor — ${kstStamp(Date.parse(report.at))}`];
	const ok = rows.filter((r) => r.status === 'ok');
	const bad = rows.filter((r) => r.status !== 'ok');
	if (rows.length === 0) lines.push('➖ tekshiriladigan loyiha sozlanmagan');
	else if (bad.length === 0) lines.push(`✅ ${ok.length}/${rows.length} — hammasi ishlayapti`);
	else {
		if (ok.length) lines.push(ok.map((r) => `${MARK.ok} ${r.name}`).join(' · '));
		for (const r of bad) lines.push(`${MARK[r.status]} ${r.name} — ${r.reason || 'xato'}`);
	}
	if (report.not_configured.length) lines.push(`➖ sozlanmagan: ${report.not_configured.map((id) => names.get(id) ?? id).join(', ')}`);
	return lines.join('\n');
}

/**
 * What the web API returns: the run time, one verdict per project, the redacted per-check lines and
 * the Telegram outcome. Root-cause analysis and every other detail of last-run.json stay out.
 */
export function publicReport(report: RunReport): {
	at: string;
	projects: ProjectSummary[];
	items: Array<Pick<ReportItem, 'project_id' | 'project' | 'source' | 'check' | 'level'> & { summary: string }>;
	not_configured: string[];
	telegram: RunReport['telegram'] | null;
} {
	return {
		at: report.at,
		projects: summarizeProjects(report),
		items: report.items.map((i) => ({ project_id: i.project_id, project: i.project, source: i.source, check: i.check, level: i.level, summary: brief(i.summary, 160) })),
		not_configured: report.not_configured,
		telegram: report.telegram ?? null,
	};
}
