import type { RuntimeConfig } from '../config.js';
import { CodeTrailError } from '../errors.js';
import type { EmbeddingProvider } from '../embedding/provider.js';
import { readSnapshot } from '../snapshot.js';
import { loadIndex } from '../retrieval/index.js';
import { DEFAULT_TUNING, openSearchSession, type SearchHit, type SearchMode, type SearchTuning } from '../retrieval/search.js';
import type { EmbeddingRecipe } from '../embedding/recipe.js';
import { aggregate, distribution, overlaps, scoreQuestion, type Aggregate, type QuestionScore } from './metrics.js';
import { validateFixture, type EvalFixture } from './fixture.js';

export interface QuestionResult {
	id: string;
	type: string;
	mode: SearchMode;
	score: QuestionScore | null; // null for abstention
	top1: { citation: string; rrf: number; vector_cosine: number | null } | null;
	hitsReturned: number;
	absenceEvidenceFound?: number;
}

export interface ModeSummary {
	mode: SearchMode;
	overall: Aggregate;
	byType: Record<string, Aggregate>;
	abstention: {
		n: number;
		top1VectorCosine: ReturnType<typeof distribution>;
		top1Rrf: ReturnType<typeof distribution>;
		hitsReturned: number[];
		absenceEvidenceFound: number[];
	};
	answerableTop1VectorCosine: ReturnType<typeof distribution>;
}

export interface EvalResult {
	project: string;
	snapshot_id: string;
	fixture_snapshot_id: string;
	index_id: string;
	recipe: { model: string; quant: string; sha256: string };
	runtime: string;
	k: number;
	tuning: SearchTuning;
	questions: { total: number; answerable: number; abstention: number };
	modes: ModeSummary[];
	perQuestion: QuestionResult[];
}

export async function runEvaluation(
	config: RuntimeConfig,
	projectId: string,
	snapshotId: string,
	fixture: EvalFixture,
	recipe: EmbeddingRecipe,
	opts: { modes: SearchMode[]; k: number; tuning?: Partial<SearchTuning>; provider?: EmbeddingProvider },
): Promise<EvalResult> {
	if (fixture.project !== projectId) throw new CodeTrailError('USAGE', `Fixture is for project ${fixture.project}, not ${projectId}`);
	const { manifest, chunks } = readSnapshot(config.dataDir, projectId, snapshotId);
	const problems = validateFixture(fixture, manifest, chunks);
	if (problems.length > 0) throw new CodeTrailError('USAGE', `Fixture does not match the snapshot:\n- ${problems.join('\n- ')}`);
	const needsProvider = opts.modes.some((m) => m !== 'bm25');
	if (needsProvider && !opts.provider) throw new CodeTrailError('USAGE', 'vector/hybrid evaluation needs an embedding provider');
	const index = loadIndex(config.dataDir, projectId, snapshotId, recipe);
	try {
		const session = await openSearchSession(index, needsProvider ? opts.provider : undefined);
		const tuning: SearchTuning = { ...DEFAULT_TUNING, ...opts.tuning };
		const perQuestion: QuestionResult[] = [];
		for (const mode of opts.modes) {
			for (const q of fixture.questions) {
				// Retrieve the deeper candidate list once so the metric sees exactly the top k.
				const hits: SearchHit[] = await session.search(q.question, { mode, k: opts.k, tuning });
				const top = hits[0];
				const result: QuestionResult = {
					id: q.id,
					type: q.type,
					mode,
					score: q.type === 'abstention' ? null : scoreQuestion(hits, q.expected, opts.k),
					top1: top ? { citation: top.citation, rrf: top.scores.rrf, vector_cosine: top.scores.vector_cosine } : null,
					hitsReturned: hits.length,
				};
				if (q.type === 'abstention') result.absenceEvidenceFound = (q.absence_evidence ?? []).filter((e) => hits.some((h) => overlaps(h, e))).length;
				perQuestion.push(result);
			}
		}
		const modes: ModeSummary[] = opts.modes.map((mode) => {
			const rows = perQuestion.filter((r) => r.mode === mode);
			const answerable = rows.filter((r) => r.score);
			const abst = rows.filter((r) => !r.score);
			const byType: Record<string, Aggregate> = {};
			for (const type of [...new Set(answerable.map((r) => r.type))].sort()) byType[type] = aggregate(answerable.filter((r) => r.type === type).map((r) => r.score as QuestionScore));
			const cos = (rs: QuestionResult[]): number[] => rs.map((r) => r.top1?.vector_cosine).filter((x): x is number => typeof x === 'number');
			return {
				mode,
				overall: aggregate(answerable.map((r) => r.score as QuestionScore)),
				byType,
				abstention: {
					n: abst.length,
					top1VectorCosine: distribution(cos(abst)),
					top1Rrf: distribution(abst.map((r) => r.top1?.rrf ?? 0)),
					hitsReturned: abst.map((r) => r.hitsReturned),
					absenceEvidenceFound: abst.map((r) => r.absenceEvidenceFound ?? 0),
				},
				answerableTop1VectorCosine: distribution(cos(answerable)),
			};
		});
		return {
			project: projectId,
			snapshot_id: snapshotId,
			fixture_snapshot_id: fixture.snapshot_id,
			index_id: index.meta.index_id,
			recipe: { model: recipe.model.name, quant: recipe.model.quant, sha256: recipe.model.sha256 },
			runtime: index.meta.identity.runtime,
			k: opts.k,
			tuning,
			questions: { total: fixture.questions.length, answerable: fixture.questions.filter((q) => q.type !== 'abstention').length, abstention: fixture.questions.filter((q) => q.type === 'abstention').length },
			modes,
			perQuestion,
		};
	} finally {
		index.db.close();
	}
}

