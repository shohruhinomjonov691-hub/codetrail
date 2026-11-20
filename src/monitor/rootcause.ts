import type { CheckResult } from './checks.js';
import type { RecentCommit } from './checks.js';
import { brief } from './redact.js';

/**
 * Root-cause analysis for a failed check, from evidence only:
 *   1. the check itself (HTTP status / error class, redacted log lines),
 *   2. recent commits of the project's repository (read-only `git log`),
 *   3. the project's own indexed code (keyword search over the snapshot; no model, no network),
 *   4. other failing checks of the same project in the same run.
 * It never changes anything: no commands are run on servers, no files are written, nothing is
 * restarted. Text that leaves this module is redacted (`brief`). The probable cause is a
 * hypothesis; the confidence level says how much independent evidence supports it:
 *   High          direct evidence plus at least two independent correlations
 *   Medium        direct evidence plus one correlation
 *   Low Evidence  direct evidence (an HTTP status or error log text) but no correlation
 *   Unconfirmed   only a bare failure (timeout, refused, DNS, slow, missing path): the cause is a guess
 * Correlations: (a) a file/symbol named in the failure text is a code hit in the project index,
 * (b) a commit from the last 72 h touched such a file, (c) a health and a log check of the same
 * project are failing together.
 */
export type Confidence = 'High' | 'Medium' | 'Low Evidence' | 'Unconfirmed';

export interface EvidenceItem {
	kind: 'health' | 'log' | 'commit' | 'code' | 'note';
	text: string;
}

export interface Analysis {
	confidence: Confidence;
	/** Probable cause (Uzbek, one or two sentences). */
	cause: string;
	evidence: EvidenceItem[];
	/** Suggested first steps. Suggestions only: nothing is executed. */
	steps: string[];
	correlations: { code_match: boolean; recent_commit: boolean; concurrent_failure: boolean };
}

export interface CodeHit {
	path: string;
	symbol: string | null;
	citation: string;
}

/** A file named in a failure ("path:42", or File "path", line 42), possibly with its line number. */
export interface FileRef {
	path: string;
	line?: number;
}

/**
 * Evidence from the project's indexed snapshot: first the chunks of the files the failure names (the
 * chunk holding the named line comes first), then a keyword search for the failure's terms. null when
 * the project has no usable index.
 */
export type RagSearch = (projectId: string, query: string, files?: FileRef[]) => Promise<CodeHit[] | null>;

export interface AnalyzeContext {
	projectName: string;
	commits: RecentCommit[];
	rag: RagSearch | null;
	/** Every result of this run for the same project (to spot a health + log failure together). */
	siblings: readonly CheckResult[];
}

// Longest extensions first and a word boundary after them: ".json" must not be read as ".js".
const FILE_RE = /([\w@./-]+\.(?:json|jsx?|tsx?|mjs|cjs|py|ya?ml|md))\b(?::(\d+))?/g;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const GENERIC_BASENAMES = new Set(['index.ts', 'index.js', 'index.tsx', 'main.py', 'app.py', '__init__.py', 'utils.py', 'utils.ts', 'package.json', 'readme.md']);

