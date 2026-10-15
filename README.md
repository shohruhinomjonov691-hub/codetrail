# CodeTrail

CodeTrail is a codebase RAG for TypeScript/JavaScript projects. It answers questions about a repository with evidence: every answer points to `source@commit:path:Lx-Ly` citations that can be checked against the exact code.

## At a glance

- **Public demo scope: GoTrip only.** The server is pinned to one snapshot of the GoTrip frontend and backend (`CODETRAIL_PUBLIC_PIN=gotrip:d75aaec9…`). Requests for any other project or snapshot are refused, and there is no way to upload or connect a repository from the UI. `sindresorhus/ky` is used only as an offline evaluation control corpus.
- **Local retrieval.** Embeddings (Qwen3-Embedding-0.6B on a local llama.cpp server) and hybrid BM25 + vector search run locally. Plain search never calls an external service.
- **OpenAI for explanations only.** Pressing **Explain with AI** sends the question and compact excerpts of the retrieved GoTrip chunks (≈12k characters at most) to the OpenAI Responses API with `store: false`; the model is set by configuration, default `gpt-6-luna`.
  - The model may only cite excerpt lines. The server builds every citation (file, lines, commit, exact code) from the snapshot and rejects the whole answer if anything is invalid.
  - When the evidence is insufficient, the answer says so instead of guessing.
- **Fallback.** If the key is missing, quota or credit is exhausted, the provider rate-limits, times out or errors, or the answer fails validation, the local sources are still returned with a clear "AI explanation unavailable" notice. No generated text is invented.
- **UI.** Dark theme, English and 한국어 (EN/KO switch). Example questions, citation cards with syntax-highlighted code, loading/empty/insufficient/fallback/error states, desktop and mobile layouts.
- **Status.**
  - Implemented and tested with mock providers: onboarding and exact-commit snapshots, safety filters and secret scanning, AST chunking, the local index and hybrid search, the HTTP API and UI, grounded OpenAI explanations, and the Docker setup.
  - One real OpenAI request (GoTrip question T4, 2026-10-15) returned a valid two-claim answer whose citations matched the code: 3228 input and 134 output tokens, about $0.0004. A single result is not a quality guarantee.
  - The Docker stack was built and checked in local Docker.
  - **Not deployed to any server yet** (see `DEPLOY.md`).
- **Real limitations:**
  - Retrieval misses the 0.80 Recall@8 target on the GoTrip tuning questions: 0.656 by default, 0.688 with the experimental role-slots selection.
  - A citation shows where a claim points, not that the claim is true.
  - Korean questions can rank GoTrip's Korean locale files first.
  - Prompt injection through repository text is reduced, not eliminated.
  - Caches and rate limits are in memory per server process.
  - Building the index on a small CPU takes long: about 106 minutes for GoTrip in a 2-CPU container.
- **Local generation is not used.** The local LLM experiments (D0–D0c) ended without a usable result and are archived in `experiments/local-generation/`.

## What stage B does

1. **Projects and sources.** A project groups one or more sources. Example: a frontend and a backend repository. Each source is either a local Git repository or a public GitHub repository URL.
2. **Exact-commit snapshots from a quarantined clone.** Each source is pinned to a full commit SHA. It is read from a bare clone in a unique staging directory under `data/quarantine/<project>/`. That clone is deleted when the run ends: after success, after a blocked snapshot and after an error. Raw Git history therefore never becomes a persistent or served artifact, and only `data/snapshots/` is meant to be consumed. The source repository's working tree, index and refs are never read or modified. Uncommitted and untracked files are never indexed.
3. **Safe onboarding.**
   - **Allowlist:** `.ts .tsx .mts .cts .js .jsx .mjs .cjs .json .md .mdx .graphql .gql .yml .yaml`.
   - **Denylist:** `.env*`, keys and certificates, `.npmrc`, credential files, lockfiles, `node_modules/`, build output, `uploads/`, `vendor/`, `.agents/`, `.claude/`, IDE folders, `*.min.js`, `*.d.ts`, logs and dumps.
   - **Content checks:** files over 512 KB, binary content, invalid UTF-8, lines over 2000 chars and minified files are excluded.
   - **Never indexed:** symlinks and submodules.
   - **Path validation:** paths with `..`, absolute paths, backslashes or control characters are rejected.
   - **Local repositories:** the repository path must stay inside `CODETRAIL_LOCAL_ROOTS`. So must its real git dir, its common dir (worktrees), its object store, every object store reachable through alternates (followed recursively, with cycle and depth protection) and any symlinked object files. Symlinked directories inside the object store are refused. Git runs with an isolated environment: inherited `GIT_*` variables are dropped, except tracing switches. User and system git config are not read: `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` are set to `/dev/null` and `GIT_CONFIG_NOSYSTEM=1`. This means `~/.gitconfig` rules such as `url.<x>.insteadOf` and credential helpers cannot redirect or authenticate a clone; only CodeTrail's own `-c` options apply. This is checked when the source is registered and again before every snapshot. With no roots configured, local sources are refused.
   - **Reasons recorded:** every excluded file is listed in the manifest with its reason.
