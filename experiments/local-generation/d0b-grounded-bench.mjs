#!/usr/bin/env node
// D0b grounded-answer benchmark (not a CodeTrail feature). One predefined variant:
// compact line-numbered excerpts + schema-constrained JSON (status + claims), validated
// fail-closed by src/eval/grounded.ts. Two context paths per question:
//   retrieval — shipped default search (hybrid, rank, k=8)  → the end-to-end result;
//   golden    — the fixture's required (or absence) evidence → diagnostic only, NOT end-to-end.
// One request at a time to the loopback llama-server (scripts/gen-server.sh). Grading is by hand.
// Usage: node scripts/d0b-grounded-bench.mjs <project> <snapshot> <fixture> <ids> <out.json>
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { loadConfig } from '../dist/config.js';
import { createEmbeddingProvider, embeddingSettings } from '../dist/embedding/config.js';
import { compactLines, fileLines, GROUNDED_SCHEMA, queryTerms, renderExcerpt, validateGroundedAnswer } from '../dist/eval/grounded.js';
import { loadFixture } from '../dist/eval/fixture.js';
import { loadIndex } from '../dist/retrieval/index.js';
import { openSearchSession } from '../dist/retrieval/search.js';
import { readSourceTexts } from '../dist/snapshot.js';

const GEN_URL = 'http://127.0.0.1:8082';
const K = 8;
const EVIDENCE_TOKEN_BUDGET = 3000;
const MAX_OUTPUT_TOKENS = 512;
const GOLDEN_PAD = 2;
const GOLDEN_MAX_LINES = 30;
const SYSTEM = [
	'You answer questions about a codebase using ONLY the numbered excerpts given by the user.',
	'Reply with JSON only: {"status": "answered" | "insufficient_evidence", "claims": [...]}.',
	'Each claim has: "text" — one short factual statement that answers part of the question; "source_id" — the excerpt id, like "S2";',
	'"lines" — {"start": n, "end": m}, line numbers shown in that excerpt that support the claim; "quote" — text copied exactly from those lines.',
	'Only make claims that the cited lines directly support. Do not use outside knowledge.',
	'If the excerpts do not answer the question, reply {"status": "insufficient_evidence", "claims": []}. At most 6 claims.',
].join('\n');

const [project, snapshot, fixturePath, idList, out] = process.argv.slice(2);
if (new URL(GEN_URL).hostname !== '127.0.0.1') throw new Error('generation server must be loopback');
const config = loadConfig();
const settings = embeddingSettings();
const index = loadIndex(config.dataDir, project, snapshot, settings.recipe);
const session = await openSearchSession(index, await createEmbeddingProvider(config, settings));
const fixture = loadFixture(fixturePath);
const textById = new Map(index.chunks.map((c) => [c.id, c.text]));
const sourceText = new Map();
const fullText = (sourceId, path) => {
	if (!sourceText.has(sourceId)) sourceText.set(sourceId, new Map(readSourceTexts(config.dataDir, project, snapshot, sourceId).map((f) => [f.path, f.text])));
	return sourceText.get(sourceId).get(path);
};
const pid = (await promisify(execFile)('pgrep', ['-f', 'llama-server.*--port 8082'])).stdout.trim().split('\n')[0];
const rssMb = async () => Number((await promisify(execFile)('ps', ['-o', 'rss=', '-p', pid])).stdout.trim()) / 1024;
const tokens = async (content) => (await (await fetch(`${GEN_URL}/tokenize`, { method: 'POST', body: JSON.stringify({ content }) })).json()).tokens.length;
const span = (lines) => (lines.length ? `L${lines[0].line}-L${lines[lines.length - 1].line} (${lines.length} lines)` : 'empty');

/** Adds candidate excerpts in order while they fit the token budget; records what was dropped. */
async function fit(candidates) {
	const excerpts = [];
	const dropped = [];
	let used = 0;
	for (const c of candidates) {
		const e = { ...c, id: `S${excerpts.length + 1}` };
		const n = await tokens(renderExcerpt(e));
		if (used + n > EVIDENCE_TOKEN_BUDGET) {
			dropped.push({ path: c.path, lines: span(c.lines), tokens: n, reason: 'token budget' });
			continue;
		}
		used += n;
		excerpts.push(e);
	}
	return { excerpts, dropped, evidenceTokens: used };
}

async function retrievalContext(q) {
	const terms = queryTerms(q.question);
	const hits = await session.search(q.question, { mode: 'hybrid', k: K });
	return fit(hits.map((h) => ({ source_id: h.source_id, path: h.path, lines: compactLines(textById.get(h.chunk_id) ?? '', h.start_line, terms), rank: h.rank })));
}

