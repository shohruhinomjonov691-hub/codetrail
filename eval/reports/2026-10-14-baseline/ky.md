### ky — snapshot `9d5e668f5c47`, index `9ab026fb3737`

Model Qwen3-Embedding-0.6B Q8_0 (`06507c7b4268`), runtime `b11606-1b70350c9`, k=8, tuning {"bm25Weights":[2,3,1,1],"rrfK":60,"candidatePool":50}. Questions: 10 answerable + 2 abstention.

| Mode | Hit@8 | Evidence Recall@8 | MRR@8 |
| --- | --- | --- | --- |
| bm25 | 0.300 | 0.250 | 0.153 |
| vector | 0.700 | 0.550 | 0.395 |
| hybrid | 0.700 | 0.500 | 0.448 |

| Type (n) | bm25 Recall / MRR | vector Recall / MRR | hybrid Recall / MRR |
| --- | --- | --- | --- |
| config (2) | 0.000 / 0.000 | 0.000 / 0.000 | 0.500 / 0.071 |
| error (2) | 0.750 / 0.667 | 0.500 / 0.750 | 0.500 / 1.000 |
| flow (2) | 0.500 / 0.100 | 0.750 / 0.350 | 0.750 / 0.750 |
| locate (4) | 0.000 / 0.000 | 0.750 / 0.438 | 0.375 / 0.208 |

Abstention (not counted in recall) — top-1 scores vs answerable questions:

| Mode | abstention top-1 cosine min/median/max | answerable top-1 cosine min/median/max | abstention top-1 RRF median | absence evidence found |
| --- | --- | --- | --- | --- |
| bm25 | – / – / – | – / – / – | 0.016 | 0, 0 |
| vector | 0.537 / 0.554 / 0.571 | 0.600 / 0.717 / 0.822 | 0.016 | 0, 0 |
| hybrid | 0.501 / 0.504 / 0.508 | 0.558 / 0.686 / 0.771 | 0.032 | 0, 0 |

| Question | Type | bm25 first rank / found | vector first rank / found | hybrid first rank / found |
| --- | --- | --- | --- | --- |
| K1 | locate | – / 0 | 1 / 1 | 3 / 1 |
| K2 | config | – / 0 | – / 0 | – / 0 |
| K3 | flow | – / 0 | 5 / 1 | 1 / 1 |
| K4 | locate | – / 0 | 2 / 2 | 2 / 1 |
| K5 | error | 1 / 1 | 1 / 1 | 1 / 1 |
| K6 | locate | – / 0 | 4 / 1 | – / 0 |
| K7 | flow | 5 / 1 | 2 / 1 | 2 / 1 |
| K8 | locate | – / 0 | – / 0 | – / 0 |
| K9 | error | 3 / 2 | 2 / 1 | 1 / 1 |
| K10 | config | – / 0 | – / 0 | 7 / 1 |
| KA1 | abstention | abst. (absence 0) | abst. (absence 0) | abst. (absence 0) |
| KA2 | abstention | abst. (absence 0) | abst. (absence 0) | abst. (absence 0) |