4. **Secret scan before anything is persisted.**
   - **High-confidence detectors** block the whole snapshot. They cover private keys, AWS, GitHub, OpenAI, Anthropic, Google, Slack, Stripe and npm tokens, URLs with embedded credentials, and JWTs. A blocked snapshot writes only a report.
   - **Medium-confidence detectors** exclude the file. They look for high-entropy `password`/`secret`/`token`/`apiKey` assignments.
   - **Placeholders:** a value is ignored only if the whole value is a placeholder, such as `<password>`, `${DB_PASSWORD}`, `{{TOKEN}}`, `xxxx` or `your-api-key-here`. Words like `test`, `example` or `mock` inside a real credential do not hide it.
   - **Findings show** only the source, path, detector name and count. Matched values, lines and excerpts are never printed, logged or stored.
5. **AST chunking.**
   - **TS/JS:** the TypeScript compiler API (parse only) produces chunks for functions, classes, methods, types, enums, variables and module code. Decorators and the doc comments directly above a declaration stay inside its chunk.
   - **Oversized code:** large classes are split into a header chunk plus one chunk per method. Large functions are split at statement/JSX/property boundaries into numbered parts.
   - **Limits:** every chunk has at most 120 lines and 6000 characters.
   - **Other formats:** Markdown splits at headings. JSON, YAML and GraphQL split at shallow-indent lines.
6. **Deterministic, immutable artifacts.**
   - **Snapshot id:** `snapshot_id = sha256(project_id, source_id@commit…, config hash)`. The config hash covers the snapshot schema, the filters, scanner and chunker versions and the project excludes.
   - **Chunk id:** each chunk id is a hash of project, source, commit, path and line range.
   - **Reading:** a snapshot directory that does not exist is `UNKNOWN_SNAPSHOT`. An existing one whose `manifest.json`, `report.json` or `chunks.jsonl` is missing, unparsable, of the wrong shape or names another project/snapshot fails with `SNAPSHOT_CORRUPT` and the rebuild command.
   - **No overwrites:** an existing snapshot is never overwritten. A new commit produces a new snapshot next to the old one.
   - **Exact text:** every chunk's `text` is exactly lines `start_line..end_line` of the committed file. A UTF-8 BOM and CRLF line endings are kept as they are.
   - **Coverage:** every non-blank line that is not only closing punctuation lands in some chunk. This includes comments after the last member of a large class.
   - **Stored files (snapshot schema 2, 2026-10-15):** the exact committed bytes of every **included** file are stored as `files/<sha256>`. They are written in the same quarantine run, after the content filters and the secret scan. Excluded files, secret-suspected files and blocked snapshots store nothing. Readers that need whole files (the identifier scan) use only this store, never chunks and never git:
     - the bytes must hash to the manifest's `sha256`;
     - every chunk of the file must belong to the source's commit and the snapshot, and its text must be exactly those lines of the stored file;
     - the chunk count must match the manifest.
     Any mismatch or missing file fails with `SNAPSHOT_CORRUPT`. A schema-1 snapshot has no stored files and fails with `SNAPSHOT_OUTDATED`, naming the rebuild command `codetrail snapshot create <project>`. Because the schema is part of the config hash, the rebuild gets a new snapshot id next to the old one; chunks and chunk ids are unchanged.
