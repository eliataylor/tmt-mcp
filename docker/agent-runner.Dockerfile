# Image for a single agent task, built locally and never pushed:
#   docker build -f docker/agent-runner.Dockerfile -t tmt-agent-runner .
#
# The container receives a per-task clone at /workspace, its prompt at /task, a writable /out for
# its result, and credentials through a mounted file (Cursor, a proxy grant, optional PostHog).
# The GitHub token is not in this container. The same image runs the credential proxy sidecar
# (`node /usr/local/lib/tmt/cred-proxy.mjs`), which is the only process that mounts the token.
# It has no route to the queue and
# no Docker or Herdr socket. See orchestrator/runner.mjs for the mount allowlist.
FROM node:22-bookworm-slim

# @modelcontextprotocol/server-github was deprecated in April 2025. The official successor is a Go
# binary from github/github-mcp-server, verified below against the release's own checksums file.
ARG GITHUB_MCP_VERSION=1.12.2
# cursor-agent resolves its own download, so the pin is a post-install version assertion: an
# upstream bump fails the build here instead of silently changing the agent under you.
ARG CURSOR_AGENT_VERSION=2026.10.01
# Deliberately no default: BuildKit fills this in from the target platform, and a default here
# would shadow it and silently install an x86_64 binary into an arm64 image.
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive

# ripgrep because the agent leans on it for search; jq because the entrypoint writes result.json.
# iptables is not for the agent: the orchestrator runs this image once, privileged, on the Docker
# VM network namespace, to install the runner bridge's egress policy. openssl mints the proxy CA.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates ripgrep jq procps gosu iptables openssl \
    && mkdir -p /etc/ssl/tmt /usr/local/lib/tmt \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "${arch}" in \
      amd64) MCP_ARCH="x86_64" ;; \
      arm64) MCP_ARCH="arm64" ;; \
      *) echo "unsupported architecture: ${arch}" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    base="https://github.com/github/github-mcp-server/releases/download/v${GITHUB_MCP_VERSION}"; \
    curl -fsSLO "${base}/github-mcp-server_Linux_${MCP_ARCH}.tar.gz"; \
    curl -fsSLO "${base}/github-mcp-server_${GITHUB_MCP_VERSION}_checksums.txt"; \
    grep " github-mcp-server_Linux_${MCP_ARCH}.tar.gz\$" \
      "github-mcp-server_${GITHUB_MCP_VERSION}_checksums.txt" > expected.sha256; \
    sha256sum -c expected.sha256; \
    tar -xzf "github-mcp-server_Linux_${MCP_ARCH}.tar.gz" github-mcp-server; \
    install -m 0755 github-mcp-server /usr/local/bin/github-mcp-server; \
    rm -rf /tmp/*

COPY docker/agent-entrypoint.sh /usr/local/bin/agent-entrypoint.sh
COPY orchestrator/cred-proxy.mjs /usr/local/lib/tmt/cred-proxy.mjs
RUN chmod 0755 /usr/local/bin/agent-entrypoint.sh

# A fixed uid so the per-issue home volume, which this image seeds, stays writable at runtime.
RUN groupadd --gid 1001 agent \
    && useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash agent

USER agent
# The npm cache lives under HOME, which is a writable volume, so downloaded tarballs survive between
# tasks even though node_modules itself is rebuilt every run. Creating it here as uid 1001 is what
# makes the mounted cache volume agent-owned: Docker seeds a fresh named volume from the image path,
# ownership included, so nothing has to chown it at runtime.
ENV HOME=/home/agent \
    PATH=/home/agent/.local/bin:$PATH \
    npm_config_cache=/home/agent/.npm
RUN mkdir -p /home/agent/.npm

RUN set -eux; \
    curl -fsS https://cursor.com/install | bash; \
    installed="$(cursor-agent --version 2>/dev/null | tr -d '[:space:]')"; \
    echo "installed cursor-agent: ${installed}"; \
    case "${installed}" in \
      *"${CURSOR_AGENT_VERSION}"*) : ;; \
      *) echo "cursor-agent version drift: expected ${CURSOR_AGENT_VERSION}, got ${installed}." >&2; \
         echo "Review the change, then bump CURSOR_AGENT_VERSION." >&2; exit 1 ;; \
    esac

WORKDIR /workspace
# Entrypoint starts as root to chown the node_modules and home volumes, then drops to agent.
USER root
ENTRYPOINT ["/usr/local/bin/agent-entrypoint.sh"]
