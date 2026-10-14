import { basename } from 'node:path';
import { CodeTrailError } from '../errors.js';
import type { EmbeddingProvider } from './provider.js';
import type { EmbeddingRecipe } from './recipe.js';
import { Semaphore, validateProviderUrl } from './url.js';

export interface LlamaCppEmbeddingOptions {
	url: string;
	allowedHosts: readonly string[];
	recipe: EmbeddingRecipe;
	/** Per-request timeouts. Queries are short; document batches are indexed offline on the operator machine. */
	queryTimeoutMs?: number;
	documentTimeoutMs?: number;
	concurrency?: number;
	batchSize?: number;
}

export const EMBED_LIMITS = { queryTimeoutMs: 10_000, documentTimeoutMs: 120_000, concurrency: 2, batchSize: 8 } as const;

/** llama.cpp `llama-server --embedding --pooling last` over HTTP. Redirects are never followed. */
export class LlamaCppEmbedding implements EmbeddingProvider {
	readonly recipe: EmbeddingRecipe;
	private readonly base: URL;
	private readonly limiter: Semaphore;
	private readonly opts: Required<Omit<LlamaCppEmbeddingOptions, 'url' | 'allowedHosts' | 'recipe'>>;

	constructor(options: LlamaCppEmbeddingOptions) {
		this.base = validateProviderUrl(options.url, options.allowedHosts);
		this.recipe = options.recipe;
		this.opts = {
			queryTimeoutMs: options.queryTimeoutMs ?? EMBED_LIMITS.queryTimeoutMs,
			documentTimeoutMs: options.documentTimeoutMs ?? EMBED_LIMITS.documentTimeoutMs,
			concurrency: options.concurrency ?? EMBED_LIMITS.concurrency,
			batchSize: options.batchSize ?? EMBED_LIMITS.batchSize,
		};
		this.limiter = new Semaphore(this.opts.concurrency);
	}

	private async request(method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
		let res: Response;
		try {
			res = await fetch(new URL(path, this.base), {
				method,
				redirect: 'manual',
				headers: body === undefined ? {} : { 'content-type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.any(signals),
			});
		} catch (err) {
			const reason = (err as Error).name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : 'connection failed';
			throw new CodeTrailError('PROVIDER_FAILED', `Embedding provider ${path} ${reason}`);
		}
		if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
			throw new CodeTrailError('PROVIDER_FAILED', `Embedding provider ${path} answered with a redirect; redirects are not followed`);
		}
		const text = await res.text();
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			throw new CodeTrailError('PROVIDER_FAILED', `Embedding provider ${path} returned non-JSON (HTTP ${res.status})`);
		}
		if (!res.ok) {
			const type = (json as { error?: { type?: string } }).error?.type;
			if (type === 'exceed_context_size_error') throw new CodeTrailError('TOKEN_LIMIT', 'Input exceeds the embedding context; it was not truncated');
			throw new CodeTrailError('PROVIDER_FAILED', `Embedding provider ${path} failed (HTTP ${res.status})`);
		}
		return json;
	}

	async verifyServer(): Promise<void> {
		const props = (await this.request('GET', '/props', undefined, this.opts.queryTimeoutMs)) as {
			model_path?: string;
			default_generation_settings?: { n_ctx?: number };
		};
		const served = props.model_path ? basename(props.model_path) : '';
		if (served !== this.recipe.model.file) {
			throw new CodeTrailError('MODEL_MISMATCH', `Embedding server serves ${served || 'an unknown model'}, expected ${this.recipe.model.file}`);
		}
		const ctx = props.default_generation_settings?.n_ctx ?? 0;
		if (ctx < this.recipe.maxTokens) {
			throw new CodeTrailError('MODEL_MISMATCH', `Embedding server slot context ${ctx} is smaller than recipe maxTokens ${this.recipe.maxTokens}`);
		}
	}

	countTokens(input: string, signal?: AbortSignal): Promise<number> {
		return this.limiter.run(async () => {
			const json = (await this.request('POST', '/tokenize', { content: input, add_special: true }, this.opts.queryTimeoutMs, signal)) as { tokens?: unknown[] };
			if (!Array.isArray(json.tokens)) throw new CodeTrailError('PROVIDER_FAILED', 'Embedding provider /tokenize returned no tokens');
			return json.tokens.length;
		});
	}

	async embed(inputs: string[], kind: 'query' | 'document', signal?: AbortSignal): Promise<Float32Array[]> {
		const timeout = kind === 'query' ? this.opts.queryTimeoutMs : this.opts.documentTimeoutMs;
		const batches: string[][] = [];
		for (let i = 0; i < inputs.length; i += this.opts.batchSize) batches.push(inputs.slice(i, i + this.opts.batchSize));
		const results = await Promise.all(
			batches.map((batch) =>
				this.limiter.run(async () => {
					const json = (await this.request('POST', '/v1/embeddings', { input: batch }, timeout, signal)) as {
						data?: { index: number; embedding: number[] }[];
					};
					if (!Array.isArray(json.data) || json.data.length !== batch.length) {
						throw new CodeTrailError('PROVIDER_FAILED', 'Embedding provider returned a wrong number of vectors');
					}
					return [...json.data].sort((a, b) => a.index - b.index).map((d) => normalizeVector(d.embedding, this.recipe.dims));
				}),
			),
		);
		return results.flat();
	}
}

/** Validates dimension and finiteness, then L2-normalizes. */
export function normalizeVector(values: readonly number[], dims: number): Float32Array {
	if (values.length !== dims) throw new CodeTrailError('PROVIDER_FAILED', `Embedding has ${values.length} dims, expected ${dims}`);
	let sum = 0;
	for (const v of values) {
		if (!Number.isFinite(v)) throw new CodeTrailError('PROVIDER_FAILED', 'Embedding contains a non-finite value');
		sum += v * v;
	}
	const norm = Math.sqrt(sum);
	if (norm < 1e-6) throw new CodeTrailError('PROVIDER_FAILED', 'Embedding has zero norm');
	const out = new Float32Array(dims);
	for (let i = 0; i < dims; i++) out[i] = (values[i] as number) / norm;
	return out;
}