7. **Concurrency.**
   - **Snapshots:** snapshot creation holds a per-project cross-process lock. Parallel runs wait (timeout 10 min), then report `exists`.
   - **Registry:** registry updates run as a locked read–modify–write (timeout 10 s).
   - **Lock mechanism:** each lock is an OS file lock — an open `BEGIN EXCLUSIVE` transaction on `data/locks/<name>.lock.sqlite`. A live holder keeps the lock even while paused; if the holder process dies, the OS releases it at once. Nothing is broken by age or pid. A waiter checks a monotonic deadline before every retry and fails with `LOCK_TIMEOUT`; it never enters after its deadline. Locks are for a single host on a local filesystem.

## Usage

Requires Node.js ≥ 22.12 and `git`.

```bash
npm install
npm run build
cp .env.example .env   # then set CODETRAIL_LOCAL_ROOTS (and optionally CODETRAIL_DATA_DIR)
```

```bash
# a project with two sources pinned to exact commits
npm run cli -- project add gotrip --name GoTrip
npm run cli -- source add-local gotrip backend  /abs/path/to/backend  --ref master
npm run cli -- source add-local gotrip frontend /abs/path/to/frontend --ref master
npm run cli -- snapshot create gotrip --ref backend=<40-char sha> --ref frontend=<40-char sha>

# a public GitHub repository
npm run cli -- project add ky
npm run cli -- source add-github ky lib https://github.com/sindresorhus/ky --ref main
npm run cli -- snapshot create ky

npm run cli -- snapshot list gotrip
npm run cli -- snapshot show gotrip <snapshot_id>
```

- `project add` accepts repeatable `--exclude <glob>` for project-specific excludes (`**`, `*`, `?`).
- `snapshot create` exits with `2` when the snapshot is blocked by a secret finding.
- Bad input fails with a stable error code, for example `INVALID_GITHUB_URL` or `LOCAL_PATH_OUTSIDE_ROOTS`.

### Configuration

| Variable | Purpose |
| --- | --- |
| `CODETRAIL_DATA_DIR` | Where the registry, locks, quarantined clones and snapshots are written. Default `./data` (git-ignored). |
| `CODETRAIL_LOCAL_ROOTS` | Colon-separated absolute directories. A local source must resolve inside one of them after symlinks are followed. If unset, local sources are disabled. |

### Artifacts

```text
data/
  registry.json                         projects and sources
  locks/                                cross-process lock files
  quarantine/<project>/                 per-run bare clones; deleted after each run
  snapshots/<project>/<snapshot_id>/
    manifest.json                       every tree entry: blob, sha256, status, exclusion reason
    chunks.jsonl                        one chunk per line
    files/<sha256>                      exact bytes of each included file (schema 2)
    report.json                         counts, secret findings (no values), created_at
  snapshots/<project>/blocked/<id>.json report for a blocked snapshot (no chunks)
```

`data/`, `*.jsonl` and `.env` are git-ignored.

## Retrieval (stage C1–C2)

**Pinned models.** `models.lock.json` pins the runtime and the embedding model, including URL, version, license and SHA-256. The weights themselves are never committed and never copied into an image.

| Component | Pin |
| --- | --- |
| Runtime | llama.cpp `llama-server` release `b11606` (commit `1b70350c9`, MIT) |
| Embedding model | Qwen3-Embedding-0.6B `Q8_0` (Apache-2.0, 1024 dims), Hugging Face revision `370f27d7` |

Compatibility was checked on macOS arm64: the official model-card similarity example is reproduced within 0.001.

```bash
CODETRAIL_MODELS_DIR=~/Developer/codetrail-models node scripts/fetch-models.mjs   # downloads + verifies sha256
CODETRAIL_MODELS_DIR=~/Developer/codetrail-models scripts/embed-server.sh          # loopback only, prompt cache off
npm run cli -- index  gotrip <snapshot_id>
npm run cli -- search gotrip <snapshot_id> "where is the tour inquiry sent?" --mode hybrid --k 8
npm run cli -- eval   gotrip <snapshot_id> eval/gotrip.tuning.json --mode all --k 8 --out eval/reports/<date>
```

