# CodeTrail — deploy and rollback (public GoTrip demo)

This guide does not touch any existing site configuration. The stack runs on its own Docker network and listens only on `127.0.0.1:${CODETRAIL_HTTP_PORT}`. Exposing it through the reverse proxy is a separate step and needs its own permission.

## What runs

| Service | Image | Notes |
| --- | --- | --- |
| `llama-embed` | `codetrail-embed:b11606`, built from `docker/embed.Dockerfile` | llama.cpp b11606 from the official release archive, verified by SHA-256 (amd64/arm64). It serves Qwen3-Embedding-0.6B Q8_0 from `/models`, mounted read-only. It sits on an internal network only and has no outbound access. Memory limit 2 GiB, 2 CPUs. |
| `codetrail` | `codetrail:<tag>`, built from `Dockerfile` | HTTP API + UI, pinned by `CODETRAIL_PUBLIC_PIN`. `/data` and `/models` are mounted read-only. It reaches the OpenAI API through the `egress` network. Memory limit 512 MiB, 1 CPU. |
| `codetrail-index` | same image as `codetrail` | Profile `index`, one-off. It builds the pinned snapshot's index with this stack's embedding server. |

There is no generation model on the server; answers come from the OpenAI API.

## Server prerequisites (measure first)

1. Record a resource baseline:
   ```bash
   nproc; free -h; uptime; df -h; docker stats --no-stream
   ```
   The stack's limits add up to about 2.5 GiB of memory and 3 CPUs. During the index build only `llama-embed` and `codetrail-index` run.
2. You need Docker Engine and the Compose plugin, and a free local port, for example `8090`. Check that no existing service uses it.

## First deploy

All paths are under a new directory, for example `/srv/codetrail`. Nothing else on the server is modified.

1. **Code.** Put the release commit in `/srv/codetrail/app`, either with a git clone/checkout of the reviewed commit or by copying an archive.
2. **Model** (outside the repo):
   ```bash
   CODETRAIL_MODELS_DIR=/srv/codetrail/models node scripts/fetch-models.mjs ubuntu-x64
   ```
   This verifies the runtime archive and the model against `models.lock.json`. Only `models/Qwen3-Embedding-0.6B-Q8_0.gguf` is needed.
3. **Data.** On the operator machine, run:
   ```bash
   node scripts/export-serve-data.mjs gotrip d75aaec921284e35893092a7 deploy-data
   ```
   This exports the GoTrip registry entry and snapshot only, without an index. Copy the result to `/srv/codetrail/data`.
4. **Runtime env file** `/srv/codetrail/runtime.env` (`chmod 600`, owned by the deploy user, never committed) holds:
   ```
   CODETRAIL_OPENAI_API_KEY=...        # restricted key, Responses API write only
   CODETRAIL_PUBLIC_PIN=gotrip:d75aaec921284e35893092a7
   ```
5. **Compose variables.** Set these in the shell or in a deploy script, not in the repo:
   ```bash
   export CODETRAIL_MODELS_HOST_DIR=/srv/codetrail/models
   export CODETRAIL_DATA_HOST_DIR=/srv/codetrail/data
   export CODETRAIL_ENV_FILE=/srv/codetrail/runtime.env
   export CODETRAIL_HTTP_PORT=8090
   export CODETRAIL_IMAGE_TAG=<commit-sha>
   export CODETRAIL_TRUST_PROXY=1     # only behind the reverse proxy
   ```
