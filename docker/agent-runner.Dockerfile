# Image the host orchestrator runs per issue, with the git worktree bind-mounted at
# /workspace. Built separately from the queue:
#   docker build -f docker/agent-runner.Dockerfile -t local-agent-runner .
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates ripgrep jq python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm @modelcontextprotocol/server-github

WORKDIR /workspace
USER node
CMD ["bash"]
