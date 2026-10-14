# CodeTrail

CodeTrail is a codebase RAG for TypeScript/JavaScript projects. The goal is to answer questions about a repository with evidence: `source@commit:path:Lx-Ly` citations that can be checked.

**Status: stages B and C1–C2.** Onboarding, exact-commit snapshots, safety filters, AST chunking, a local embedding provider, a per-snapshot index and hybrid (BM25 + vector + RRF) search are implemented. Not built yet: retrieval evaluation, answer generation, the web UI and deployment.

**Local models only.** Embeddings come from a local `llama-server` (llama.cpp) running Qwen3-Embedding-0.6B. No external AI API is used, and code is never sent to a hosted model.

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
   - **Snapshot id:** `snapshot_id = sha256(project_id, source_id@commit…, config hash)`. The config hash covers the filters, scanner and chunker versions and the project excludes.
   - **Chunk id:** each chunk id is a hash of project, source, commit, path and line range.
   - **No overwrites:** an existing snapshot is never overwritten. A new commit produces a new snapshot next to the old one.
   - **Exact text:** every chunk's `text` is exactly lines `start_line..end_line` of the committed file. A UTF-8 BOM and CRLF line endings are kept as they are.
   - **Coverage:** every non-blank line that is not only closing punctuation lands in some chunk. This includes comments after the last member of a large class.
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

## Support boundaries

- **Languages:** only TypeScript/JavaScript code is chunked by AST. Markdown, JSON, YAML and GraphQL are chunked as text. No other languages are supported.
- **Sources:** only local Git repositories under `CODETRAIL_LOCAL_ROOTS` and `https://github.com/<owner>/<repo>` URLs. No other hosts, SSH, credentials in URLs, ZIP uploads or arbitrary paths. Private GitHub repositories are not supported: user and system git config, including credential helpers, are deliberately ignored, and CodeTrail never handles tokens.
- **Secret scanning:** it is pattern-based and does not guarantee that no secret gets through. The default is to fail closed: a suspected secret blocks the snapshot or excludes the file. An excluded `.env.example` has to be reviewed by hand.
- **Untrusted content:** repository content (comments, docs) is data, never instructions. Later stages must treat it as untrusted model input (prompt injection).
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
