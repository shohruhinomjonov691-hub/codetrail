/**
 * Redaction for everything the monitor shows, logs or sends (log excerpts, commit
 * subjects, error text). It removes secrets and anything that points at `.env`
 * files, and masks user home directories. It is pattern-based: like the snapshot
 * secret scanner it reduces the chance of a leak, it cannot guarantee there is none.
 */
const R = '[REDACTED]';

const RULES: readonly { pattern: RegExp; replace: string | ((m: string, ...g: string[]) => string) }[] = [
	{ pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, replace: R },
	// Telegram bot tokens: <digits>:<35 chars>, also inside a URL path (/bot<token>/)
	{ pattern: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, replace: R },
	{ pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: R },
	{ pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, replace: R },
	{ pattern: /\bsk-(?:ant-|proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}/g, replace: R },
	{ pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g, replace: R },
	{ pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: R },
	{ pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: R },
	// credentials in URLs: scheme://user:pass@host
	{ pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, replace: (_m, scheme) => `${scheme}${R}@` },
	{ pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: `Bearer ${R}` },
	// key = value / key: value for secret-looking keys (keeps the key, hides the value)
	{
		pattern: /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|session[_-]?id)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
		replace: (_m, key, sep) => `${key}${sep}${R}`,
	},
	// dotenv-style assignments (UPPER_CASE=value) are dropped whole
	{ pattern: /^[ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]{2,}=\S+[ \t]*$/gm, replace: '[REDACTED env assignment]' },
	// any mention of a .env file name
	{ pattern: /(?:^|[\s"'`(/\\])\.env(?:\.[A-Za-z0-9_-]+)*\b/g, replace: (m) => `${/^[\s"'`(/\\]/.test(m) ? m[0] : ''}[env-file]` },
	// long opaque strings (hex / base64-like) that are very likely keys or hashes of secrets
	{ pattern: /\b[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9])/g, replace: R },
	// user home directories
	{ pattern: /\/(?:Users|home)\/[^/\s"']+/g, replace: '~' },
];

/** Redacted text, with control characters removed. Idempotent. */
export function redactText(input: string): string {
	let out = input.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
	for (const { pattern, replace } of RULES) out = out.replace(pattern, replace as never);
	return out;
}

/** Redacted, whitespace-collapsed and cut to `max` characters (adds "…" when cut). */
export function brief(input: string, max: number): string {
	const t = redactText(input).replace(/\s+/g, ' ').trim();
	return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
}
