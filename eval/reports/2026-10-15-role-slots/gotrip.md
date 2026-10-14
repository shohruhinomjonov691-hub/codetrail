### gotrip — snapshot `d75aaec92128`, index `e492467de717`

Scoring: **anchor-line/required-groups v2** — evidence counts only when one retrieved chunk contains its exact anchor line; recall is over required groups (any alternative satisfies a group); optional evidence is reported, never in the denominator.

Model Qwen3-Embedding-0.6B Q8_0 (`06507c7b4268`), runtime `b11606-1b70350c9`, k=8, tuning {"bm25Weights":[3,3,1,2],"rrfK":30,"candidatePool":100,"bm25Stopwords":false,"rrfWeights":[1,1]}. Questions: 16 answerable + 2 abstention.

| Mode | Hit@8 | Evidence Recall@8 | MRR@8 |
| --- | --- | --- | --- |
| hybrid | 0.813 | 0.656 | 0.476 |
| hybrid-role | 0.875 | 0.688 | 0.496 |

| Type (n) | hybrid Recall / MRR | hybrid-role Recall / MRR |
| --- | --- | --- |
| auth (3) | 0.667 / 0.400 | 0.833 / 0.467 |
| config (3) | 0.333 / 0.333 | 0.333 / 0.333 |
| doc-vs-code (1) | 0.500 / 1.000 | 0.500 / 1.000 |
| error (1) | 1.000 / 0.333 | 1.000 / 0.333 |
| flow (4) | 0.500 / 0.144 | 0.500 / 0.175 |
| locate (2) | 1.000 / 1.000 | 1.000 / 1.000 |
| partial (1) | 1.000 / 0.500 | 1.000 / 0.500 |
| unused (1) | 1.000 / 1.000 | 1.000 / 1.000 |

Abstention (not counted in recall) — top-1 scores vs answerable questions:

| Mode | abstention top-1 cosine min/median/max | answerable top-1 cosine min/median/max | abstention top-1 RRF median | absence evidence found |
| --- | --- | --- | --- | --- |
| hybrid | 0.331 / 0.435 / 0.539 | 0.360 / 0.608 / 0.802 | 0.058 | 1, 0 |
| hybrid-role | 0.331 / 0.435 / 0.539 | 0.360 / 0.608 / 0.802 | 0.058 | 1, 0 |

| Question | Type | hybrid first rank / required groups | hybrid-role first rank / required groups |
| --- | --- | --- | --- |
| T1 | flow | 8 / 1/2 (+1 opt) | 4 / 1/2 (+1 opt) |
| T2 | flow | 5 / 1/2 (+1 opt) | 5 / 1/2 (+1 opt) |
| T3 | flow | 8 / 1/2 | 8 / 1/2 |
| T4 | auth | 1 / 2/2 | 1 / 2/2 |
| T5 | auth | – / 0/2 | 5 / 1/2 |
| T6 | auth | 5 / 1/1 | 5 / 1/1 |
| T7 | flow | 8 / 1/2 (+1 opt) | 8 / 1/2 (+1 opt) |
| T8 | config | 1 / 1/1 (+1 opt) | 1 / 1/1 (+1 opt) |
| T9 | config | – / 0/1 (+1 opt) | – / 0/1 (+1 opt) |
| T10 | error | 3 / 2/2 | 3 / 2/2 |
| T11 | config | – / 0/2 | – / 0/2 |
| T12 | locate | 1 / 1/1 | 1 / 1/1 |
| T13 | locate | 1 / 1/1 | 1 / 1/1 |
| T14 | abstention | abst. (absence 1) | abst. (absence 1) |
| T15 | partial | 2 / 1/1 | 2 / 1/1 |
| T16 | unused | 1 / 1/1 (+1 opt) | 1 / 1/1 (+1 opt) |
| T17 | abstention | abst. (absence 0) | abst. (absence 0) |
| T18 | doc-vs-code | 1 / 1/2 (+1 opt) | 1 / 1/2 (+1 opt) |

Identifier occurrences (syntactic token scan of the snapshot's included code files; not binding-aware, not runtime usage; not a retrieval metric):

| Question | Identifier | Source | Declaration token | Occurrences besides it | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- |
| T16 | `START_CONVERSATION` | frontend | apollo/user/mutation.ts:414:14 | 0 (none) | 0 | pass |
