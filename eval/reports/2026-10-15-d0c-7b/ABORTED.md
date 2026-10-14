# D0c — stopped by the memory guard before any generation (2026-10-15)

The pre-registered protocol (`PROTOCOL.md`, commit `8d6c7b3`) was **not run**. **No 7B answer was generated or graded**, so there are no quality, TTFT or RAM results for the 7B model.

## What happened

| Step | Pressure level | System free | Swap used |
| --- | --- | --- | --- |
| Before download | 1 (normal) | 50% | ≈11.0 GB of 12.3 GB |
| Embedding server + 7B server loaded (both healthy, loopback) | **4 (critical)** | **7%** | ≈13.0 GB of 13.3 GB |
| Both servers stopped right away | 1 | 63% | ≈14.0 GB of 14.3 GB |

The protocol stops the run at pressure level ≥ 2, so the benchmark script was never started.

## Why

- Most of the Mac's memory was held by other running apps: TEK_Daemon ≈2.6 GB, several Chrome helpers ≈4.5 GB, a virtualization process ≈1.7 GB, Claude and Codex renderers ≈2.2 GB.
- On top of that, the embedding server (≈1.0 GB) and the 7B model (4.7 GB weights plus the KV cache) pushed the system to critical.
- Those apps were not closed or changed; that is the owner's decision.

## Status

- The model is downloaded and verified (SHA-256 `509287f7…`, outside the repo).
- The protocol, schema, validator and script are committed and unchanged.
- To run it, the same protocol must be repeated unchanged once enough memory is free (roughly ≥ 7 GB available at pressure level 1 before loading). Changing the protocol to fit memory, such as dropping the embedding server mid-run or shrinking the context, would be a new protocol and must be written down first.
