import { canonicalJson, sha256Hex } from '../hash.js';

/**
 * Everything that determines an embedding vector besides the input text.
 * Changing any field changes `recipeHash`, which keys both the embedding cache
 * and the index directory, so vectors from different recipes never mix.
 */
export const EMBED_RECIPE_VERSION = 1;

export interface EmbeddingRecipe {
	version: number;
	model: { name: string; file: string; sha256: string; quant: string };
	dims: number;
	/** Official Qwen3-Embedding usage: last-token pooling, L2-normalized vectors. */
	pooling: 'last';
	normalize: 'l2';
	/** Official query format: `Instruct: {task}\nQuery:{query}`; documents get no instruction. */
	queryTask: string;
	queryTemplate: 'Instruct: {task}\nQuery:{query}';
	documentTemplate: 'File: {path}\nSymbol: {symbol}\n\n{text}';
	/** Inputs longer than this are rejected, never truncated. Must not exceed the server's per-slot context. */
	maxTokens: number;
}

export const DEFAULT_QUERY_TASK = 'Given a question about a software codebase, retrieve the code or documentation that answers it';

/** Fixed text whose embedding fingerprints the model actually being served. */
export const PROBE_TEXT = 'CodeTrail embedding fingerprint: export function add(a: number, b: number) { return a + b; }';

export function recipeHash(recipe: EmbeddingRecipe): string {
	return sha256Hex(canonicalJson(recipe));
}

export function formatQuery(recipe: EmbeddingRecipe, query: string): string {
	return `Instruct: ${recipe.queryTask}\nQuery:${query}`;
}

export function formatDocument(chunk: { path: string; symbol: string | null; text: string }): string {
	return `File: ${chunk.path}\nSymbol: ${chunk.symbol ?? '-'}\n\n${chunk.text}`;
}
