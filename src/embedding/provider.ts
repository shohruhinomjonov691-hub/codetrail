import type { EmbeddingRecipe } from './recipe.js';

export interface ServerInfo {
	/** Runtime build reported by the server (llama.cpp `build_info`, e.g. `b11606-1b70350c9`), or `unknown`. */
	runtime: string;
	/** Model file path the server reports it has loaded. */
	modelPath: string;
}

/**
 * Confirmed identity of the embedding backend: the sha256 of the model file the
 * server actually loaded (verified on disk), its runtime build and the recipe.
 * Cache and index reuse require an exact match of all three.
 */
export interface ModelIdentity {
	modelSha256: string;
	runtime: string;
	recipeHash: string;
}

/** Swappable embedding backend. Implementations must be local (see validateProviderUrl). */
export interface EmbeddingProvider {
	readonly recipe: EmbeddingRecipe;
	/** Checks that the served model and context match the recipe. */
	verifyServer(): Promise<ServerInfo>;
	/** Confirms the identity of the loaded model; throws MODEL_MISMATCH when it cannot be confirmed. */
	identity(): Promise<ModelIdentity>;
	/** Token count including special tokens, exactly as the model will see the input. */
	countTokens(input: string, signal?: AbortSignal): Promise<number>;
	/** Inputs must already be formatted (formatQuery / formatDocument). Returns L2-normalized vectors. */
	embed(inputs: string[], kind: 'query' | 'document', signal?: AbortSignal): Promise<Float32Array[]>;
}
