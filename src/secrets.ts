/**
 * Secret scanner. Runs on every candidate file BEFORE anything is persisted or
 * sent anywhere. It reports only detector names and counts — never the
 * matched value, the line, or an excerpt — so findings can be logged safely.
 *
 * - high: unambiguous credential formats → the whole snapshot is BLOCKED.
 * - medium: heuristic assignments → that file is excluded from the snapshot.
 */
export const SECRET_SCANNER_VERSION = 1;

export type Confidence = 'high' | 'medium';

interface Detector {
	name: string;
	confidence: Confidence;
	pattern: RegExp;
	/** Optional extra check on the captured value (group 1, else whole match). */
	accept?: (value: string) => boolean;
}

const PLACEHOLDER =
	/(your|example|sample|dummy|placeholder|changeme|change_me|replace|redacted|xxxx|\*\*\*|<[^>]*>|\$\{|\{\{|process\.env|import\.meta\.env|test|fake|mock|todo)/i;

function entropy(value: string): number {
	const counts = new Map<string, number>();
	for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	let h = 0;
	for (const n of counts.values()) {
		const p = n / value.length;
		h -= p * Math.log2(p);
	}
	return h;
}

const DETECTORS: readonly Detector[] = [
	{ name: 'private-key', confidence: 'high', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
	{ name: 'aws-access-key-id', confidence: 'high', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
	{ name: 'github-token', confidence: 'high', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255})\b/g },
	{ name: 'anthropic-key', confidence: 'high', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
	{ name: 'openai-key', confidence: 'high', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}|\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}/g },
	{ name: 'google-api-key', confidence: 'high', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	{ name: 'slack-token', confidence: 'high', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
	{ name: 'stripe-live-key', confidence: 'high', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g },
	{ name: 'npm-token', confidence: 'high', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
	{
		name: 'credential-url',
		confidence: 'high',
		pattern: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|rediss|amqps?|https?|ftp):\/\/[^\s:/@'"`]+:([^\s@'"`/]+)@[^\s'"`]+/g,
		accept: (password) => !PLACEHOLDER.test(password) && !/^(password|pass|pwd|user|secret)$/i.test(password),
	},
	{
		name: 'jwt',
		confidence: 'high',
		pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}/g,
	},
	{
		name: 'generic-secret-assignment',
		confidence: 'medium',
		pattern:
			/\b[A-Za-z0-9_]*(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|token)[A-Za-z0-9_]*["']?\s*[:=]\s*["'`]([^"'`\s]{12,})["'`]/gi,
		accept: (value) => !PLACEHOLDER.test(value) && entropy(value) >= 3.5 && /\d/.test(value) && /[A-Za-z]/.test(value),
	},
];

export interface SecretFinding {
	detector: string;
	confidence: Confidence;
	count: number;
}

export function scanText(text: string): SecretFinding[] {
	const findings: SecretFinding[] = [];
	for (const detector of DETECTORS) {
		let count = 0;
		for (const match of text.matchAll(detector.pattern)) {
			const value = match[1] ?? match[0];
			if (!detector.accept || detector.accept(value)) count++;
		}
		if (count > 0) findings.push({ detector: detector.name, confidence: detector.confidence, count });
	}
	return findings;
}

export function scannerFingerprint(): unknown {
	return { version: SECRET_SCANNER_VERSION, detectors: DETECTORS.map((d) => [d.name, d.confidence, d.pattern.source]) };
}