async function goldenContext(q) {
	const evidence = q.type === 'abstention' ? (q.absence_evidence ?? []) : q.required.flat();
	if (evidence.length === 0) return null;
	const byFile = new Map();
	for (const e of evidence) {
		const text = fullText(e.source_id, e.path);
		const anchorLine = text.split('\n').findIndex((l, i) => i + 1 >= e.start_line && i + 1 <= e.end_line && l.includes(e.anchor)) + 1;
		let [a, z] = [e.start_line - GOLDEN_PAD, e.end_line + GOLDEN_PAD];
		if (z - a + 1 > GOLDEN_MAX_LINES) [a, z] = [anchorLine - 12, anchorLine + 12];
		const key = `${e.source_id}\u0000${e.path}`;
		const set = byFile.get(key) ?? { source_id: e.source_id, path: e.path, keep: new Set() };
		for (const l of fileLines(text, a, z)) set.keep.add(l.line);
		byFile.set(key, set);
	}
	return fit([...byFile.values()].map((f) => {
		const lines = f.keep.size ? fileLines(fullText(f.source_id, f.path), Math.min(...f.keep), Math.max(...f.keep)).filter((l) => f.keep.has(l.line)) : [];
		return { source_id: f.source_id, path: f.path, lines };
	}));
}

async function ask(question, ctx) {
	const user = `Question: ${question}\n\nExcerpts:\n\n${ctx.excerpts.map(renderExcerpt).join('\n\n')}`;
	let peak = await rssMb();
	const sampler = setInterval(() => rssMb().then((r) => (peak = Math.max(peak, r))).catch(() => {}), 100);
	const t0 = performance.now();
	let ttft = null;
	let raw = '';
	let usage = null;
	const res = await fetch(`${GEN_URL}/v1/chat/completions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
			response_format: { type: 'json_schema', json_schema: { name: 'grounded_answer', strict: true, schema: GROUNDED_SCHEMA } },
			stream: true,
			stream_options: { include_usage: true },
			max_tokens: MAX_OUTPUT_TOKENS,
			temperature: 0,
			top_k: 1,
			seed: 0,
		}),
	});
	if (!res.ok || !res.body) throw new Error(`generation failed: HTTP ${res.status} ${await res.text()}`);
	const decoder = new TextDecoder();
	let buf = '';
	for await (const part of res.body) {
		buf += decoder.decode(part, { stream: true });
		let nl;
		while ((nl = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
			const j = JSON.parse(line.slice(5));
			const delta = j.choices?.[0]?.delta?.content;
			if (delta) {
				if (ttft === null) ttft = performance.now() - t0;
				raw += delta;
			}
			if (j.usage) usage = j.usage;
		}
	}
	const total = performance.now() - t0;
	clearInterval(sampler);
	const v = validateGroundedAnswer(raw, ctx.excerpts);
	return {
		excerpts: ctx.excerpts.map((e) => ({ id: e.id, path: `${e.source_id}:${e.path}`, lines: span(e.lines) })),
		dropped: ctx.dropped,
		evidenceTokens: ctx.evidenceTokens,
		promptTokens: usage?.prompt_tokens ?? null,
		outputTokens: usage?.completion_tokens ?? null,
		ttftMs: ttft === null ? null : Math.round(ttft),
		totalMs: Math.round(total),
		serverPeakRssMb: Math.round(peak),
		valid: v.ok,
		rejectReasons: v.ok ? [] : v.reasons,
		status: v.answer?.status ?? null,
		raw,
	};
}

const results = [];
for (const q of fixture.questions.filter((x) => idList.split(',').includes(x.id))) {
	const r = { id: q.id, type: q.type, question: q.question, retrieval: await ask(q.question, await retrievalContext(q)) };
	const g = await goldenContext(q);
	r.golden = g ? await ask(q.question, g) : null;
	results.push(r);
	process.stderr.write(`${q.id} retrieval ${r.retrieval.totalMs} ms${r.golden ? `, golden ${r.golden.totalMs} ms` : ', golden n/a'}\n`);
}
writeFileSync(out, JSON.stringify({ project, snapshot, k: K, selection: 'rank', evidenceTokenBudget: EVIDENCE_TOKEN_BUDGET, maxOutputTokens: MAX_OUTPUT_TOKENS, system: SYSTEM, schema: GROUNDED_SCHEMA, results }, null, 2) + '\n');
index.db.close();
process.exit(0);
