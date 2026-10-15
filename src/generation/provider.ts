/**
 * Answer generation behind one small interface. The only production provider is
 * OpenAI (src/generation/openai.ts); tests use fakes. A provider never retries
 * and never switches models: one call, one result or one classified error.
 */
export interface GenerationRequest {
	/** Fixed instructions (no repository content). */
	instructions: string;
	/** The question plus the selected project's excerpts. Never logged. */
	input: string;
	/** JSON schema the answer must follow (strict). */
	schema: Record<string, unknown>;
	schemaName: string;
	maxOutputTokens: number;
}

export interface GenerationResult {
	/** The raw JSON text of the answer. */
	text: string;
	/** "stop" only when the model finished normally; anything else is treated as incomplete. */
	finishReason: string | null;
	usage: { inputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null };
	model: string;
}

/**
 * Why generation is unavailable. The UI shows local search results for every
 * kind; none of them is retried automatically.
 */
export type GenerationErrorKind = 'not_configured' | 'auth' | 'quota' | 'rate_limit' | 'timeout' | 'refused' | 'provider';

export class GenerationError extends Error {
	constructor(
		readonly kind: GenerationErrorKind,
		message: string,
	) {
		super(message);
		this.name = 'GenerationError';
	}
}

export interface GenerationProvider {
	readonly model: string;
	generate(request: GenerationRequest): Promise<GenerationResult>;
}
