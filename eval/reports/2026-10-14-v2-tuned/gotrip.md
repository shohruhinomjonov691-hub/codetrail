### gotrip — snapshot `14bcc5ca5560`, index `370fef9a01b0`

Scoring: **anchor-line/required-groups v2** — evidence counts only when one retrieved chunk contains its exact anchor line; recall is over required groups (any alternative satisfies a group); optional evidence is reported, never in the denominator.

Model Qwen3-Embedding-0.6B Q8_0 (`06507c7b4268`), runtime `b11606-1b70350c9`, k=8, tuning {"bm25Weights":[3,3,1,2],"rrfK":30,"candidatePool":100,"bm25Stopwords":false,"rrfWeights":[1,1]}. Questions: 16 answerable + 2 abstention.

| Mode | Hit@8 | Evidence Recall@8 | MRR@8 |
| --- | --- | --- | --- |
| bm25 | 0.438 | 0.406 | 0.352 |
| vector | 0.750 | 0.625 | 0.472 |
| hybrid | 0.813 | 0.656 | 0.476 |

| Type (n) | bm25 Recall / MRR | vector Recall / MRR | hybrid Recall / MRR |
| --- | --- | --- | --- |
| auth (3) | 0.333 / 0.333 | 0.833 / 0.464 | 0.667 / 0.400 |
| config (3) | 0.333 / 0.333 | 0.333 / 0.333 | 0.333 / 0.333 |
| doc-vs-code (1) | 0.500 / 1.000 | 0.500 / 1.000 | 0.500 / 1.000 |
| error (1) | 1.000 / 0.125 | 1.000 / 0.200 | 1.000 / 0.333 |
| flow (4) | 0.000 / 0.000 | 0.500 / 0.240 | 0.500 / 0.144 |
| locate (2) | 1.000 / 0.750 | 0.500 / 0.500 | 1.000 / 1.000 |
| partial (1) | 0.000 / 0.000 | 1.000 / 1.000 | 1.000 / 0.500 |
| unused (1) | 1.000 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 |

Abstention (not counted in recall) — top-1 scores vs answerable questions:

| Mode | abstention top-1 cosine min/median/max | answerable top-1 cosine min/median/max | abstention top-1 RRF median | absence evidence found |
| --- | --- | --- | --- | --- |
| bm25 | – / – / – | – / – / – | 0.032 | 1, 0 |
| vector | 0.370 / 0.509 / 0.648 | 0.442 / 0.642 / 0.802 | 0.032 | 0, 0 |
| hybrid | 0.331 / 0.435 / 0.539 | 0.360 / 0.608 / 0.802 | 0.058 | 1, 0 |

| Question | Type | bm25 first rank / required groups | vector first rank / required groups | hybrid first rank / required groups |
| --- | --- | --- | --- | --- |
| T1 | flow | – / 0/2 | – / 0/2 | 8 / 1/2 (+1 opt) |
| T2 | flow | – / 0/2 | 2 / 2/2 | 5 / 1/2 (+1 opt) |
| T3 | flow | – / 0/2 | 8 / 1/2 (+1 opt) | 8 / 1/2 |
| T4 | auth | 1 / 2/2 | 1 / 2/2 | 1 / 2/2 |
| T5 | auth | – / 0/2 | 4 / 1/2 | – / 0/2 |
| T6 | auth | – / 0/1 | 7 / 1/1 | 5 / 1/1 |
| T7 | flow | – / 0/2 (+1 opt) | 3 / 1/2 (+1 opt) | 8 / 1/2 (+1 opt) |
| T8 | config | 1 / 1/1 (+1 opt) | 1 / 1/1 | 1 / 1/1 (+1 opt) |
| T9 | config | – / 0/1 | – / 0/1 (+1 opt) | – / 0/1 (+1 opt) |
| T10 | error | 8 / 2/2 | 5 / 2/2 | 3 / 2/2 |
| T11 | config | – / 0/2 | – / 0/2 | – / 0/2 |
| T12 | locate | 2 / 1/1 | – / 0/1 | 1 / 1/1 |
| T13 | locate | 1 / 1/1 | 1 / 1/1 | 1 / 1/1 |
| T14 | abstention | abst. (absence 1) | abst. (absence 0) | abst. (absence 1) |
| T15 | partial | – / 0/1 | 1 / 1/1 | 2 / 1/1 |
| T16 | unused | 1 / 1/1 (+1 opt) | 1 / 1/1 | 1 / 1/1 (+1 opt) |
| T17 | abstention | abst. (absence 0) | abst. (absence 0) | abst. (absence 0) |
| T18 | doc-vs-code | 1 / 1/2 (+1 opt) | 1 / 1/2 (+1 opt) | 1 / 1/2 (+1 opt) |

Identifier occurrences (syntactic token scan of the snapshot's included code files; not binding-aware, not runtime usage; not a retrieval metric):

| Question | Identifier | Source | Declaration token | Occurrences besides it | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- |
| T16 | `START_CONVERSATION` | frontend | apollo/user/mutation.ts:414:14 | 0 (none) | 0 | pass |
