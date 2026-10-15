# syntax=docker/dockerfile:1
# Local embedding server: the pinned llama.cpp release (models.lock.json → runtime) from the official
# GitHub release archive, verified by SHA-256. The model is NOT in the image; it is mounted read-only
# at /models (the same path inside the codetrail container, so model_path identity matches).
FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55 AS fetch
ARG TARGETARCH
ARG LLAMA_RELEASE=b11606
ARG LLAMA_SHA256_AMD64=d7619f6f3d8d1f6c63641c0904abff560e9dfa8ec0bd5a57e36f424ac96fac55
ARG LLAMA_SHA256_ARM64=328e338bcb726bc47fe94adbce89e7b1a38867ba00b04ee3fb59e1f58f549845
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
	case "$TARGETARCH" in \
		amd64) asset=ubuntu-x64; sha="$LLAMA_SHA256_AMD64" ;; \
		arm64) asset=ubuntu-arm64; sha="$LLAMA_SHA256_ARM64" ;; \
		*) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
	esac; \
	curl -fsSL --proto '=https' -o /tmp/llama.tar.gz "https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}/llama-${LLAMA_RELEASE}-bin-${asset}.tar.gz"; \
	echo "${sha}  /tmp/llama.tar.gz" | sha256sum -c -; \
	mkdir -p /opt/llama; \
	tar -xzf /tmp/llama.tar.gz -C /opt/llama --strip-components=1; \
	test -x /opt/llama/llama-server

FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 curl && rm -rf /var/lib/apt/lists/* \
	&& useradd --system --uid 10001 --no-create-home llama
COPY --from=fetch /opt/llama /opt/llama
ENV LD_LIBRARY_PATH=/opt/llama
USER llama
EXPOSE 8081
ENTRYPOINT ["/opt/llama/llama-server"]
