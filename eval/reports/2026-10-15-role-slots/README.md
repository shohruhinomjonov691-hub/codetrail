# Role-slots experiment (2026-10-15)

One predefined variant compared with the shipped hybrid baseline. Nothing else was changed:

- the same fixtures, k=8, snapshots and indexes (GoTrip `d75aaec9…`/`e492467d…`, ky `6b9989f3…`/`3bc4cd73…`);
- the same model, scoring (`anchor-line/required-groups v2`), shipped tuning and target.

There was no grid, no holdout and no new model. All measurements are tuning-set results on the development Mac.

- **hybrid:** the shipped ranking, top 8 by fused score.
- **hybrid-role:** the same ranked candidates. Up to 6 implementation chunks and up to 2 chunks of other roles (test, doc, data) are taken in rank order. Empty slots are filled from the remaining candidates in rank order, and the final list keeps rank order. Roles come from generic path and language rules (`src/retrieval/role.ts`).

| Corpus | Mode | Hit@8 | Evidence Recall@8 | MRR@8 |
| --- | --- | --- | --- | --- |
| GoTrip (16 + 2) | hybrid | 0.812 | 0.656 | 0.476 |
| | hybrid-role | **0.875** | **0.688** | **0.496** |
| ky (10 + 2) | hybrid | 0.700 | 0.700 | 0.249 |
| | hybrid-role | **0.800** | **0.800** | **0.293** |

The hybrid rows are identical to `../2026-10-14-v2-tuned/`.

## Per question (only questions whose result changed)

| Question | Type | Groups hybrid → role | First rank hybrid → role |
| --- | --- | --- | --- |
| T1 | flow | 1/2 → 1/2 | 8 → 4 |
| T5 | auth | 0/2 → 1/2 | – → 5 |
| K1 | locate | 1/1 → 1/1 | 5 → 4 (optional 1 → 1) |
| K2 | config | 0/3 → 3/3 | – → 5 |
| K4 | locate | 1/1 → 1/1 | 2 → 2 (optional 0 → 1) |
| K6 | locate | 2/2 → 2/2 | 6 → 4 |
| K7 | flow | 1/1 → 1/1 | 4 → 3 |
| K10 | config | 1/1 → 1/1 | 8 → 7 |

- **Regressions:** none. No question lost a required group or an optional item, and no first rank got worse.
- **T18:** T18 is the only question with doc evidence (`DECISIONS.md`). That evidence is still found, at rank 1.
- **Abstention:** the top-1 results and scores of the abstention questions are unchanged.

## By type (Evidence Recall@8 / MRR@8)

| Corpus | Type (n) | hybrid | hybrid-role |
| --- | --- | --- | --- |
| GoTrip | auth (3) | 0.667 / 0.400 | 0.833 / 0.467 |
| GoTrip | flow (4) | 0.500 / 0.144 | 0.500 / 0.175 |
| GoTrip | config, doc-vs-code, error, locate, partial, unused | unchanged | unchanged |
| ky | config (2) | 0.500 / 0.062 | 1.000 / 0.171 |
| ky | locate (4) | 0.750 / 0.217 | 0.750 / 0.250 |
| ky | flow (2) | 1.000 / 0.625 | 1.000 / 0.667 |
| ky | error (2) | 0.500 / 0.125 | 0.500 / 0.125 |

## Verdict

- **ky:** reaches the 0.80 target exactly.
- **GoTrip:** misses the target (0.688).
- **Not a default.** The fixtures contain almost no questions whose answer is in tests, docs or JSON/YAML config (only T18 group 2). With at most 2 such slots in the top 8, those questions can get worse, and this set cannot measure that. The 2026-10-15 diagnosis predicted T2, T9 and K8 as recoverable, but they stay out: with 2 slots reserved for other roles, their implementation-only ranks (7, 8 and 8) do not fit in 6 implementation slots.
