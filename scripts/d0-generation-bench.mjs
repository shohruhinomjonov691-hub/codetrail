#!/usr/bin/env node
// D0 local-LLM feasibility benchmark (not a CodeTrail feature). For a few TUNING questions it
// retrieves evidence with the shipped default search (hybrid, rank, k=8), sends ONE grounded
// generation request at a time to the loopback llama-server (scripts/gen-server.sh) and records
// timings, context tokens, server RSS and the raw answer. Grading is done by hand afterwards.
// Usage: CODETRAIL_MODELS_DIR=… node scripts/d0-generation-bench.mjs <project> <snapshot> <fixture> <ids> <out.json>
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { loadConfig } from '../dist/config.js';
import { createEmbeddingProvider, embeddingSettings } from '../dist/embedding/config.js';
import { anchorLines, loadFixture, snapshotLines } from '../dist/eval/fixture.js';
import { retrievesEvidence } from '../dist/eval/metrics.js';
import { loadIndex } from '../dist/retrieval/index.js';
import { openSearchSession } from '../dist/retrieval/search.js';

const GEN_URL = 'http://127.0.0.1:8082';
const K = 8;
const EVIDENCE_TOKEN_BUDGET = 6000; // server context is 8192; leaves room for the prompt and the answer
const MAX_OUTPUT_TOKENS = 384;
const SYSTEM = [
	'You answer questions about a codebase using ONLY the numbered source excerpts given by the user.',
	'Rules:',
	'1. End every factual sentence with a citation of the excerpt and file lines that support it, like [S2:L14] or [S2:L14-L18]. Use only line numbers shown in that excerpt.',
	'2. Do not use outside knowledge. Do not mention files, functions, settings or behaviour that the excerpts do not show.',
	'3. If the excerpts do not contain enough to answer, reply exactly: INSUFFICIENT_EVIDENCE: followed by one sentence on what is missing.',
	'4. Be brief: at most 6 sentences.',
].join('\n');

const [project, snapshot, fixturePath, idList, out] = process.argv.slice(2);
if (new URL(GEN_URL).hostname !== '127.0.0.1') throw new Error('generation server must be loopback');
const config = loadConfig();
const settings = embeddingSettings();
const index = loadIndex(config.dataDir, project, snapshot, settings.recipe);
const session = await openSearchSession(index, await createEmbeddingProvider(config, settings));
const fixture = loadFixture(fixturePath);
const lines = snapshotLines(index.chunks);
const textById = new Map(index.chunks.map((c) => [c.id, c.text]));

const props = await (await fetch(`${GEN_URL}/props`)).json();
const pid = (await promisify(execFile)('pgrep', ['-f', 'llama-server.*--port 8082'])).stdout.trim().split('\n')[0];
const rssMb = async () => Number((await promisify(execFile)('ps', ['-o', 'rss=', '-p', pid])).stdout.trim()) / 1024;
const tokens = async (content) => (await (await fetch(`${GEN_URL}/tokenize`, { method: 'POST', body: JSON.stringify({ content }) })).json()).tokens.length;

const results = [];
for (const q of fixture.questions.filter((x) => idList.split(',').includes(x.id))) {
	const hits = await session.search(q.question, { mode: 'hybrid', k: K });
	const blocks = [];
	let used = 0;
	let dropped = 0;
	for (const h of hits) {
		const text = textById.get(h.chunk_id) ?? '';
		const numbered = text.split('\n').map((l, i) => `${h.start_line + i}| ${l}`).join('\n');
		const block = `[S${blocks.length + 1}] ${h.source_id}:${h.path} L${h.start_line}-L${h.end_line}\n\`\`\`\n${numbered}\n\`\`\``;
		const n = await tokens(block);
		if (used + n > EVIDENCE_TOKEN_BUDGET) {
			dropped++;
			continue;
		}
		used += n;
		blocks.push({ block, hit: h, text });
	}
	const user = `Question: ${q.question}\n\nExcerpts:\n\n${blocks.map((b) => b.block).join('\n\n')}`;
	// Was each required group's evidence actually inside the context the model saw?
	const inContext = q.required.map((group) =>
		group.some((e) => blocks.some((b) => retrievesEvidence({ ...b.hit, text: b.text }, { ...e, anchorLines: anchorLines(e, lines) }))),
	);
	let peak = await rssMb();
	const sampler = setInterval(() => rssMb().then((r) => (peak = Math.max(peak, r))).catch(() => {}), 100);
	const t0 = performance.now();
	let ttft = null;
	let answer = '';
	let final = null;
	const res = await fetch(`${GEN_URL}/v1/chat/completions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
			stream: true,
			stream_options: { include_usage: true },
			max_tokens: MAX_OUTPUT_TOKENS,
			temperature: 0,
			top_k: 1,
			seed: 0,
		}),
	});
	if (!res.ok || !res.body) throw new Error(`generation failed: HTTP ${res.status}`);
	const decoder = new TextDecoder();
	let buf = '';
	for await (const part of res.body) {
		buf += decoder.decode(part, { stream: true });
		let nl;
		while ((nl = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line.startsWith('data:')) continue;
			const data = line.slice(5).trim();
			if (data === '[DONE]') continue;
			const j = JSON.parse(data);
			const delta = j.choices?.[0]?.delta?.content;
			if (delta) {
				if (ttft === null) ttft = performance.now() - t0;
				answer += delta;
			}
			if (j.usage || j.timings) final = { usage: j.usage ?? final?.usage, timings: j.timings ?? final?.timings };
		}
	}
	const total = performance.now() - t0;
	clearInterval(sampler);
	// Mechanical citation check: [S#:Lx] / [S#:Lx-Ly] must name a given excerpt and lines inside it.
	const cites = [...answer.matchAll(/\[S(\d+):L(\d+)(?:-L?(\d+))?\]/g)].map((m) => {
		const b = blocks[Number(m[1]) - 1];
		const a = Number(m[2]);
		const z = Number(m[3] ?? m[2]);
		return { cite: m[0], valid: !!b && a >= b.hit.start_line && z <= b.hit.end_line && a <= z };
	});
	results.push({
		id: q.id,
		type: q.type,
		question: q.question,
		requiredInContext: inContext,
		excerpts: blocks.map((b, i) => `S${i + 1} ${b.hit.path}:L${b.hit.start_line}-L${b.hit.end_line}`),
		droppedForBudget: dropped,
		evidenceTokens: used,
		promptTokens: final?.usage?.prompt_tokens ?? final?.timings?.prompt_n ?? null,
		outputTokens: final?.usage?.completion_tokens ?? final?.timings?.predicted_n ?? null,
		ttftMs: ttft === null ? null : Math.round(ttft),
		totalMs: Math.round(total),
		promptPerSecond: final?.timings?.prompt_per_second ?? null,
		genPerSecond: final?.timings?.predicted_per_second ?? null,
		serverPeakRssMb: Math.round(peak),
		abstained: /^\s*INSUFFICIENT_EVIDENCE/.test(answer),
		citations: cites,
		answer,
	});
	process.stderr.write(`${q.id} ${Math.round(total)} ms\n`);
}
writeFileSync(out, JSON.stringify({ project, snapshot, k: K, selection: 'rank', evidenceTokenBudget: EVIDENCE_TOKEN_BUDGET, maxOutputTokens: MAX_OUTPUT_TOKENS, server: { n_ctx: props.default_generation_settings?.n_ctx ?? null, model: props.model_path ?? null, build: props.build_info ?? null }, system: SYSTEM, results }, null, 2) + '\n');
index.db.close();
process.exit(0);