- **Embedding recipe.**
  - Last-token pooling with L2-normalized vectors.
  - Queries use the official format `Instruct: <task>\nQuery:<question>`. Documents get no instruction; their input is `File / Symbol / text`.
  - The recipe hash keys both the embedding cache and the index, so vectors from different models or settings never mix.
- **No silent truncation.**
  - Every input is token-counted first, using the server tokenizer with special tokens.
  - If anything exceeds `maxTokens` (4096), indexing aborts and lists the offending chunks.
  - `llama-server` itself also rejects over-long input with HTTP 400.
- **Atomic, verified indexes.**
  - Each index is written to `data/indexes/<project>/<snapshot>/<index_id>/` (`index.sqlite` with FTS5, `vectors.f32`, `probe.f32`, `meta.json`).
  - It is built in a private temp directory under a cross-process lock and then renamed into place; `meta.json` is written last.
  - Loading re-checks the project, snapshot, recipe, the snapshot's `chunks.jsonl` hash and every file's SHA-256.
- **Model identity.**
  - A model's identity is the SHA-256 of the model file the server actually loaded, plus the runtime build the server reports (`build_info`) and the recipe hash.
  - It is confirmed only if the server reports the same file (by real path) that CodeTrail verified against `models.lock.json`, and reports its build. Otherwise indexing and vector search fail with `MODEL_MISMATCH`.
  - The model file is hashed fresh once per operation (index build or search), through a single file descriptor. If the file is replaced or modified while it is being read, the result is rejected. No size/mtime digest cache is used. This proves what is on disk at verification time, not what the server holds in memory.
  - A probe-embedding cosine is never used as identity.
- **Embedding cache.**
  - Vectors are reused only under an identical confirmed identity. The cache file is `data/embed-cache/v3-<hash>.sqlite`.
  - `llama-server` does not report its pooling or normalization settings. As an extra guard, a run whose probe embedding is not byte-identical to the one stored with the cache neither reads nor writes the cache (`embedded.cache = disabled-probe-differs`). This guard can only reject, never accept.
  - Every vector — query, document, probe, cache read/write, index publish/load — must pass one strict rule: a `Float32Array` of exactly `dims` elements, all finite, non-zero, unit norm. The probe is checked before the cache is opened. Bad cached rows are recomputed.
  - Index vectors are validated again before publish and on load.
  - Concurrent first-time opens are safe: `busy_timeout` is set first, and WAL/schema setup retries lock contention for a bounded time. Any other failure fails with `CACHE_FAILED`, the connection is closed and the original cause is kept for diagnostics. This covers open errors, an existing file with a wrong schema and reference-probe setup.
- **Older artifacts.**
  - Indexes from older schemas (1 and 2, built before identity binding) are refused with `INDEX_OUTDATED`. The error names the rebuild command, `codetrail index <project> <snapshot>`, which writes a new index next to the old one.
  - Older cache files (no prefix, or `v2-`) are never read. They can be deleted by hand.
- **Query-time checks.** The provider's confirmed identity must equal the index identity exactly. The probe drift check (cosine ≥ 0.9999) runs after that and can only reject. Query and probe vectors must be finite, non-zero unit vectors with the index dimension before any scoring. Normalization is overflow-safe: `[1e308, 1e308]` becomes `[0.7071, 0.7071]`.
- **Local-only providers.**
  - The provider URL must be loopback, or an internal host listed in `CODETRAIL_PROVIDER_HOSTS`.
  - Credentials, paths and query strings in the URL are rejected.
  - Redirects are never followed.
- **Limits.**
  - Query embedding: 10 s timeout. Document batch: 120 s timeout.
  - At most 2 concurrent requests; batches of 8 texts.
  - Question: at most 1000 characters, and the fully formatted query must fit the recipe's token limit (counted with the server tokenizer before embedding; otherwise `TOKEN_LIMIT`). `k`: 1–20.
- **Server flags.** Use `--cache-ram 0` on the embedding server. With the default prompt cache, the server's memory footprint on the development Mac grew to 10–11 GB; with the cache off it was about 1 GB, and the vectors were identical.

## Retrieval evaluation (stage C3)

This evaluation measures **retrieval only**; no answers are generated. The numbers are **tuning-set results**: there are few questions, and the defaults were chosen on these same questions. The holdout set was neither written nor read. All timings were measured on the development Mac, not a server.

