### ky — snapshot `6b9989f36c61`, index `3bc4cd734262`

Scoring: **anchor-line/required-groups v2** — evidence counts only when one retrieved chunk contains its exact anchor line; recall is over required groups (any alternative satisfies a group); optional evidence is reported, never in the denominator.

Model Qwen3-Embedding-0.6B Q8_0 (`06507c7b4268`), runtime `b11606-1b70350c9`, k=8, tuning {"bm25Weights":[3,3,1,2],"rrfK":30,"candidatePool":100,"bm25Stopwords":false,"rrfWeights":[1,1]}. Questions: 10 answerable + 2 abstention.

| Mode | Hit@8 | Evidence Recall@8 | MRR@8 |
| --- | --- | --- | --- |
| hybrid | 0.700 | 0.700 | 0.249 |
| hybrid-role | 0.800 | 0.800 | 0.293 |

| Type (n) | hybrid Recall / MRR | hybrid-role Recall / MRR |
| --- | --- | --- |
| config (2) | 0.500 / 0.063 | 1.000 / 0.171 |
| error (2) | 0.500 / 0.125 | 0.500 / 0.125 |
| flow (2) | 1.000 / 0.625 | 1.000 / 0.667 |
| locate (4) | 0.750 / 0.217 | 0.750 / 0.250 |

Abstention (not counted in recall) — top-1 scores vs answerable questions:

| Mode | abstention top-1 cosine min/median/max | answerable top-1 cosine min/median/max | abstention top-1 RRF median | absence evidence found |
| --- | --- | --- | --- | --- |
| hybrid | 0.501 / 0.504 / 0.508 | 0.558 / 0.686 / 0.771 | 0.061 | 0, 0 |
| hybrid-role | 0.501 / 0.504 / 0.508 | 0.558 / 0.686 / 0.771 | 0.061 | 0, 0 |

| Question | Type | hybrid first rank / required groups | hybrid-role first rank / required groups |
| --- | --- | --- | --- |
| K1 | locate | 5 / 1/1 (+1 opt) | 4 / 1/1 (+1 opt) |
| K2 | config | – / 0/3 | 5 / 3/3 |
| K3 | flow | 1 / 1/1 (+1 opt) | 1 / 1/1 (+1 opt) |
| K4 | locate | 2 / 1/1 | 2 / 1/1 (+1 opt) |
| K5 | error | – / 0/1 (+1 opt) | – / 0/1 (+1 opt) |
| K6 | locate | 6 / 2/2 | 4 / 2/2 |
| K7 | flow | 4 / 1/1 | 3 / 1/1 |
| K8 | locate | – / 0/1 | – / 0/1 |
| K9 | error | 4 / 1/1 (+1 opt) | 4 / 1/1 (+1 opt) |
| K10 | config | 8 / 1/1 | 7 / 1/1 |
| KA1 | abstention | abst. (absence 0) | abst. (absence 0) |
| KA2 | abstention | abst. (absence 0) | abst. (absence 0) |