const f3 = (x: number | null): string => (x === null ? '–' : x.toFixed(3));

export function renderMarkdown(r: EvalResult): string {
	const out: string[] = [];
	out.push(`### ${r.project} — snapshot \`${r.snapshot_id.slice(0, 12)}\`, index \`${r.index_id.slice(0, 12)}\``);
	out.push('');
	out.push(`Model ${r.recipe.model} ${r.recipe.quant} (\`${r.recipe.sha256.slice(0, 12)}\`), runtime \`${r.runtime}\`, k=${r.k}, tuning ${JSON.stringify(r.tuning)}. Questions: ${r.questions.answerable} answerable + ${r.questions.abstention} abstention.`);
	out.push('');
	out.push(`| Mode | Hit@${r.k} | Evidence Recall@${r.k} | MRR@${r.k} |`);
	out.push('| --- | --- | --- | --- |');
	for (const m of r.modes) out.push(`| ${m.mode} | ${f3(m.overall.hitAtK)} | ${f3(m.overall.evidenceRecallAtK)} | ${f3(m.overall.mrrAtK)} |`);
	out.push('');
	const types = [...new Set(r.modes.flatMap((m) => Object.keys(m.byType)))].sort();
	out.push(`| Type (n) | ${r.modes.map((m) => `${m.mode} Recall / MRR`).join(' | ')} |`);
	out.push(`| --- | ${r.modes.map(() => '---').join(' | ')} |`);
	for (const t of types) {
		const n = r.modes[0]?.byType[t]?.n ?? 0;
		out.push(`| ${t} (${n}) | ${r.modes.map((m) => (m.byType[t] ? `${f3(m.byType[t].evidenceRecallAtK)} / ${f3(m.byType[t].mrrAtK)}` : '–')).join(' | ')} |`);
	}
	out.push('');
	out.push('Abstention (not counted in recall) — top-1 scores vs answerable questions:');
	out.push('');
	out.push('| Mode | abstention top-1 cosine min/median/max | answerable top-1 cosine min/median/max | abstention top-1 RRF median | absence evidence found |');
	out.push('| --- | --- | --- | --- | --- |');
	for (const m of r.modes) {
		const a = m.abstention.top1VectorCosine;
		const b = m.answerableTop1VectorCosine;
		out.push(`| ${m.mode} | ${f3(a.min)} / ${f3(a.median)} / ${f3(a.max)} | ${f3(b.min)} / ${f3(b.median)} / ${f3(b.max)} | ${f3(m.abstention.top1Rrf.median)} | ${m.abstention.absenceEvidenceFound.join(', ') || '–'} |`);
	}
	out.push('');
	out.push(`| Question | Type | ${r.modes.map((m) => `${m.mode} first rank / found`).join(' | ')} |`);
	out.push(`| --- | --- | ${r.modes.map(() => '---').join(' | ')} |`);
	const ids = [...new Set(r.perQuestion.map((q) => q.id))];
	for (const id of ids) {
		const rows = r.modes.map((m) => r.perQuestion.find((q) => q.id === id && q.mode === m.mode));
		const type = rows[0]?.type ?? '';
		out.push(`| ${id} | ${type} | ${rows.map((q) => (q?.score ? `${q.score.firstRank ?? '–'} / ${q.score.foundEvidence}` : `abst. (absence ${q?.absenceEvidenceFound ?? 0})`)).join(' | ')} |`);
	}
	return out.join('\n') + '\n';
}
