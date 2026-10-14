### gotrip — snapshot `14bcc5ca5560`, index `370fef9a01b0`

Model Qwen3-Embedding-0.6B Q8_0 (`06507c7b4268`), runtime `b11606-1b70350c9`, k=8, tuning {"bm25Weights":[2,3,1,1],"rrfK":60,"candidatePool":50}. Questions: 16 answerable + 2 abstention.

| Mode | Hit@8 | Evidence Recall@8 | MRR@8 |
| --- | --- | --- | --- |
| bm25 | 0.563 | 0.377 | 0.369 |
| vector | 0.813 | 0.506 | 0.493 |
| hybrid | 0.750 | 0.496 | 0.547 |

| Type (n) | bm25 Recall / MRR | vector Recall / MRR | hybrid Recall / MRR |
| --- | --- | --- | --- |
| auth (3) | 0.111 / 0.333 | 0.667 / 0.464 | 0.111 / 0.333 |
| config (3) | 0.500 / 0.381 | 0.278 / 0.444 | 0.444 / 0.667 |
| doc-vs-code (1) | 0.500 / 1.000 | 0.500 / 1.000 | 0.500 / 1.000 |
| error (1) | 1.000 / 0.143 | 1.000 / 0.200 | 1.000 / 0.333 |
| flow (4) | 0.050 / 0.031 | 0.317 / 0.240 | 0.317 / 0.229 |
| locate (2) | 0.750 / 0.750 | 0.500 / 0.500 | 0.750 / 1.000 |
| partial (1) | 0.000 / 0.000 | 1.000 / 1.000 | 1.000 / 0.500 |
| unused (1) | 1.000 / 1.000 | 0.500 / 1.000 | 1.000 / 1.000 |

Abstention (not counted in recall) — top-1 scores vs answerable questions:

| Mode | abstention top-1 cosine min/median/max | answerable top-1 cosine min/median/max | abstention top-1 RRF median | absence evidence found |
| --- | --- | --- | --- | --- |
| bm25 | – / – / – | – / – / – | 0.016 | 1, 0 |
| vector | 0.370 / 0.509 / 0.648 | 0.442 / 0.642 / 0.802 | 0.016 | 0, 0 |
| hybrid | 0.331 / 0.435 / 0.539 | 0.360 / 0.605 / 0.802 | 0.031 | 0, 0 |

| Question | Type | bm25 first rank / found | vector first rank / found | hybrid first rank / found |
| --- | --- | --- | --- | --- |
| T1 | flow | – / 0 | – / 0 | 6 / 1 |
| T2 | flow | – / 0 | 2 / 1 | 4 / 2 |
| T3 | flow | – / 0 | 8 / 1 | – / 0 |
| T4 | auth | 1 / 1 | 1 / 2 | 1 / 1 |
| T5 | auth | – / 0 | 4 / 1 | – / 0 |
| T6 | auth | – / 0 | 7 / 1 | – / 0 |
| T7 | flow | 8 / 1 | 3 / 3 | 2 / 2 |
| T8 | config | 1 / 2 | 1 / 1 | 1 / 2 |
| T9 | config | – / 0 | 3 / 1 | 1 / 1 |
| T10 | error | 7 / 1 | 5 / 1 | 3 / 1 |
| T11 | config | 7 / 1 | – / 0 | – / 0 |
| T12 | locate | 2 / 1 | – / 0 | 1 / 1 |
| T13 | locate | 1 / 1 | 1 / 1 | 1 / 1 |
| T14 | abstention | abst. (absence 1) | abst. (absence 0) | abst. (absence 0) |
| T15 | partial | – / 0 | 1 / 1 | 2 / 1 |
| T16 | unused | 1 / 2 | 1 / 1 | 1 / 2 |
| T17 | abstention | abst. (absence 0) | abst. (absence 0) | abst. (absence 0) |
| T18 | doc-vs-code | 1 / 2 | 1 / 2 | 1 / 2 |