6. **Build and index.** The index must be built on the server: a Mac-built index fails the 0.9999 embedding fingerprint check against the Linux CPU runtime, and that is intended. The index job uses one input per request and a 300 s request timeout (override with `CODETRAIL_EMBED_BATCH_SIZE` / `CODETRAIL_EMBED_DOC_TIMEOUT_MS`). On the development Mac's Docker (2 CPUs), the two largest GoTrip chunks took 121.5 s together. Server speed is not measured; expect a long run on a small CPU. If the job is interrupted, run it again: computed vectors are cached in groups and are not recomputed.
   1. **Build the images:**
      ```bash
      cd /srv/codetrail/app
      docker compose build
      ```
   2. **Give the index job write access to the CodeTrail data directory only.** The job runs as the image's non-root `node` user and mounts `/data` read-write. A bind mount does not change host permissions, so a directory copied in as `root` (mode `0755`) makes the job fail with `EACCES` on `/data/locks`. Read the real UID/GID from the image (do not assume `1000`), then hand over only this directory. Do not use `chmod 777` and do not run the job as root.
      ```bash
      APP_UID=$(docker run --rm --entrypoint id "codetrail:${CODETRAIL_IMAGE_TAG}" -u)
      APP_GID=$(docker run --rm --entrypoint id "codetrail:${CODETRAIL_IMAGE_TAG}" -g)
      echo "codetrail runs as ${APP_UID}:${APP_GID}"
      sudo chown -R "${APP_UID}:${APP_GID}" "${CODETRAIL_DATA_HOST_DIR}"
      sudo chmod -R u=rwX,g=rX,o= "${CODETRAIL_DATA_HOST_DIR}"
      ```
      `CODETRAIL_DATA_HOST_DIR` must be a directory used only by CodeTrail (`/srv/codetrail/data`). Never point it at a shared or parent directory.
   3. **Check access as the index job itself** (same service, user and mounts; nothing is indexed). This must print `data writable` and `model readable`; stop if it does not.
      ```bash
      docker compose --profile index run --rm --no-deps --entrypoint node codetrail-index -e '
        const fs = require("fs");
        console.log("uid", process.getuid(), "gid", process.getgid());
        const f = "/data/.codetrail-write-test-" + process.pid;
        fs.writeFileSync(f, ""); fs.unlinkSync(f); console.log("data writable");
        fs.accessSync("/models/models/Qwen3-Embedding-0.6B-Q8_0.gguf", fs.constants.R_OK); console.log("model readable");'
      ```
      The model directory stays read-only (`:ro`) for every container; it only needs to be readable, for example root-owned with mode `0755` (directories) and `0644` (files).
   4. **Build the index:**
      ```bash
      docker compose --profile index run --rm codetrail-index
      ```
   After indexing, the server mounts `/data` read-only (`:ro`). It still needs read access, which the ownership above gives it.
7. **Start and check:**
   ```bash
   docker compose up -d
   docker compose ps                               # both healthy
   curl -s http://127.0.0.1:8090/api/projects      # only gotrip, pinned: true
   curl -s -X POST -H 'Content-Type: application/json' \
     -d '{"question":"Where does AuthGuard get the token from?"}' http://127.0.0.1:8090/api/search
   ```
   Smoke checks that make no paid call: `/api/search` must return GoTrip sources, and `project_id: "ky"` must return 403. An `/api/explain` call costs one OpenAI request; make it only when that is intended.
8. **Reverse proxy** (separate permission). Add a new server block or location only, proxying to `127.0.0.1:8090` with HTTPS. Do not edit other sites' blocks. Validate with `nginx -t` before reloading.

## Update

1. Check out the new reviewed commit and set `CODETRAIL_IMAGE_TAG=<new-sha>`.
2. Run `docker compose build`, then `docker compose up -d`. If the snapshot or the embedding recipe changed, re-export the data, repeat the ownership and access check (step 6.2–6.3), and run the index job first.
3. Repeat the checks from step 7.

## Rollback

- Images are tagged per commit, so the previous image stays on disk:
  ```bash
  export CODETRAIL_IMAGE_TAG=<previous-sha>
  docker compose up -d --no-build
  ```
- Data is read-only for the server, and a new snapshot gets a new directory next to the old one. To roll back data, point `CODETRAIL_PUBLIC_PIN` (in `runtime.env`) back to the previous snapshot and restart.
- To stop the stack completely:
  ```bash
  docker compose down
  ```
  This removes only this project's containers and networks. Volumes are host directories and are kept. If a proxy block was added, remove it and reload the proxy.

## Secrets and logs

- **The key** is only in `runtime.env`, which is read at container start. It is not in any image (`.dockerignore` excludes `.env*`, data and models), not in git and not in logs.
- **Logs** record route, status, duration and mode/reason only. Docker log rotation is 10 MB × 3.
- **Never** pass the key with `-e` on the command line, where it would end up in shell history.
