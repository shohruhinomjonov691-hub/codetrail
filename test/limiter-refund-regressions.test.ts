/**
 * Regressions for the Codex re-review of ed0f0cb..5ed8029 (P2): refunding a
 * cancelled queued explanation must give back exactly THAT reservation, once —
 * never another request's sliding-window timestamp and never another day's
 * count. The clock is controlled; the provider is in-process and released by
 * hand (no real API, no timed waits).
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnswerService, ExplainLimiter, type AnswerLimits, type ExplainResponse } from '../src/answer/service.js';
import type { RuntimeConfig } from '../src/config.js';
import { LlamaCppEmbedding } from '../src/embedding/llamacpp.js';
import { embeddingRecipeFromLock, type ModelsLock } from '../src/embedding/models.js';
import type { EmbeddingRecipe } from '../src/embedding/recipe.js';
import type { GenerationProvider, GenerationRequest, GenerationResult } from '../src/generation/provider.js';
import { Registry } from '../src/registry.js';
import { buildIndex } from '../src/retrieval/index.js';
import { createSnapshot } from '../src/snapshot.js';
import { FAKE_MODEL_FILE, FAKE_MODEL_SHA256, startFakeLlama, type FakeLlama } from './fake-llama.js';
import { makeRepo, tempDir } from './helpers.js';

const ANSWER: GenerationResult = { text: '{"status":"insufficient_evidence","claims":[]}', finishReason: 'stop', model: 'fake', usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };

/** The first call blocks until release(); later calls answer at once. */
class HeldProvider implements GenerationProvider {
	readonly model = 'fake';
	calls = 0;
	private releaseFirst: (() => void) | null = null;
	generate(_request: GenerationRequest): Promise<GenerationResult> {
		this.calls++;
		if (this.calls === 1) return new Promise((resolve) => (this.releaseFirst = () => resolve(ANSWER)));
		return Promise.resolve(ANSWER);
	}
	release(): void {
		this.releaseFirst?.();
	}
}

let llama: FakeLlama;
let recipe: EmbeddingRecipe;
let cfg: RuntimeConfig;

beforeAll(async () => {
	llama = await startFakeLlama();
	const lock: ModelsLock = {
		schema: 1,
		runtime: { name: 'fake', release: 't', commit: '0'.repeat(40), license: 'MIT', source: 't', assets: {} },
		embedding: { name: 'Fake', repo: 'f', revision: 'r', file: 'fake-embed.gguf', url: 'http://127.0.0.1/x', sha256: FAKE_MODEL_SHA256, size: 18, quant: 'Q8_0', license: 'MIT', dims: 64, maxTokens: 512 },
	};
	recipe = embeddingRecipeFromLock(lock);
	const root = tempDir('limiter-refund');
	cfg = { dataDir: join(root, 'data'), localRoots: [root] };
	const reg = new Registry(cfg.dataDir);
	const repo = makeRepo(root, 'alpha', { 'src/a.ts': 'export function alphaTimeout() {\n\treturn 1;\n}\n' });
	reg.addProject('alpha', 'Alpha');
	reg.addSource('alpha', { id: 'main', kind: 'local', location: repo.dir, defaultRef: 'main' });
	const snap = (await createSnapshot(cfg, 'alpha')).report.snapshot_id;
	await buildIndex(cfg, 'alpha', snap, new LlamaCppEmbedding({ url: llama.url, allowedHosts: [], recipe, modelFile: FAKE_MODEL_FILE }));
});
afterAll(async () => llama.close());

function harness(limits: Partial<AnswerLimits>, start: number) {
	const clock = { now: start };
	const provider = new HeldProvider();
	const s = new AnswerService({
		config: cfg,
		recipe,
		embedding: new LlamaCppEmbedding({ url: llama.url, allowedHosts: [], recipe, modelFile: FAKE_MODEL_FILE }),
		generation: provider,
		limits: { maxOutputTokens: 2048, maxContextChars: 12000, concurrency: 1, ratePerMinute: 100, dailyLimit: 1000, cacheSize: 0, ...limits },
		now: () => clock.now,
	});
	s.load();
	/** Polls (no fixed sleep) until `cond` holds, then lets pending microtasks/immediates run. */
	const until = async (cond: () => boolean): Promise<void> => {
		for (let i = 0; i < 5000 && !cond(); i++) await new Promise((r) => setImmediate(r));
		if (!cond()) throw new Error('condition not reached');
		for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
	};
	/**
	 * Starts an explanation and waits until it has been searched (reserved and queued, or refused).
	 * The promise is wrapped: an async function returning it directly would wait for the answer.
	 */
	const start_ = async (question: string, client: string, signal?: AbortSignal): Promise<{ result: Promise<ExplainResponse> }> => {
		const before = llama.stats.embedRequests;
		const result = s.explain('alpha', question, client, undefined, signal);
		result.catch(() => {});
		await until(() => llama.stats.embedRequests > before);
		return { result };
	};
	return { clock, provider, s, until, start: start_ };
}

