### ky — snapshot `6b9989f36c61`, index `3bc4cd734262`

Scoring: **anchor-line/required-groups v2** — evidence counts only when one retrieved chunk contains its exact anchor line; recall is over required groups (any alternative satisfies a group); optional evidence is reported, never in the denominator.

Model Qwen3-Embedding-0.6B Q8_0 (`06507c7b4268`), runtime `b11606-1b70350c9`, k=8, tuning {"bm25Weights":[2,3,1,1],"rrfK":60,"candidatePool":50,"bm25Stopwords":false,"rrfWeights":[1,1]}. Questions: 10 answerable + 2 abstention.

| Mode | Hit@8 | Evidence Recall@8 | MRR@8 |
| --- | --- | --- | --- |
| bm25 | 0.200 | 0.200 | 0.034 |
| vector | 0.600 | 0.600 | 0.309 |
| hybrid | 0.600 | 0.600 | 0.281 |

| Type (n) | bm25 Recall / MRR | vector Recall / MRR | hybrid Recall / MRR |
| --- | --- | --- | --- |
| config (2) | 0.000 / 0.000 | 0.000 / 0.000 | 0.500 / 0.071 |
| error (2) | 0.500 / 0.071 | 0.500 / 0.500 | 0.500 / 0.167 |
| flow (2) | 0.500 / 0.100 | 1.000 / 0.350 | 1.000 / 0.750 |
| locate (4) | 0.000 / 0.000 | 0.750 / 0.348 | 0.500 / 0.208 |

Abstention (not counted in recall) — top-1 scores vs answerable questions:

| Mode | abstention top-1 cosine min/median/max | answerable top-1 cosine min/median/max | abstention top-1 RRF median | absence evidence found |
| --- | --- | --- | --- | --- |
| bm25 | – / – / – | – / – / – | 0.016 | 0, 0 |
| vector | 0.537 / 0.554 / 0.571 | 0.600 / 0.717 / 0.822 | 0.016 | 0, 0 |
| hybrid | 0.501 / 0.504 / 0.508 | 0.558 / 0.686 / 0.771 | 0.032 | 0, 0 |

| Question | Type | bm25 first rank / required groups | vector first rank / required groups | hybrid first rank / required groups |
| --- | --- | --- | --- | --- |
| K1 | locate | – / 0/1 | 1 / 1/1 (+1 opt) | 3 / 1/1 (+1 opt) |
| K2 | config | – / 0/3 | – / 0/3 | – / 0/3 |
| K3 | flow | – / 0/1 | 5 / 1/1 (+1 opt) | 1 / 1/1 (+1 opt) |
| K4 | locate | – / 0/1 | 7 / 1/1 (+1 opt) | 2 / 1/1 |
| K5 | error | – / 0/1 (+1 opt) | – / 0/1 (+1 opt) | – / 0/1 (+1 opt) |
| K6 | locate | – / 0/2 | 4 / 2/2 | – / 0/2 |
| K7 | flow | 5 / 1/1 | 2 / 1/1 | 2 / 1/1 |
| K8 | locate | – / 0/1 | – / 0/1 | – / 0/1 |
| K9 | error | 7 / 1/1 (+2 opt) | 1 / 1/1 (+1 opt) | 3 / 1/1 (+1 opt) |
| K10 | config | – / 0/1 | – / 0/1 | 7 / 1/1 |
| KA1 | abstention | abst. (absence 0) | abst. (absence 0) | abst. (absence 0) |
| KA2 | abstention | abst. (absence 0) | abst. (absence 0) | abst. (absence 0) |