- **Fixtures (schema 2):** `eval/gotrip.tuning.json` (GoTrip T1–T18) and `eval/ky.tuning.json` (`sindresorhus/ky`, 10 questions plus 2 abstention).
  - Each answerable question lists `required` evidence groups, where any one alternative in a group satisfies it, plus `optional` evidence.
  - Every evidence item names an exact single-line anchor. It is validated against the evaluated snapshot: the file must be included and the anchor must appear inside the range.
  - The runner refuses a fixture whose `snapshot_id` is not the evaluated snapshot. In that case nothing is written.
- **Scoring (`anchor-line/required-groups v2`):**
  - An evidence item counts as retrieved only when **one** retrieved chunk contains its anchor line, and that line in the chunk text contains the anchor. Chunks are never combined, and a range overlap alone does not count.
  - Hit@8: at least one required group is satisfied.
  - Evidence Recall@8: satisfied required groups divided by all required groups. Optional evidence is reported but never counted in the denominator.
  - MRR@8: reciprocal rank of the first chunk that satisfies any required group.
  - Abstention questions are kept out of the recall numbers; their top-1 scores are reported separately.
- **"Is X used?" questions** (T16) also get an **identifier-occurrence scan**, reported apart from retrieval.
  - **How it works:** it uses the TypeScript parser over the **full stored text** of the snapshot's included code files (checksum-verified, see "Stored files"; never rebuilt from chunks). Every `Identifier` token with exactly that name counts as a separate occurrence, except the one declaration token named by the fixture. `START_X`, `START_X$` and `$START_X` are different identifiers. Comments, string and template text and JSX text are not counted, while expressions inside `${…}` and `{…}` are. Escaped spellings such as `\u0053TART_X` count as the identifier they resolve to.
  - **Declaration token:** the declaration's own name slot of a variable, function, class, interface, type alias, enum or enum member, namespace/module, type parameter, parameter, binding element, method, property, get/set accessor, object-literal property, import (default, namespace, named, `import X = …`) or `export * as X`. Calls, property accesses, shorthand properties (`{ X }`), export lists and type references are occurrences.
  - **What it is not:** this is a syntactic token count. It is not binding-aware semantic reference analysis, and it does not prove runtime usage. Excluded files (for example generated code or `node_modules`) are not scanned.
  - **T16 result:** in snapshot `d75aaec9…` (schema 2, same commits and chunks as the earlier `14bcc5ca…`; frontend source, 195 included code files read from the verified file store), `START_CONVERSATION` has its declaration token at `apollo/user/mutation.ts:414:14` and 0 other occurrences (expected 0). This says nothing about files outside that snapshot.
- **Command:**
  ```bash
  npm run cli -- eval gotrip <snapshot_id> eval/gotrip.tuning.json --mode all --k 8 --out eval/reports/<date>
  ```

v2 results. The reports were regenerated on the schema-2 snapshots (GoTrip `d75aaec9…`, ky `6b9989f3…`; same commits, identical chunks and manifest file lists, every vector from the embedding cache); all metrics and per-question results are identical to the schema-1 run. Embedding: Qwen3-Embedding-0.6B Q8_0 on llama.cpp b11606. "Before" is the pre-tuning setting (BM25 `[2,3,1,1]`, RRF k 60, pool 50); "shipped" is the tuned default (BM25 `[3,3,1,2]`, RRF k 30, pool 100). The tuning was **not** redone for v2.

| Corpus | Mode | Hit@8 before → shipped | Evidence Recall@8 before → shipped | MRR@8 before → shipped |
| --- | --- | --- | --- | --- |
| GoTrip (16 + 2) | bm25 | 0.500 → 0.438 | 0.438 → 0.406 | 0.362 → 0.352 |
| | vector | 0.750 → 0.750 | 0.625 → 0.625 | 0.472 → 0.472 |
| | **hybrid** | 0.688 → **0.812** | 0.562 → **0.656** | 0.457 → **0.476** |
| ky (10 + 2) | bm25 | 0.200 → 0.200 | 0.200 → 0.200 | 0.034 → 0.029 |
| | vector | 0.600 → 0.600 | 0.600 → 0.600 | 0.309 → 0.309 |
| | **hybrid** | 0.600 → **0.700** | 0.600 → **0.700** | 0.281 → **0.249** |

