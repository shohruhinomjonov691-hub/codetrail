# D0 — local LLM feasibility benchmark (2026-10-15)

**Not a CodeTrail feature.** This is a one-off check before stage D: can a small local model write grounded answers from the evidence CodeTrail already retrieves?

## Setup

| Item | Value |
| --- | --- |
| Model | Qwen2.5-Coder-1.5B-Instruct Q4_K_M, official repo `Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF`, revision `f86cb2c1…`, SHA-256 `cc324af0…` (pinned in `models.lock.json` → `generation`). Apache-2.0. Weights live outside the repository. |
| Runtime | llama.cpp b11606 (`1b70350c9`), the same pinned build as for embeddings. `scripts/gen-server.sh` checks the model SHA-256 at start. Server args: `-c 8192 -np 1 --cache-ram 0 --host 127.0.0.1 --port 8082`. |
| Requests | One generation request at a time, loopback only. Temperature 0, top_k 1, seed 0, at most 384 output tokens. |
| Evidence | The shipped default search: hybrid, `rank` selection, k=8, on GoTrip `d75aaec9…` and ky `6b9989f3…`. Excerpts are added in rank order with line numbers. Any excerpt that would push the evidence over 6000 tokens is skipped. The model is told to cite `[S#:Lx-Ly]` and to answer `INSUFFICIENT_EVIDENCE:` when the excerpts are not enough. |
| Questions | 13 **tuning** questions; the holdout set was not touched. Locate: T12, K4, K10. Multi-file flow: T1, T4, K3. Doc/config: T8, T18, T11 (retrieval missed), K2 (retrieval missed). Unanswerable: T14, T17, KA1. |
| Machine | Development Mac (Apple M2, 16 GB). **These are not server results.** |

- Raw answers and metrics: `gotrip.raw.json`, `ky.raw.json`.
- Script: `scripts/d0-generation-bench.mjs`.
- Manual grades: `grades.json`. Every claim was checked against the snapshot's verified file store.

**Success rule:** every claim is correct **and** backed by a valid citation to the given excerpts. Abstention questions count as a success only if the answer is `INSUFFICIENT_EVIDENCE`. A citation that exists does not make the claim true, and an answer without citations is never a success.

## Results

| Question | Kind | Required evidence in the context | Grade |
| --- | --- | --- | --- |
| T12 | locate | yes | partial: one schedule is wrong, one job is missing; no citations |
| K4 | locate | yes | partial: one false claim (totalTimeout); no citations |
| K10 | config | yes | content correct, **no citations** |
| T4 | flow/auth | yes (2/2) | content correct, **no citations** |
| K3 | flow | yes | partial: one false claim; no citations |
| T1 | flow | no (0/2) | **fabricated** instead of abstaining |
| T8 | config | yes | **incorrect**; degenerate repetition until the output limit |
| T18 | doc-vs-code | 1/2 (the doc) | **incorrect**, with a valid citation to an excerpt that contradicts it |
| T11 | config | no (0/2) | **incorrect or unsupported** instead of abstaining |
| K2 | config | no by scoring; equivalent `@default` docs were in context | content correct, **no citations** |
| T14 | unanswerable | – | **no abstention**; misread the docs |
| T17 | unanswerable | – | **no abstention**; outside-knowledge Stripe code |
| KA1 | unanswerable | – | **no abstention**; invented an IndexedDB cache |

### Summary

| | Count |
| --- | --- |
| Successes (strict rule) | **0 / 13** |
| Content correct, but uncited | 3 (T4, K10, K2) |
| Partially correct, at least one false claim or omission | 3 (T12, K4, K3) |
| Incorrect or fabricated | 4 (T1, T8, T18, T11) |
| Correct abstentions | **0 / 3** unanswerable questions. Also 0 / 2 answerable questions whose evidence was missing (T1, T11). |
| Answers with any citation | 1 / 13 (T18: mechanically valid, wrong claim) |

### Performance (Mac only)

| Metric | Min / median / max |
| --- | --- |
| Context (prompt) tokens | 5039 / 5865 / 6140 |
| Output tokens | 30 / 89 / 384 |
| Time to first token | 8.4 / 10.2 / 11.0 s |
| Full answer | 9.1 / 11.9 / 18.2 s |
| Prompt processing | ≈545–580 tokens/s |
| Generation | ≈51–54 tokens/s |
| Generation server peak RSS | 1.28 / 1.30 / 1.39 GB |

The embedding server ran separately at ≈1.0 GB. Large chunks fill the token budget: T1 got only 3 of its 8 retrieved chunks.

## Verdict

- **Is this model enough?** No. Even when the evidence was in its context, it never followed the citation format, never abstained and sometimes contradicted the excerpts it cited.
- **Where is the main error?** In generation, for now. Of the 6 questions whose required evidence was fully in context, 2 got correct content, 3 partially correct and 1 wrong, all of them uncited. Retrieval is a second cause: T1 and T11 had no required evidence in context. Even then the model should have abstained, and it did not.
- **D1 recommendation:** citations must be enforced by the server, not trusted from free text.
  - The model emits structured claims (JSON schema or grammar-constrained), each with an excerpt id, a line range and a verbatim quote.
  - The server mechanically checks every claim: the excerpt exists, the lines are inside it and the quote occurs on those lines. Claims that fail are dropped.
  - If no claim survives, or retrieval is weak, the answer is a deterministic `INSUFFICIENT_EVIDENCE`.
  - Before building D1, run the same 13 questions in that structured format against a larger local coder model. Qwen2.5-Coder-7B-Instruct Q4_K_M (≈4.7 GB, Apache-2.0) is the obvious candidate; downloading it needs a separate permission. Also shrink the excerpts (line windows around matches instead of whole chunks) to cut the ~10 s time to first token.
