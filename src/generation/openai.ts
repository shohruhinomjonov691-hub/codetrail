import { GenerationError, type GenerationProvider, type GenerationRequest, type GenerationResult } from './provider.js';

const OPENAI_BASE_URL = 'https://api.openai.com';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * The API base URL is fixed to https://api.openai.com. The only other accepted
 * value is a plain-http loopback URL, used by the local mock provider in tests and
 * UI checks; anything else (other hosts, credentials, paths, query) is rejected.
 */
export function validateOpenAIBaseUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error('OpenAI base URL is not a valid URL');
	}
	const bare = !url.username && !url.password && !url.search && !url.hash && (url.pathname === '/' || url.pathname === '');
	if (bare && url.protocol === 'https:' && url.host === 'api.openai.com') return OPENAI_BASE_URL;
	if (bare && url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return `${url.protocol}//${url.host}`;
	throw new Error('OpenAI base URL must be https://api.openai.com (or a loopback mock)');
}

export interface OpenAIProviderOptions {
	apiKey: string;
	model: string;
	/** Reasoning effort passed to the model ("none" sends no reasoning field). */
	reasoningEffort: string;
	timeoutMs: number;
	baseUrl?: string;
	fetchImpl?: typeof fetch;
}

interface ResponsesOutputContent {
	type: string;
	text?: string;
	refusal?: string;
}

interface ResponsesBody {
	status?: string;
	model?: string;
	incomplete_details?: { reason?: string } | null;
	output?: { type: string; content?: ResponsesOutputContent[] }[];
	usage?: { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } };
	error?: { code?: string; type?: string; message?: string } | null;
}

/**
 * OpenAI Responses API with a strict JSON-schema answer. One request per call:
 * no retries and no fallback model (the caller shows local sources instead).
 * The key is sent only in the Authorization header and is never part of an
 * error message; responses are not stored on the provider side (`store: false`).
 */
export class OpenAIResponsesProvider implements GenerationProvider {
	readonly model: string;
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;

	constructor(private readonly options: OpenAIProviderOptions) {
		if (!options.apiKey) throw new GenerationError('not_configured', 'OpenAI API key is not configured');
		this.model = options.model;
		this.baseUrl = validateOpenAIBaseUrl(options.baseUrl ?? OPENAI_BASE_URL);
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	async generate(request: GenerationRequest): Promise<GenerationResult> {
		const body: Record<string, unknown> = {
			model: this.model,
			instructions: request.instructions,
			input: request.input,
			text: { format: { type: 'json_schema', name: request.schemaName, strict: true, schema: request.schema } },
			max_output_tokens: request.maxOutputTokens,
			store: false,
		};
		if (this.options.reasoningEffort !== 'none') body.reasoning = { effort: this.options.reasoningEffort };
		if (request.signal?.aborted) throw new GenerationError('provider', 'Request was cancelled before it was sent');
		// `controller` is the deadline only, so a timeout is told apart from a caller cancellation.
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
		const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal;
		let res: Response;
		try {
			res = await this.fetchImpl(`${this.baseUrl}/v1/responses`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				redirect: 'error',
				signal,
			});
		} catch (err) {
			clearTimeout(timer);
			if (controller.signal.aborted) throw new GenerationError('timeout', `OpenAI request timed out after ${this.options.timeoutMs} ms`);
			throw new GenerationError('provider', 'OpenAI request failed (network)');
		}
		let parsed: ResponsesBody | null = null;
		try {
			parsed = (await res.json()) as ResponsesBody;
		} catch {
			// The deadline can expire after the headers, while the body is still being read.
			if (controller.signal.aborted) throw new GenerationError('timeout', `OpenAI response body timed out after ${this.options.timeoutMs} ms`);
			parsed = null;
		} finally {
			clearTimeout(timer);
		}
		if (!res.ok) throw classifyHttpError(res.status, parsed?.error ?? null);
		if (!parsed) throw new GenerationError('provider', 'OpenAI returned an unreadable response');
		if (parsed.status === 'failed') throw new GenerationError('provider', 'OpenAI reported a failed response');
		const content = (parsed.output ?? []).filter((o) => o.type === 'message').flatMap((o) => o.content ?? []);
		if (content.some((c) => c.type === 'refusal')) throw new GenerationError('refused', 'The model refused to answer');
		const text = content.filter((c) => c.type === 'output_text').map((c) => c.text ?? '').join('');
		const finishReason = parsed.status === 'completed' ? 'stop' : parsed.status === 'incomplete' ? (parsed.incomplete_details?.reason ?? 'incomplete') : (parsed.status ?? null);
		return {
			text,
			finishReason,
			model: parsed.model ?? this.model,
			usage: {
				inputTokens: parsed.usage?.input_tokens ?? null,
				outputTokens: parsed.usage?.output_tokens ?? null,
				reasoningTokens: parsed.usage?.output_tokens_details?.reasoning_tokens ?? null,
			},
		};
	}
}

/** Maps an HTTP error to a kind. Provider messages are not echoed (they could quote request data). */
export function classifyHttpError(status: number, error: { code?: string; type?: string } | null): GenerationError {
	const code = `${error?.code ?? ''} ${error?.type ?? ''}`;
	if (status === 401 || status === 403) return new GenerationError('auth', `OpenAI rejected the API key (HTTP ${status})`);
	if (status === 429 && /insufficient_quota|billing/.test(code)) return new GenerationError('quota', 'OpenAI quota or credit is exhausted (HTTP 429)');
	if (status === 429) return new GenerationError('rate_limit', 'OpenAI rate limit reached (HTTP 429)');
	if (status === 408 || status === 504) return new GenerationError('timeout', `OpenAI timed out (HTTP ${status})`);
	return new GenerationError('provider', `OpenAI request failed (HTTP ${status})`);
}
