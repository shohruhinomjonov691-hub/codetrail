# CodeTrail

CodeTrail is a codebase RAG for TypeScript/JavaScript projects. The goal is to answer questions about a repository with evidence: `source@commit:path:Lx-Ly` citations that can be checked.

**Status: stage B.** Onboarding, exact-commit snapshots, safety filters and AST chunking are implemented. Not built yet: retrieval, embeddings, answer generation, the web UI and deployment. This stage makes no network calls to any LLM or embedding provider.

## What stage B does

1. **Projects and sources.** A project groups one or more sources. Example: a frontend and a backend repository. Each source is either a local Git repository or a public GitHub repository URL.
2. **Exact-commit snapshots.** Each source is pinned to a full commit SHA and read from a bare mirror under `data/mirrors/`. The source repository's working tree, index and refs are never read or modified. Uncommitted and untracked files are never indexed.
3. **Safe onboarding.**
   - **Allowlist:** `.ts .tsx .mts .cts .js .jsx .mjs .cjs .json .md .mdx .graphql .gql .yml .yaml`.
   - **Denylist:** `.env*`, keys and certificates, `.npmrc`, credential files, lockfiles, `node_modules/`, build output, `uploads/`, `vendor/`, `.agents/`, `.claude/`, IDE folders, `*.min.js`, `*.d.ts`, logs and dumps.
   - **Content checks:** files over 512 KB, binary content, invalid UTF-8, lines over 2000 chars and minified files are excluded.
   - **Never indexed:** symlinks and submodules.
   - **Path validation:** paths with `..`, absolute paths, backslashes or control characters are rejected.
   - **Reasons recorded:** every excluded file is listed in the manifest with its reason.
4. **Secret scan before anything is persisted.**
   - **High-confidence detectors** block the whole snapshot. They cover private keys, AWS, GitHub, OpenAI, Anthropic, Google, Slack, Stripe and npm tokens, URLs with embedded credentials, and JWTs. A blocked snapshot writes only a report.
   - **Medium-confidence detectors** exclude the file. They look for high-entropy `password`/`secret`/`token`/`apiKey` assignments.
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
   - **Exact text:** every chunk's `text` is exactly lines `start_line..end_line` of the committed file.

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
| `CODETRAIL_DATA_DIR` | Where the registry, mirrors and snapshots are written. Default `./data` (git-ignored). |
| `CODETRAIL_LOCAL_ROOTS` | Colon-separated absolute directories. A local source must resolve inside one of them after symlinks are followed. If unset, local sources are disabled. |

### Artifacts

```text
data/
  registry.json                         projects and sources
  mirrors/<project>/<source>.git        bare mirrors (read-only copies)
  snapshots/<project>/<snapshot_id>/
    manifest.json                       every tree entry: blob, sha256, status, exclusion reason
    chunks.jsonl                        one chunk per line
    report.json                         counts, secret findings (no values), created_at
  snapshots/<project>/blocked/<id>.json report for a blocked snapshot (no chunks)
```

`data/`, `*.jsonl` and `.env` are git-ignored.

## Support boundaries

- **Languages:** only TypeScript/JavaScript code is chunked by AST. Markdown, JSON, YAML and GraphQL are chunked as text. No other languages are supported.
- **Sources:** only local Git repositories under `CODETRAIL_LOCAL_ROOTS` and `https://github.com/<owner>/<repo>` URLs. No other hosts, SSH, credentials in URLs, ZIP uploads or arbitrary paths. Private GitHub repositories work only if the machine's own git credentials allow cloning; CodeTrail never handles tokens.
- **Secret scanning:** it is pattern-based and does not guarantee that no secret gets through. The default is to fail closed: a suspected secret blocks the snapshot or excludes the file. An excluded `.env.example` has to be reviewed by hand.
- **Untrusted content:** repository content (comments, docs) is data, never instructions. Later stages must treat it as untrusted model input (prompt injection).
- **Out of scope:** automatic edits, pull requests and shell execution.
- **Known environment issue:** repositories under `~/Desktop` on the development Mac occasionally fail to read with SIGBUS or `pack-objects died`. The objects are intact and `git fsck` is clean. CodeTrail passes `core.packedGitWindowSize=1m` to every git call and retries read-only git operations up to 3 times.

## Development

```bash
npm run typecheck
npm test        # vitest: unit + end-to-end tests on throwaway git fixture repos
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
