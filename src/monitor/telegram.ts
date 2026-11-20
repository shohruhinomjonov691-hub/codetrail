const TELEGRAM_BASE = 'https://api.telegram.org';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface TelegramConfig {
	token: string;
	chatId: string;
	/** Fixed to https://api.telegram.org; the only other accepted value is a plain-http loopback mock (tests). */
	apiBase?: string;
}

export type SendResult = { ok: true } | { ok: false; reason: 'not_configured' | 'timeout' | 'network' | `http_${number}` };

/** Telegram settings from the environment only; null when the token or chat id is missing. */
export function telegramFromEnv(env: NodeJS.ProcessEnv = process.env): TelegramConfig | null {
	const token = env.TELEGRAM_BOT_TOKEN?.trim();
	const chatId = env.TELEGRAM_CHAT_ID?.trim();
	if (!token || !chatId) return null;
	return { token, chatId, ...(env.CODETRAIL_TELEGRAM_API_BASE?.trim() ? { apiBase: env.CODETRAIL_TELEGRAM_API_BASE.trim() } : {}) };
}

export function validateTelegramBase(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error('Telegram API base is not a valid URL');
	}
	const bare = !url.username && !url.password && !url.search && !url.hash && (url.pathname === '/' || url.pathname === '');
	if (bare && url.protocol === 'https:' && url.host === 'api.telegram.org') return TELEGRAM_BASE;
	if (bare && url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return `${url.protocol}//${url.host}`;
	throw new Error('Telegram API base must be https://api.telegram.org (or a loopback mock)');
}

/**
 * Sends one plain-text message. The token appears only in the request URL path and is never part
 * of a result, error or log line; Telegram's reply body is not echoed. No redirects are followed.
 * One attempt: a failed send is reported as `Failed` by the caller and retried by the next run.
 */
export async function sendTelegram(cfg: TelegramConfig | null, text: string, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<SendResult> {
	if (!cfg) return { ok: false, reason: 'not_configured' };
	const base = validateTelegramBase(cfg.apiBase ?? TELEGRAM_BASE);
	try {
		const res = await fetchImpl(`${base}/bot${cfg.token}/sendMessage`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ chat_id: cfg.chatId, text: text.slice(0, 3500), disable_web_page_preview: 'true' }).toString(),
			redirect: 'error',
			signal: AbortSignal.timeout(timeoutMs),
		});
		void res.body?.cancel().catch(() => {});
		return res.ok ? { ok: true } : { ok: false, reason: `http_${res.status}` };
	} catch (err) {
		return { ok: false, reason: (err as { name?: string }).name === 'TimeoutError' ? 'timeout' : 'network' };
	}
}