- **Target missed.** The target was hybrid Evidence Recall@8 ≥ 0.80; v2 gives 0.656 (GoTrip) and 0.700 (ky).
- **Abstention.** Retrieval scores alone cannot separate unanswerable questions (see the per-report abstention tables). Abstention has to be decided at answer time (stage D), with citation checks.
- **Role-slots experiment (2026-10-15, not a default):** `--selection role-slots` (search) / `--mode hybrid-role` (eval) keeps the hybrid ranking but takes at most `k - floor(k/4)` implementation chunks (6 of 8) and `floor(k/4)` test/doc/data chunks (2 of 8) in rank order, filling empty slots by rank. Roles come from generic path/language rules (`src/retrieval/role.ts`). One predefined variant, same fixtures/k/indexes/scoring: hybrid Recall@8 GoTrip 0.656 → 0.688, ky 0.700 → 0.800; no question got worse. **The 0.80 target is still missed for GoTrip (0.688, even with role-slots)**; ky reaches 0.800 only with role-slots. It stays opt-in (the default selection is `rank`) because doc/test/config questions could lose evidence and the tuning set barely covers them. Details: `eval/reports/2026-10-15-role-slots/`.
- **Reports:** `eval/reports/2026-10-14-v2-baseline/` and `eval/reports/2026-10-14-v2-tuned/`. The earlier `eval/reports/2026-10-14-{baseline,tuned}/` use the superseded v1 scoring (line overlap, every expected item required). They are kept for history and must not be compared with v2.

## Search API, AI explanations and UI

```bash
npm run build
scripts/embed-server.sh &                 # local embeddings (CODETRAIL_MODELS_DIR=…)
CODETRAIL_PUBLIC_PIN=gotrip:d75aaec921284e35893092a7 npm run cli -- serve --port 8080   # http://127.0.0.1:8080
npm run cli -- explain gotrip "Where does AuthGuard get the token from and how is it verified?"   # operator CLI, one explanation
```

- **The public server is pinned to one project and snapshot.** `serve` needs `CODETRAIL_PUBLIC_PIN=<project>:<snapshot>` (the public demo: `gotrip:d75aaec9…`, the GoTrip frontend + backend snapshot) and refuses to start without it, or if that snapshot has no usable index. The UI shows that project only: there is no project picker and no way to upload or connect a repository. Projects and snapshots are created by the operator with the CLI (`project add`, `source add-*`, `snapshot create`, `index`); the internal modules stay multi-project (the operator CLI `explain <project>` can address any indexed project).
- **Requests.** `POST /api/search` and `POST /api/explain` take `{question, language?}` (`language`: `en` | `ko`, default `en`); `project_id`/`snapshot_id` may be omitted and are then the pinned ones, any other value is refused with 403 (`PROJECT_NOT_ALLOWED` / `SNAPSHOT_NOT_ALLOWED`). Retrieval reads only the pinned project's index and the model only receives its excerpts.
- **Search (`/api/search`)** returns the top 8 hybrid hits with `source@commit:path:Lx-Ly`, role and the exact chunk text from the snapshot. It never calls the model.
- **AI explanation (`/api/explain`)** runs the same search and builds compact, line-numbered excerpts (at most `CODETRAIL_AI_MAX_CONTEXT_CHARS`, default 12 000). It then makes **one** OpenAI call with a strict JSON schema: `{status, claims[{text, source_id, lines}]}`.
  - The model names only an excerpt and a line range. The server copies the cited code, commit and path from the snapshot.
  - The validator is fail-closed. Any unknown excerpt, unshown line, oversized claim, invalid JSON or incomplete response (`max_output_tokens`) rejects the **whole** answer; no partial answer is shown.
  - A citation shows where a claim points, not that the claim is true; the UI says so.
- **Insufficient evidence.** If the model reports `insufficient_evidence`, or search finds nothing, the response is "Tanlangan loyiha bo‘yicha yetarli dalil topilmadi" plus the sources.
- **Fallback.** The local sources are always returned (file, lines, commit, code) together with "AI tushuntirish hozir mavjud emas — kod manbalari" and a reason when any of these happens:
  - no key, a rejected key, exhausted quota or credit, or the provider's rate limit;
  - a timeout or a provider error;
  - a refusal, or an answer that is invalid or incomplete;
  - CodeTrail's own per-client or daily limit.

  A failure of local search itself (embedding server or index) is a separate HTTP 503 `SEARCH_UNAVAILABLE`.