function normalize(p: string): string {
	return p.replace(/^\.\//, '').replace(/\\/g, '/');
}

/** `candidate` (from log text, maybe absolute) and `repoPath` (repo-relative) denote the same file by suffix. */
export function samePath(candidate: string, repoPath: string): boolean {
	const a = normalize(candidate);
	const b = normalize(repoPath);
	if (a === b) return true;
	const base = b.slice(b.lastIndexOf('/') + 1).toLowerCase();
	if (!b.includes('/') && (GENERIC_BASENAMES.has(base) || base.length < 6)) return a === b;
	return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/** Files named in the text, with a line number from "file:42" or a following ", line 42" (Python tracebacks). */
export function fileRefsIn(raw: string): FileRef[] {
	const text = raw.replace(URL_RE, ' '); // a URL's path is not a repository file
	const out = new Map<string, FileRef>();
	for (const m of text.matchAll(FILE_RE)) {
		const f = m[1] as string;
		if (/(^|\/)\.env/.test(f) || /^(?:https?|www)/i.test(f) || f.length >= 200 || out.has(f)) continue;
		const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 24);
		const line = Number(m[2] ?? /^["']?,?\s*line\s+(\d+)/i.exec(after)?.[1]);
		out.set(f, Number.isInteger(line) && line > 0 ? { path: f, line } : { path: f });
	}
	return [...out.values()].slice(0, 12);
}

function terms(text: string): string[] {
	const words = (text.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? []).filter((w) => !/^(error|errors|exception|traceback|file|line|most|recent|call|last|true|false|none|null|undefined|this|that|with|from|have|failed|failure|redacted|password|token|secret)$/i.test(w));
	return [...new Set(words)].slice(0, 14);
}

const CAUSE: Record<string, { cause: string; steps: string[] }> = {
	refused: { cause: 'server jarayoni ishlamayapti yoki port yopiq (connection refused).', steps: ['Serverda servis/konteyner holatini tekshiring (masalan, docker compose ps yoki systemctl status).', 'Servis oxirgi loglarini o‘qing.'] },
	timeout: { cause: 'server javob bermayapti (ortiqcha yuklanish yoki osilib qolgan jarayon bo‘lishi mumkin).', steps: ['Serverda CPU/xotira va servis loglarini tekshiring.', 'Servis jarayoni tirik ekanini tekshiring.'] },
	dns: { cause: 'domen nomi DNS orqali topilmayapti.', steps: ['DNS yozuvini va domen muddatini tekshiring.'] },
	tls: { cause: 'TLS sertifikati muddati tugagan yoki noto‘g‘ri.', steps: ['Sertifikat muddatini va zanjirini tekshiring.'] },
	network: { cause: 'tarmoq xatosi (sabab aniqlanmadi).', steps: ['Boshqa tarmoqdan manzilni qo‘lda tekshiring.', 'Server loglarini ko‘ring.'] },
	'5xx-proxy': { cause: 'reverse proxy ilovaga ulana olmayapti (upstream ishlamayapti yoki qayta ishga tushmoqda).', steps: ['Ilova konteyneri/jarayoni ishlayotganini tekshiring.', 'Proxy upstream porti to‘g‘riligini tekshiring.'] },
	'5xx': { cause: 'ilova ichki xato qaytarmoqda.', steps: ['Ilova loglarida stack trace qidiring.', 'Xato vaqtini oxirgi deploy bilan solishtiring.'] },
	'4xx': { cause: 'manzil o‘zgargan yoki ruxsat (auth) talab qilinmoqda.', steps: ['monitor.json dagi health URL va kutilgan statusni tekshiring.'] },
	slow: { cause: 'javob sekin (yuklanish yoki sekin bog‘liq xizmat).', steps: ['Server yuklanishini va sekin so‘rovlarni tekshiring.'] },
	log: { cause: 'ilova loglarida xato yozilgan.', steps: ['Log yozuvi vaqtini oxirgi deploy/commit bilan solishtiring.', 'Xato qaytalansa, stack trace asosida tegishli kodni ko‘ring.'] },
	'log-missing': { cause: 'log fayli topilmayapti (yo‘l noto‘g‘ri yoki log yozilmayapti).', steps: ['monitor.json dagi log yo‘lini va servisning log sozlamasini tekshiring.'] },
	repo: { cause: 'repo yo‘li o‘zgargan yoki git ombori o‘qilmayapti.', steps: ['monitor.json dagi repo.path ni va git holatini tekshiring.'] },
};

function classify(r: CheckResult): keyof typeof CAUSE {
	const f = r.facts;
	if (r.source === 'Health Check') {
		if (f.error_class && f.error_class !== 'http') return f.error_class;
		if (r.fingerprint === 'slow') return 'slow';
		if (f.status && [502, 503, 504].includes(f.status)) return '5xx-proxy';
		if (f.status && f.status >= 500) return '5xx';
		return '4xx';
	}
	if (r.fingerprint === 'log-missing' || r.fingerprint === 'log-unreadable') return 'log-missing';
	if (r.fingerprint.startsWith('repo-')) return 'repo';
	return 'log';
}

export async function analyze(r: CheckResult, ctx: AnalyzeContext): Promise<Analysis> {
	const kind = classify(r);
	const evidence: EvidenceItem[] = [];
	const f = r.facts;

	// 1. direct evidence
	if (r.source === 'Health Check') evidence.push({ kind: 'health', text: brief(`${r.summary}${f.status ? ` · HTTP ${f.status}` : ''}${f.latency_ms !== undefined ? ` · ${f.latency_ms} ms` : ''}`, 200) });
	for (const l of f.log_lines ?? []) evidence.push({ kind: 'log', text: brief(l, 220) });
	if (r.source === 'Repo / Log Check' && !f.log_lines) evidence.push({ kind: 'note', text: brief(r.summary, 160) });
	const direct = Boolean(f.log_lines?.length) || (r.source === 'Health Check' && f.status !== undefined && kind !== 'slow');

	// text the failure points at
	const failureText = [...(f.log_lines ?? []), f.url ? new URL(f.url).pathname : ''].join('\n');
	const refs = fileRefsIn(failureText);
	const files = refs.map((r) => r.path);
	const words = terms(failureText);

	// 3. code (RAG, keyword search only)
	let codeMatch = false;
	let matchedPaths: string[] = [];
	if (ctx.rag && (files.length || words.length)) {
		let hits: CodeHit[] | null = null;
		try {
			hits = await ctx.rag(r.project_id, [...files, ...words].join(' '), refs);
		} catch {
			hits = null;
		}
		if (hits === null) evidence.push({ kind: 'note', text: 'Kod indeksi mavjud emas yoki o‘qilmadi — kod bo‘yicha dalil yo‘q.' });
		else {
			const matched = hits.filter((h) => files.some((c) => samePath(c, h.path)) || (h.symbol !== null && h.symbol.length >= 5 && new RegExp(`\\b${h.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(failureText)));
			codeMatch = matched.length > 0;
			matchedPaths = matched.map((h) => h.path);
			for (const h of (codeMatch ? matched : []).slice(0, 3)) evidence.push({ kind: 'code', text: brief(h.citation, 200) });
			if (!codeMatch && hits.length) evidence.push({ kind: 'note', text: 'Qidiruv natijalari xato matnidagi fayl/simvollarga mos kelmadi (bog‘lanmagan).' });
		}
	} else if (!ctx.rag) evidence.push({ kind: 'note', text: 'Kod indeksi ulanmagan — kod bo‘yicha dalil yo‘q.' });

	// 2. recent commits
	let commitMatch: RecentCommit | null = null;
	for (const c of ctx.commits) {
		if (c.files.some((cf) => files.some((f2) => samePath(f2, cf)) || matchedPaths.some((mp) => samePath(mp, cf)))) {
			commitMatch = c;
			break;
		}
	}
	for (const c of (commitMatch ? [commitMatch] : ctx.commits.slice(0, 2))) evidence.push({ kind: 'commit', text: brief(`${c.hash} ${c.when.slice(0, 10)} «${c.subject}»${commitMatch ? ' — xatodagi faylga tegadi' : ' (bog‘lanmagan)'}`, 200) });

	// 4. concurrent failures of the same project
	const concurrent = ctx.siblings.some((s) => s !== r && s.severity !== 'ok' && s.source !== r.source && (s.source === 'Repo / Log Check' ? Boolean(s.facts.log_lines?.length) : s.facts.status !== undefined || s.facts.error_class !== undefined));
	if (concurrent) evidence.push({ kind: 'note', text: 'Shu loyihada health va log tekshiruvi birga xato bermoqda.' });

	const n = Number(codeMatch) + Number(commitMatch !== null) + Number(concurrent);
	const confidence: Confidence = direct && n >= 2 ? 'High' : direct && n === 1 ? 'Medium' : direct ? 'Low Evidence' : 'Unconfirmed';

	const base = CAUSE[kind] as { cause: string; steps: string[] };
	let cause = base.cause;
	if (kind === 'log' && f.log_lines?.[0]) cause = `loglarda xato: «${brief(f.log_lines[0], 110)} ».`;
	if (commitMatch) cause += ` Oxirgi o‘zgarish ${commitMatch.hash} («${commitMatch.subject}») xatodagi faylga tegadi.`;
	return { confidence, cause: brief(cause, 320), evidence, steps: [...base.steps], correlations: { code_match: codeMatch, recent_commit: commitMatch !== null, concurrent_failure: concurrent } };
}
