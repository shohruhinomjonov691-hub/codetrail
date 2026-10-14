# D0b — schema-constrained grounded answers (2026-10-15)

**Not a CodeTrail feature.** This is one predefined variant, with no prompt grid and no tuning.

- **Model:** the same pinned Qwen2.5-Coder-1.5B-Instruct Q4_K_M; no new model was downloaded.
- **Runtime:** llama.cpp b11606 on loopback (`scripts/gen-server.sh`), one request at a time. Temperature 0, at most 512 output tokens.
- **Questions:** the same 13 tuning questions as D0; the holdout set was not touched.
- **Machine:** development Mac (M2, 16 GB). **These are not server results.**
- **Review status:** Codex's role-slots verdict covers `803d673` only. Neither D0 (`c670884`) nor this D0b commit has been reviewed.

## Variant

- **Compact excerpts** (`src/eval/grounded.ts`): from each chunk, keep the lines that contain a query term, plus 2 lines around them. Small gaps are merged. An excerpt has at most 30 lines; a chunk with no matching line contributes its first 15 lines. Original line numbers are kept and gaps are shown as `…`.
- **Token budget:** at most 3000 evidence tokens. Excerpts that do not fit are skipped, and each run records what was included and what was dropped.
- **Output:** JSON constrained by a schema through llama-server `response_format: json_schema`: `{status: answered|insufficient_evidence, claims: [{text, source_id, lines: {start, end}, quote}]}`, with at most 6 claims.
- **Fail-closed validator:** any of the following rejects the **whole** answer. Claims are never dropped to keep the rest.
  - the output is not valid JSON or has the wrong shape;
  - `answered` with no claims, or `insufficient_evidence` with claims;
  - a claim cites an unknown excerpt or lines that excerpt did not show;
  - a quote is not verbatim (whitespace-normalised) on its cited lines.
- **Two context paths:**
  - **retrieval:** the shipped default search (hybrid, `rank`, k=8). **This is the end-to-end result.**
  - **golden:** windows (±2 lines) around the fixture's required evidence, or around the absence evidence for T14. **Diagnostic only; not an end-to-end result.** T17 and KA1 have no golden evidence (n/a).
- **Manual grading:** passing the validator does not prove a claim. Every claim was checked against the code by hand (`grades.json`).
  - **Answerable success:** the validator passes, the status is `answered`, every claim is true and supported by its cited lines, and the answer addresses the question.
  - **Abstention questions:** success is `insufficient_evidence`.
  - An abstention on an answerable question is counted as abstention, not success.

## Results

| Path | Answerable: success | Valid but wrong | Abstained | Rejected | Unanswerable: correct abstention |
| --- | --- | --- | --- | --- | --- |
| **retrieval (end-to-end)** | **0 / 10** | 2 (T1, T18) | 1 (T12) | 7 | 2 / 3 (T17, KA1; T14 answered) |
| golden (diagnostic) | 2 / 10 (T8, K10) | 1 (K3) | 2 (T12, T18) | 5 | 1 / 1 (T14) |

- **Answer coverage** (answerable questions with an accepted, fully correct answer): retrieval 0 / 10, golden 2 / 10. Both golden successes answer the question fully.
- **Not "abstain on everything":** the model answered most questions. The retrieval path answered 9 of the 10 answerable questions and abstained on 1.
- **Reasons for the 12 rejections:**
  - JSON cut off at 512 tokens because claims were repeated or verbose: T8, K2, K3 (all retrieval);
  - wrong lines or lines that were not shown: T4, T11, K4, T14;
  - quote not verbatim (line-number prefixes, reformatted or merged code, an invented line): T1g, T4g, K2g, K4g, K10;
  - lines off by one with true content: T11g.

  In 6 rejected answers the content was actually true (T4, T1g, T11g, K2g, K4g, K10), but the citation was not exact.
- **The validator is not enough:** T1 and T18 (retrieval) and K3 (golden) pass every mechanical check, yet their claims are false or unsupported. T18 quotes the "removed" decision verbatim while the same excerpt says the module was re-added.

| Metric (min / median / max) | retrieval | golden | D0 (free text) |
| --- | --- | --- | --- |
| Prompt tokens | 1460 / 2891 / 3150 | 260 / 355 / 596 | 5039 / 5865 / 6140 |
| Output tokens | 22 / 315 / 512 | 15 / 172 / 507 | 30 / 89 / 384 |
| TTFT | 2.0 / 4.4 / 4.8 s | 0.1 / 0.3 / 0.7 s | 8.4 / 10.2 / 11.0 s |
| Full answer | 2.3 / 9.7 / 13.2 s | 0.3 / 2.9 / 8.5 s | 9.1 / 11.9 / 18.2 s |
| Generation server peak RSS | 1.35 / 1.35 / 1.44 GB | 1.34 / 1.35 / 1.50 GB | 1.28 / 1.30 / 1.39 GB |

Compact excerpts cut the retrieval context roughly in half and TTFT from about 10 s to about 4.4 s.

**Budget losses:** budget drops removed evidence in two cases. In T18, `destination.module.ts` was skipped. In T12, large CHANGELOG excerpts used the budget; the required line was still in S1.

## Verdict

- **Is the 1.5B model enough?** No, even with a schema and a strict validator. The end-to-end result has 0 grounded successes out of 10 answerable questions, and even golden evidence gives only 2 out of 10.
- **Where is the main error?** In generation. With golden evidence the model still cites the wrong lines, rewrites quotes, abstains when the answer is in front of it (T12, T18) and adds outside knowledge (K3). Retrieval adds noise on top of that. Doc-heavy contexts led to two answers that pass validation but are wrong (T1, T18). Large excerpts also squeeze the budget.
- **What D0b shows:** schema output plus fail-closed validation does stop most bad answers from being shown (12 of 24 rejected), and abstention on the two truly unanswerable retrieval questions worked. But mechanical checks still let wrong answers through (3 of 24). A D1 that shows validated answers would therefore still need a better model, and the answers would still need to be presented as checkable quotes rather than trusted conclusions.