- **Cost controls:**
  - no automatic retries and no fallback model;
  - at most `CODETRAIL_AI_CONCURRENCY` (2) parallel calls;
  - `CODETRAIL_AI_RATE_PER_MINUTE` (6) per client and `CODETRAIL_AI_DAILY_LIMIT` (200) per server;
  - an in-memory cache of validated answers keyed by project, snapshot, index, model, prompt version and normalised question;
  - output capped by `CODETRAIL_AI_MAX_OUTPUT_TOKENS` (2048, including reasoning).
- **Model:** `CODETRAIL_OPENAI_MODEL`, default `gpt-6-luna`.
  - Choice: OpenAI's model page (checked 2026-10-15) recommends it for cost-sensitive, high-volume work and lists Structured Outputs and the Responses API for it.
  - Price on 2026-10-15: $0.10 per 1M input and $0.50 per 1M output tokens.
  - Strict schemas there do not accept `minLength` or `maxLength`, so claim length is enforced by the server validator.
  - **Cost per explanation is an estimate, not a maximum.** The input is capped at 14 067 characters (excerpts ≤ 12 000 + instructions + question), roughly 3.5–4.7k tokens at an assumed 3–4 characters per token, and the output at 2048 tokens. At the prices above that is about $0.0015 per explanation. This is a character-based estimate: the real token count is only known from the API's `usage`, which every response reports.
- **Secrets:**
  - The key (`CODETRAIL_OPENAI_API_KEY`) is read only by the backend, from the environment or the git-ignored `.env`.
  - It is sent only in the `Authorization` header to `https://api.openai.com`; no other host is accepted, except a plain-http loopback mock for local tests.
  - CodeTrail calls only `POST /v1/responses`, so a restricted key with just the Responses API write permission is sufficient.
  - It is never written to responses or logs. Provider error messages are not echoed.
  - Logs record route, status, duration and mode/reason only: no question, prompt, code or key.
- **UI** (`web/`, no framework, no external assets, strict CSP, dark theme):
  - **Start screen.** "Explore the GoTrip codebase", a large question field, "Search code" (local only) and "Explain with AI".
  - **Example chips.** Four example questions taken from the GoTrip tuning set, whose evidence exists in the code. A chip only fills the field; it never searches or calls the AI.
  - **Results.** Once results appear, the question panel becomes compact and the answer and sources use the full width. Claim cards show server-quoted code; source cards show syntax-highlighted code with line numbers. Snapshot, commits and chunk count are in a collapsible "Source details".
  - **AI status.** When AI is off, the header says so and "Explain with AI" is disabled; local search still works.
  - **States.** Loading, empty, insufficient-evidence, fallback and search-error states are shown; keyboard focus is visible; text contrast meets WCAG AA. Long paths and symbols wrap instead of overflowing, on desktop and at 375 px.
  - **Languages: English and 한국어** (EN / KO switch, default English, remembered in `localStorage`).
    - Every UI string, status, error, placeholder and example comes from one dictionary (`web/i18n.js`, identical keys).
    - The AI is asked to answer in the selected language; code, identifiers, paths and cited code are not translated.
    - The API accepts `language` only as `en` or `ko` (anything else is 400). The language is part of the answer-cache key.
    - Search itself is language-neutral. Korean questions can rank GoTrip's Korean locale files first (lexical match); English questions currently retrieve code better.
- **Not included:** web search, automatic code edits, pull requests and shell execution.
- **Local generation experiments (archived).** D0, D0b and D0c with Qwen2.5-Coder 1.5B/7B: the 1.5B model gave 0/13 and 0/10 strictly grounded answers, and the 7B run was stopped by the memory guard on the development Mac. The scripts are in `experiments/local-generation/` and the reports in `eval/reports/2026-10-15-d0*`.

## Docker

`compose.yaml` runs two containers. A generation model is not needed; answers come from the OpenAI API.

