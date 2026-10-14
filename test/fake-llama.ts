import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { PROBE_TEXT } from '../src/embedding/recipe.js';

/** A shared on-disk fake model file; fake servers report it as loaded unless told otherwise. */
export const FAKE_MODEL_FILE = join(realpathSync(mkdtempSync(join(tmpdir(), 'codetrail-fake-model-'))), 'fake-embed.gguf');
writeFileSync(FAKE_MODEL_FILE, 'not really a model');
export const FAKE_MODEL_SHA256 = createHash('sha256').update('not really a model').digest('hex');

export interface FakeLlamaOptions {
	modelPath?: string;
	nCtx?: number;
	dims?: number;
	/** Changing the seed changes every vector — simulates a different model. */
	seed?: string;
	redirectTo?: string;
	tokens?: (content: string) => number;
	delayMs?: number;
	buildInfo?: string;
	/** Seed used only for the fingerprint probe text (defaults to `seed`). */
	probeSeed?: string;
	/** Small deterministic perturbation added to the probe vector. */
	probeNoise?: number;
	/** Full override of the raw vector for a given input text. */
	rawVector?: (text: string, dims: number) => number[] | null;
}

export interface FakeLlama {
	url: string;
	stats: { embedRequests: number; embeddedInputs: number; tokenizeRequests: number; maxConcurrent: number; hits: number };
	close(): Promise<void>;
}

/** Bag-of-words hashing so texts sharing words get similar vectors. Deterministic per seed. */
function vectorFor(text: string, dims: number, seed: string): number[] {
	const v = new Array<number>(dims).fill(0);
	for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
		const h = createHash('sha256').update(`${seed}:${word}`).digest();
		v[h.readUInt16BE(0) % dims]! += h[2]! % 2 === 0 ? 1 : -1;
	}
	v[0]! += 0.01;
	return v;
}

function body(req: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let data = '';
		req.on('data', (c: Buffer) => (data += c.toString()));
		req.on('end', () => resolve(data));
	});
}

export async function startFakeLlama(opts: FakeLlamaOptions = {}): Promise<FakeLlama> {
	const dims = opts.dims ?? 64;
	const seed = opts.seed ?? 'model-a';
	const stats = { embedRequests: 0, embeddedInputs: 0, tokenizeRequests: 0, maxConcurrent: 0, hits: 0 };
	let active = 0;
	const send = (res: ServerResponse, status: number, json: unknown): void => {
		res.writeHead(status, { 'content-type': 'application/json' });
		res.end(JSON.stringify(json));
	};
	const server = createServer(async (req, res) => {
		stats.hits++;
		if (opts.redirectTo) {
			res.writeHead(302, { location: opts.redirectTo });
			res.end();
			return;
		}
		const raw = await body(req);
		if (req.url === '/props') {
			send(res, 200, { model_path: opts.modelPath ?? FAKE_MODEL_FILE, build_info: opts.buildInfo ?? 'fake-b1', default_generation_settings: { n_ctx: opts.nCtx ?? 1024 } });
			return;
		}
		if (req.url === '/tokenize') {
			stats.tokenizeRequests++;
			const content = (JSON.parse(raw) as { content: string }).content;
			const n = opts.tokens ? opts.tokens(content) : (content.match(/\S+/g)?.length ?? 0) + 1;
			send(res, 200, { tokens: Array.from({ length: n }, (_, i) => i) });
			return;
		}
		if (req.url === '/v1/embeddings') {
			active++;
			stats.maxConcurrent = Math.max(stats.maxConcurrent, active);
			if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
			const input = (JSON.parse(raw) as { input: string[] }).input;
			stats.embedRequests++;
			stats.embeddedInputs += input.length;
			active--;
			const embed = (text: string): number[] => {
				const override = opts.rawVector?.(text, dims);
				if (override) return override;
				if (text === PROBE_TEXT) {
					const v = vectorFor(text, dims, opts.probeSeed ?? seed);
					if (opts.probeNoise) v.forEach((x, i) => (v[i] = x + (i % 2 === 0 ? opts.probeNoise! : -opts.probeNoise!)));
					return v;
				}
				return vectorFor(text, dims, seed);
			};
			send(res, 200, { data: input.map((text, index) => ({ index, embedding: embed(text) })) });
			return;
		}
		send(res, 404, { error: { message: 'not found' } });
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		stats,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}
