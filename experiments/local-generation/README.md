# Archived: local generation experiments (D0, D0b, D0c — 2026-10-15)

These scripts benchmarked local LLMs (Qwen2.5-Coder 1.5B/7B on llama.cpp) for grounded answers. They are kept as the provenance of the reports in `eval/reports/2026-10-15-d0-llm/`, `-d0b-grounded/` and `-d0c-7b/`. **They are not part of CodeTrail.** Production answer generation uses the OpenAI API (`src/generation/`).

- **Results:**
  - The 1.5B model gave 0/13 (free text) and 0/10 (schema + validator) strictly grounded answers.
  - The 7B run was stopped by the memory guard on the development Mac before any generation.
- **Not maintained.** The scripts reference helpers that were removed or moved, for example the D0b quote validator. To re-run one, check out the commit it ran at: D0 `c670884`, D0b `80be840`, D0c `8d6c7b3`.
- **Model pins:** `models.json` holds the archived pins (official Qwen GGUF repos, revisions, SHA-256). Downloaded weights live outside the repository (`~/Developer/codetrail-models/models/`) and are not needed by CodeTrail; delete them by hand if you want the disk space back.
- **Paths in old reports.** File paths in those reports (`scripts/gen-server.sh`, `scripts/d0*-bench.mjs`, `src/eval/grounded.ts`) refer to the repository at the commit each report was written. The scripts now live here, and the production excerpt/validator code lives in `src/answer/grounded.ts`.
