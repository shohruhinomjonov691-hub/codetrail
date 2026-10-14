import type { EmbeddingRecipe } from './recipe.js';

/** Swappable embedding backend. Implementations must be local (see validateProviderUrl). */
export interface EmbeddingProvider {
	readonly recipe: EmbeddingRecipe;
	/** Checks that the served model and context match the recipe. */
	verifyServer(): Promise<void>;
	/** Token count including special tokens, exactly as the model will see the input. */
	countTokens(input: string, signal?: AbortSignal): Promise<number>;
	/** Inputs must already be formatted (formatQuery / formatDocument). Returns L2-normalized vectors. */
	embed(inputs: string[], kind: 'query' | 'document', signal?: AbortSignal): Promise<Float32Array[]>;
}