describe('refund returns exactly the cancelled reservation', () => {
	it('an old queued request cancelled later does not erase a newer request from the sliding window', async () => {
		const h = harness({ ratePerMinute: 2 }, Date.UTC(2026, 9, 15, 12, 0, 0));
		try {
			const { result: a } = await h.start('holder question one', 'holder');
			await h.until(() => h.provider.calls === 1); // A holds the only slot
			const cancelB = new AbortController();
			const { result: b } = await h.start('client question b', 'c1', cancelB.signal); // c1 @ t+0, queued
			h.clock.now += 30_000;
			const { result: c } = await h.start('client question c', 'c1'); // c1 @ t+30s, queued — window full
			cancelB.abort();
			await expect(b).rejects.toMatchObject({ name: 'RequestCancelledError' });
			h.clock.now += 31_000; // t+61s: B's slot (t+0) would have expired anyway; C (t+30s) still counts
			const { result: d } = await h.start('client question d', 'c1'); // allowed: window = {C, D}
			const { result: e } = await h.start('client question e', 'c1'); // must be refused: window is full
			h.provider.release();
			const [ra, rc, rd, re] = await Promise.all([a, c, d, e]);
			expect(re).toMatchObject({ mode: 'fallback', reason: 'client_rate_limit' });
			expect([ra.reason, rc.reason, rd.reason]).toEqual([null, null, null]);
			expect(h.provider.calls).toBe(3); // A, C, D
		} finally {
			h.s.close();
		}
	});

	it("cancelling yesterday's queued reservation does not lower today's daily count", async () => {
		const h = harness({ dailyLimit: 2 }, Date.UTC(2026, 9, 15, 23, 59, 0));
		try {
			const { result: a } = await h.start('day one holder', 'h1'); // day 1: 1/2
			await h.until(() => h.provider.calls === 1);
			const cancelB = new AbortController();
			const { result: b } = await h.start('day one queued', 'c1', cancelB.signal); // day 1: 2/2, queued
			h.clock.now = Date.UTC(2026, 9, 16, 0, 0, 30);
			const { result: c } = await h.start('day two first', 'c2'); // day 2: 1/2
			const { result: d } = await h.start('day two second', 'c3'); // day 2: 2/2
			cancelB.abort();
			await expect(b).rejects.toMatchObject({ name: 'RequestCancelledError' });
			const { result: e } = await h.start('day two third', 'c4'); // must be refused: day 2 is full
			h.provider.release();
			const [, rc, rd, re] = await Promise.all([a, c, d, e]);
			expect(re).toMatchObject({ mode: 'fallback', reason: 'daily_limit' });
			expect([rc.reason, rd.reason]).toEqual([null, null]);
			expect(h.provider.calls).toBe(3); // A, C, D
		} finally {
			h.s.close();
		}
	});
});

describe('ExplainLimiter reservations', () => {
	const T = Date.UTC(2026, 9, 15, 12, 0, 0);

	it('a repeated refund does not count twice', () => {
		const clock = { now: T };
		const l = new ExplainLimiter(2, 2, () => clock.now);
		const r1 = l.take('c1');
		const r2 = l.take('c1');
		expect(typeof r1).toBe('object');
		expect(l.take('c2')).toBe('daily_limit');
		expect(l.refund(r1 as never)).toBe(true);
		expect(l.refund(r1 as never)).toBe(false);
		expect(typeof l.take('c2')).toBe('object'); // exactly one slot came back…
		expect(l.take('c3')).toBe('daily_limit'); // …not two
		expect(l.take('c1')).toBe('daily_limit');
		void r2;
	});

	it('a reservation whose provider call started is not refunded', () => {
		const l = new ExplainLimiter(1, 10, () => T);
		const r = l.take('c1');
		l.commit(r as never);
		expect(l.refund(r as never)).toBe(false);
		expect(l.take('c1')).toBe('client_rate_limit');
	});
});
