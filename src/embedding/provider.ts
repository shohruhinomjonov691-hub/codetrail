import type { EmbeddingRecipe } from './recipe.js';

export interface ServerInfo {
	/** Runtime build reported by the server (llama.cpp `build_info`, e.g. `b11606-1b70350c9`), or `unknown`. */
	runtime: string;
}

/** Swappable embedding backend. Implementations must be local (see validateProviderUrl). */
export interface EmbeddingProvider {
	readonly recipe: EmbeddingRecipe;
	/** Checks that the served model and context match the recipe; returns the runtime build identity. */
	verifyServer(): Promise<ServerInfo>;
	/** Token count including special tokens, exactly as the model will see the input. */
	countTokens(input: string, signal?: AbortSignal): Promise<number>;
	/** Inputs must already be formatted (formatQuery / formatDocument). Returns L2-normalized vectors. */
	embed(inputs: string[], kind: 'query' | 'document', signal?: AbortSignal): Promise<Float32Array[]>;
}
