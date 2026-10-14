import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { CodeTrailError } from '../errors.js';
import { verifyModelFile } from './models.js';
import type { EmbeddingProvider, ModelIdentity, ServerInfo } from './provider.js';
import { recipeHash, type EmbeddingRecipe } from './recipe.js';
import { isUnitVector } from './vectors.js';
import { Semaphore, validateProviderUrl } from './url.js';

export interface LlamaCppEmbeddingOptions {
	url: string;
	allowedHosts: readonly string[];
	recipe: EmbeddingRecipe;
	/**
	 * Local path of the model file the server is expected to have loaded. Identity is
	 * confirmed only if the server reports this same file (by real path) and the file
	 * matches the pinned sha256. Without it, identity cannot be confirmed.
	 */
	modelFile?: string;
	/** Where the model file digest may be cached (by path, size, mtime). */
	hashCacheDir?: string;
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
	private readonly opts: Required<Omit<LlamaCppEmbeddingOptions, 'url' | 'allowedHosts' | 'recipe' | 'modelFile' | 'hashCacheDir'>>;
	private readonly modelFile: string | undefined;
	private readonly hashCacheDir: string | undefined;

	constructor(options: LlamaCppEmbeddingOptions) {
		this.base = validateProviderUrl(options.url, options.allowedHosts);
		this.recipe = options.recipe;
		this.modelFile = options.modelFile;
		this.hashCacheDir = options.hashCacheDir;
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

	async verifyServer(): Promise<ServerInfo> {
		const props = (await this.request('GET', '/props', undefined, this.opts.queryTimeoutMs)) as {
			model_path?: string;
			build_info?: string;
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
		const runtime = typeof props.build_info === 'string' && /^[\w.+-]{1,64}$/.test(props.build_info) ? props.build_info : 'unknown';
		return { runtime, modelPath: props.model_path ?? '' };
	}

	async identity(): Promise<ModelIdentity> {
		const server = await this.verifyServer();
		const fail = (why: string): never => {
			throw new CodeTrailError('MODEL_MISMATCH', `Embedding model identity not confirmed: ${why}`);
		};
		if (!this.modelFile) fail('no local model file configured');
		if (server.runtime === 'unknown') fail('server did not report its runtime build');
		const real = (p: string): string | null => {
			try {
				return realpathSync(p);
			} catch {
				return null;
			}
		};
		const served = real(server.modelPath);
		if (!served || served !== real(this.modelFile as string)) fail('server reports a different model file than the verified local file');
		await verifyModelFile(this.modelFile as string, this.recipe.model.sha256, this.hashCacheDir ?? '');
		return { modelSha256: this.recipe.model.sha256, runtime: server.runtime, recipeHash: recipeHash(this.recipe) };
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

/**
 * Validates dimension and finiteness, then L2-normalizes without overflow or
 * underflow: values are first scaled by the largest magnitude, so e.g.
 * [1e308, 1e308] normalizes to [0.7071, 0.7071] instead of collapsing to zero.
 */
export function normalizeVector(values: readonly number[], dims: number): Float32Array {
	if (values.length !== dims) throw new CodeTrailError('PROVIDER_FAILED', `Embedding has ${values.length} dims, expected ${dims}`);
	let maxAbs = 0;
	for (const v of values) {
		if (typeof v !== 'number' || !Number.isFinite(v)) throw new CodeTrailError('PROVIDER_FAILED', 'Embedding contains a non-finite value');
		maxAbs = Math.max(maxAbs, Math.abs(v));
	}
	if (maxAbs === 0) throw new CodeTrailError('PROVIDER_FAILED', 'Embedding has zero norm');
	let sum = 0;
	for (const v of values) sum += (v / maxAbs) ** 2;
	const norm = Math.sqrt(sum);
	const out = new Float32Array(dims);
	for (let i = 0; i < dims; i++) out[i] = (values[i] as number) / maxAbs / norm;
	if (!isUnitVector(out, dims)) throw new CodeTrailError('PROVIDER_FAILED', 'Embedding could not be normalized to a finite unit vector');
	return out;
}
