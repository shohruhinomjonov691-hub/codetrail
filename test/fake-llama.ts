import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

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
			send(res, 200, { model_path: opts.modelPath ?? '/models/fake-embed.gguf', build_info: opts.buildInfo ?? 'fake-b1', default_generation_settings: { n_ctx: opts.nCtx ?? 1024 } });
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
			send(res, 200, { data: input.map((text, index) => ({ index, embedding: vectorFor(text, dims, seed) })) });
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
