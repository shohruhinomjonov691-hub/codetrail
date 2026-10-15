import { OpenAIResponsesProvider } from './openai.js';
import type { GenerationProvider } from './provider.js';

/**
 * Generation settings (backend only — nothing here is sent to the browser):
 *   CODETRAIL_OPENAI_API_KEY      API key; without it the AI explanation is unavailable and search still works
 *   CODETRAIL_OPENAI_MODEL        model id (default gpt-6-luna)
 *   CODETRAIL_OPENAI_REASONING    reasoning effort: none|low|medium|high (default low)
 *   CODETRAIL_OPENAI_BASE_URL     https://api.openai.com (default) or a loopback mock for local checks
 *   CODETRAIL_AI_MAX_OUTPUT_TOKENS  max output incl. reasoning (default 2048)
 *   CODETRAIL_AI_MAX_CONTEXT_CHARS  max excerpt characters per request (default 12000)
 *   CODETRAIL_AI_TIMEOUT_MS       per-request timeout (default 30000)
 *   CODETRAIL_AI_CONCURRENCY      parallel generation calls (default 2)
 *   CODETRAIL_AI_RATE_PER_MINUTE  explanations per client per minute (default 6)
 *   CODETRAIL_AI_DAILY_LIMIT      explanations per server per UTC day (default 200)
 *   CODETRAIL_AI_CACHE_SIZE       cached answers kept in memory (default 500)
 */
export interface GenerationSettings {
	apiKey: string;
	model: string;
	reasoningEffort: string;
	baseUrl: string | undefined;
	maxOutputTokens: number;
	maxContextChars: number;
	timeoutMs: number;
	concurrency: number;
	ratePerMinute: number;
	dailyLimit: number;
	cacheSize: number;
}

export const DEFAULT_MODEL = 'gpt-6-luna';
const REASONING = new Set(['none', 'low', 'medium', 'high']);

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
	const raw = env[name]?.trim();
	if (!raw) return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
	return n;
}

export function generationSettings(env: NodeJS.ProcessEnv = process.env): GenerationSettings {
	const reasoningEffort = env.CODETRAIL_OPENAI_REASONING?.trim() || 'low';
	if (!REASONING.has(reasoningEffort)) throw new Error('CODETRAIL_OPENAI_REASONING must be none, low, medium or high');
	return {
		apiKey: env.CODETRAIL_OPENAI_API_KEY?.trim() ?? '',
		model: env.CODETRAIL_OPENAI_MODEL?.trim() || DEFAULT_MODEL,
		reasoningEffort,
		baseUrl: env.CODETRAIL_OPENAI_BASE_URL?.trim() || undefined,
		maxOutputTokens: intEnv(env, 'CODETRAIL_AI_MAX_OUTPUT_TOKENS', 2048, 256, 8192),
		maxContextChars: intEnv(env, 'CODETRAIL_AI_MAX_CONTEXT_CHARS', 12000, 1000, 60000),
		timeoutMs: intEnv(env, 'CODETRAIL_AI_TIMEOUT_MS', 30000, 1000, 120000),
		concurrency: intEnv(env, 'CODETRAIL_AI_CONCURRENCY', 2, 1, 16),
		ratePerMinute: intEnv(env, 'CODETRAIL_AI_RATE_PER_MINUTE', 6, 1, 600),
		dailyLimit: intEnv(env, 'CODETRAIL_AI_DAILY_LIMIT', 200, 1, 100000),
		cacheSize: intEnv(env, 'CODETRAIL_AI_CACHE_SIZE', 500, 0, 100000),
	};
}

/** The OpenAI provider, or null when no key is configured (the explanation then reports `not_configured`). */
export function createGenerationProvider(settings: GenerationSettings, fetchImpl?: typeof fetch): GenerationProvider | null {
	if (!settings.apiKey) return null;
	return new OpenAIResponsesProvider({
		apiKey: settings.apiKey,
		model: settings.model,
		reasoningEffort: settings.reasoningEffort,
		timeoutMs: settings.timeoutMs,
		...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
		...(fetchImpl ? { fetchImpl } : {}),
	});
}
