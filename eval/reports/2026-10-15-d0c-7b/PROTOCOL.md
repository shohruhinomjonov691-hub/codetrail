# D0c protocol — Qwen2.5-Coder-7B-Instruct Q4_K_M on the Mac (written before the run)

This protocol was fixed and committed before any 7B generation. It defines one predefined run: no prompt grid, no retries with other settings, no holdout.

## Model and runtime

- **Model:** Qwen2.5-Coder-7B-Instruct Q4_K_M from the official repo `Qwen/Qwen2.5-Coder-7B-Instruct-GGUF` (Qwen org, not gated).
  - Revision `13fb94bfda8c8cf22497dc57b78f391a9acb426a`, single file `qwen2.5-coder-7b-instruct-q4_k_m.gguf`.
  - SHA-256 `509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c`, 4 683 073 536 bytes.
  - License Apache-2.0, checked in the repo's LICENSE and model card.
  - Downloaded to `~/Developer/codetrail-models/models/` (outside the repo) and verified against that SHA-256. It is pinned in `models.lock.json` → `generation7b`.
- **Runtime:** the same llama.cpp b11606 build. `scripts/gen-server.sh generation7b` runs `-c 8192 -np 1 --cache-ram 0` on `127.0.0.1:8082` and checks the SHA-256 at start. No server or global settings are touched.
- **Requests:** one at a time; temperature 0, top_k 1, seed 0.
- **Machine:** development Mac (M2, 16 GB). Results are Mac results, not server results.

## Questions and contexts (unchanged from D0b)

- **Questions:** the same 13 tuning questions — GoTrip T12, T4, T1, T8, T18, T11, T14, T17; ky K4, K10, K3, K2, KA1.
- **Retrieval context (end-to-end result):** shipped default search (hybrid, `rank`, k=8) and the same compact excerpts as D0b (`compactLines`: query-term lines ±2, at most 30 lines, original line numbers), with a 3000-token evidence budget. Included and dropped excerpts are recorded.
- **Golden context (diagnostic only, never reported as end-to-end):** the same ±2-line windows around the fixture's required evidence (T14: absence evidence) as D0b. T17 and KA1 have none (n/a).

## Answer format — server-derived citations

- **Schema** (`CITED_SCHEMA`, enforced through llama-server `response_format: json_schema`): `{status: answered|insufficient_evidence, claims: [{text ≤ 240 chars, source_id S#, lines {start, end}}]}`, with at most 6 claims.
- **No quote field.** The model names an excerpt and a line range only. The server copies the cited lines itself (path, source and exact text), so the model is not asked to reproduce code.
- **Output budget = 1536 tokens.**
  - Pessimistic bound per claim: 240 chars at 2 chars/token gives 120 tokens, plus ~50 tokens of structure, so ~170 tokens.
  - 6 claims plus the envelope come to ~1060 tokens; 1536 gives ~1.45× headroom.
  - A response that ends on the length limit (`finish_reason ≠ stop`) is **incomplete and fails**.
  - The prompt (≤ ~3.4k tokens) plus 1536 tokens fits in the 8192-token context.

## Validation and grading

- **Fail-closed validator** (`validateCitedAnswer`). Any of the following rejects the **whole** answer; claims are never dropped to keep the rest:
  - incomplete generation;
  - invalid JSON or the wrong shape;
  - `answered` with no claims, or `insufficient_evidence` with claims;
  - an unknown excerpt, a cited line that was not shown, a reversed range, or more than 12 cited lines.
- **Manual grading of every claim against the code** (snapshot file store), whatever the validator said. Passing the validator does not make an answer correct.
- **Outcome classes:**
  - *success*: validator pass, status `answered`, every claim true and supported by its cited lines, and the answer addresses the question. For abstention questions, success is `insufficient_evidence`.
  - *valid-wrong*: the validator passes but at least one claim is false or unsupported.
  - *abstained*: `insufficient_evidence` on an answerable question. This is not a success.
  - *rejected*: the validator failed.
- **Reported separately per path:** grounded success, wrong claims, abstention, coverage (answerable questions with a full or partial correct answer), TTFT, full time and peak RSS.

## Memory guard

- **Before and during every request:** `kern.memorystatus_vm_pressure_level` is sampled. The run **stops** at level ≥ 2 (warn), and that is recorded.
- **Start state:**
  - pressure level 1 (normal);
  - `memory_pressure` reports 50% free;
  - swap already at ~11 GB used, from other apps before the run.

## Protocol differences from the 1.5B D0b run (besides the model)

| | D0b (1.5B) | D0c (7B) |
| --- | --- | --- |
| Quote | Model copied a verbatim quote, and the validator matched it | No quote; the server derives the cited text from the lines |
| Output budget | 512 tokens, not derived (3 answers were truncated) | 1536 tokens, derived from schema bounds; truncation counts as fail |
| Schema bounds | No string limits | Claim text ≤ 240 chars; source id pattern `S#` |
| Cited span | Any lines shown | At most 12 lines |
| Finish reason | Not checked (cut-off JSON failed JSON parsing) | Must be `stop` |
| Prompt wording | Asked for a verbatim quote | Asks for lines only; otherwise the same rules |

Same in both runs: questions, retrieval, compact excerpts, 3000-token evidence budget, golden windows, temperature/seed, server context, runtime build and grading rules. A change in results is therefore model **plus** these protocol differences; it is not attributed to the model alone.