| Container | Contents | Network | Limits |
| --- | --- | --- | --- |
| `llama-embed` | llama.cpp b11606 built from the SHA-256-verified release archive (`docker/embed.Dockerfile`) | internal only | 2 GiB, 2 CPUs |
| `codetrail` | API + UI (`Dockerfile`) | internal + egress for OpenAI | 512 MiB, 1 CPU |

- **Mounts.** Both containers mount the embedding model read-only at the same path, `/models`, so the cross-container identity check holds: the model path, the runtime build and the model SHA-256 must all match.
- **Data.** The server reads `/data` read-only. That directory is produced by `scripts/export-serve-data.mjs`: one registry entry and one snapshot.
- **Index.** The index is built **on the serving platform** with `docker compose --profile index run --rm codetrail-index`.
  - Why: an index built on the Mac (Metal) fails the 0.9999 embedding fingerprint check against the Linux CPU runtime (measured cosine 0.999705). That check is intended to fail closed.
  - Batching: the index job sends one input per request with a 300 s per-request timeout (`CODETRAIL_EMBED_BATCH_SIZE`, `CODETRAIL_EMBED_DOC_TIMEOUT_MS`; defaults outside Docker stay 8 and 120 s; the query timeout is fixed). Measured in local Docker (2 CPUs, arm64): the two largest GoTrip chunks (3008 + 2984 tokens) took 121.5 s, so the old 120 s timeout with 8-input requests failed a first run.
  - Resumable: vectors are validated and cached in groups of 32 while indexing, so an interrupted build keeps its progress and a rerun computes only what is missing.
- **Secrets.** The key comes only from the runtime env file (`CODETRAIL_ENV_FILE`, default `.env`). Images contain no `.env`, data or weights.
- **Exposure.** The app port is published on `127.0.0.1` only.
- **Operations.** Deploy, update and rollback steps are in `DEPLOY.md`.

## Support boundaries

- **Languages:** only TypeScript/JavaScript code is chunked by AST. Markdown, JSON, YAML and GraphQL are chunked as text. No other languages are supported.
- **Sources:** only local Git repositories under `CODETRAIL_LOCAL_ROOTS` and `https://github.com/<owner>/<repo>` URLs. No other hosts, SSH, credentials in URLs, ZIP uploads or arbitrary paths. Private GitHub repositories are not supported: user and system git config, including credential helpers, are deliberately ignored, and CodeTrail never handles tokens.
- **Secret scanning:** it is pattern-based and does not guarantee that no secret gets through. The default is to fail closed: a suspected secret blocks the snapshot or excludes the file. An excluded `.env.example` has to be reviewed by hand.
- **Untrusted content:** repository content (comments, docs) is data, never instructions. The AI instructions say so, and every claim must cite shown lines. This reduces prompt-injection risk but does not eliminate it.
- **Out of scope:** automatic edits, pull requests and shell execution.
- **Known environment issue:** repositories under `~/Desktop` on the development Mac occasionally fail to read with SIGBUS or `pack-objects died`. The objects are intact and `git fsck` is clean.
  - CodeTrail passes `core.packedGitWindowSize=1m` to every git call.
  - Only known transient failures are retried: SIGBUS/SIGSEGV, `pack-objects died`, early EOF, dropped connections. Retries run up to 3 attempts with 200/400 ms backoff, and each clone attempt uses a fresh staging directory.
  - Permanent errors run exactly once, for example permission denied, missing repository or bad ref.
  - Errors carry the exit code or signal. Git's stderr is never printed.
- **Crash recovery:** a crashed run can leave a staging directory behind. It is removed at the next snapshot of the same project if its owning pid (part of the directory name) is no longer alive. This cleanup runs right after the project lock is taken and before sources are validated, so an invalid or missing source does not block it.

## Development

```bash
npm run typecheck
npm test        # vitest: builds once into dist-test/ (global setup), then unit + end-to-end tests on throwaway git fixture repos
npm run build
```

Tests build their own fixture repositories. These cover:

- canary secrets, which must never appear in data, stdout or stderr;
- symlinks and gitlinks;
- uncommitted changes;
- denylisted and binary files;
- determinism across data directories;
- the no-overwrite rule and project isolation;
- exact chunk text.

Canary values are assembled at runtime, so this repository contains no credential-shaped literals.

## License

MIT
