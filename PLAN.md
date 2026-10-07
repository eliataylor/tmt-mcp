# Agentic Workflow & Task Orchestration Plan

An autonomous local development pipeline that bridges GitHub Issues to local worker agents (**Herdr + Docker**) using an **MCP Server**, a lightweight local **SQLite Queue**, and **Neon Ephemeral Database Branching**.

---

## Architecture Overview


```

[ GitHub Issue / Comment ]
│
▼ (1. Webhook via Cloudflare Tunnel)
[ Express Webhook API (Docker) ]
│
▼ (2. Stores Binary JSON Task)
[ SQLite Queue (`agent_queue.db`) ]
│
▼ (3. Outbound Poll via localhost:3000)
[ macOS Host Orchestrator (`orchestrator.ts`) ]
│
├──► 4. Neon API: Provision DB Branch off Staging
├──► 5. Git: Create Worktree in Project Directory
└──► 6. Herdr: Launch Dockerized Worker Agent Pane

```

---

## 1. Database Schema (`db/schema.sql`)

Stores incoming GitHub webhooks locally using SQLite `JSONB` binary formatting and virtual generated columns for fast multi-project filtering.

```sql
CREATE TABLE IF NOT EXISTS agent_tasks (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    -- Virtual column extracted automatically from the payload
    repo_full_name TEXT GENERATED ALWAYS AS (json_extract(json(payload), '$.repository.full_name')) VIRTUAL,
    project_slug TEXT NOT NULL,       -- Internal project slug (e.g., 'main-app', 'side-project')
    github_issue_id INTEGER NOT NULL,
    issue_title TEXT NOT NULL,
    action TEXT NOT NULL,             -- 'agent:assigned', 'comment_created'
    payload BLOB NOT NULL,             -- Binary JSON payload
    status TEXT DEFAULT 'pending',     -- 'pending', 'processing', 'completed', 'failed'
    attempts INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_project ON agent_tasks(project_slug, status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_repo ON agent_tasks(repo_full_name);

```

---

## 2. Server Implementation (`server.mjs`)

A lightweight Express server that receives GitHub webhooks, verifies HMAC signatures, maps repositories to project slugs, and exposes an authenticated polling endpoint.

```javascript
import express from 'express';
import crypto from 'crypto';
import Database from 'better-sqlite3';

const app = express();
app.use(express.json());

const db = new Database('./data/agent_queue.db');
db.pragma('journal_mode = WAL');

// Initialize Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      repo_full_name TEXT GENERATED ALWAYS AS (json_extract(json(payload), '$.repository.full_name')) VIRTUAL,
      project_slug TEXT NOT NULL,
      github_issue_id INTEGER NOT NULL,
      issue_title TEXT NOT NULL,
      action TEXT NOT NULL,
      payload BLOB NOT NULL,
      status TEXT DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_agent_tasks_project ON agent_tasks(project_slug, status);
  CREATE INDEX IF NOT EXISTS idx_agent_tasks_repo ON agent_tasks(repo_full_name);
`);

// Repository to Project Slug Map
const REPO_PROJECT_MAP = {
  'my-org/primary-app': 'main-app',
  'personal/side-project': 'side-project'
};

const WEBHOOK_SECRET_MAIN_APP = process.env.WEBHOOK_SECRET_MAIN_APP;
const AGENT_POLL_SECRET = process.env.AGENT_POLL_SECRET || 'local_dev_poll_secret_456';

function verifyGitHubSignature(req) {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return false;
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET_MAIN_APP);
  const digest = `sha256=${hmac.update(JSON.stringify(req.body)).digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

// Webhook Receiver
app.post('/api/agent/webhook', (req, res) => {
  if (!verifyGitHubSignature(req)) {
    return res.status(401).json({ error: 'Invalid HMAC signature' });
  }

  const event = req.headers['x-github-event'];
  const payload = req.body;
  const repoFullName = payload.repository?.full_name;
  const projectSlug = REPO_PROJECT_MAP[repoFullName];
  if (!projectSlug) {
    return res.status(202).json({ success: true, ignored: true, reason: 'unregistered repository' });
  }

  let shouldQueue = false;
  let actionType = 'unknown';

  if (event === 'issues' && payload.action === 'labeled' && payload.label?.name === 'agent:assigned') {
    shouldQueue = true;
    actionType = 'agent:assigned';
  } else if (event === 'issue_comment' && payload.action === 'created' && payload.comment?.body.includes('@dev-agent')) {
    shouldQueue = true;
    actionType = 'comment_created';
  }

  if (shouldQueue) {
    const stmt = db.prepare(`
      INSERT INTO agent_tasks (project_slug, github_issue_id, issue_title, action, payload)
      VALUES (?, ?, ?, ?, jsonb(?))
    `);
    stmt.run(projectSlug, payload.issue.number, payload.issue.title, actionType, JSON.stringify(payload));
    console.log(`[Queue] Added task for ${projectSlug} (${repoFullName}) - Issue #${payload.issue.number}`);
  }

  return res.json({ success: true });
});

// Polling Endpoint
app.post('/api/agent/poll', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${AGENT_POLL_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { project_slug } = req.body || {};
  let selectQuery = `
    SELECT id, repo_full_name, project_slug, github_issue_id, issue_title, action, json(payload) as payload 
    FROM agent_tasks 
    WHERE status = 'pending' 
  `;
  const queryParams = [];

  if (project_slug) {
    selectQuery += ` AND project_slug = ? `;
    queryParams.push(project_slug);
  }
  selectQuery += ` ORDER BY created_at ASC LIMIT 1`;

  const selectStmt = db.prepare(selectQuery);
  const updateStmt = db.prepare(`
    UPDATE agent_tasks 
    SET status = 'processing', updated_at = CURRENT_TIMESTAMP 
    WHERE id = ?
  `);

  let task = null;
  const transaction = db.transaction(() => {
    task = selectStmt.get(...queryParams);
    if (task) {
      updateStmt.run(task.id);
      task.payload = JSON.parse(task.payload);
    }
  });

  transaction();
  return res.json({ task: task || null });
});

app.listen(3000, () => console.log('[Server] Agent Webhook API running on port 3000'));

```

---

## 3. Container Configurations

#### `Dockerfile.server`

```dockerfile
FROM node:20-alpine

WORKDIR /app
RUN apk add --no-cache make g++ python3

COPY package.json ./
RUN npm install express better-sqlite3

COPY server.mjs ./
RUN mkdir -p data

EXPOSE 3000
CMD ["node", "server.mjs"]

```

#### `docker/agent-runner.Dockerfile`

```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    git curl python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm @modelcontextprotocol/server-github

WORKDIR /workspace
USER node
CMD ["bash"]

```

#### `docker-compose.dev.yml`

```yaml
version: '3.8'

networks:
  agent-net:
    driver: bridge

services:
  webhook-server:
    build:
      context: .
      dockerfile: Dockerfile.server
    container_name: agent-webhook-server
    environment:
      WEBHOOK_SECRET_MAIN_APP: "local_dev_webhook_secret_123"
      AGENT_POLL_SECRET: "local_dev_poll_secret_456"
    ports:
      - "3000:3000"
    volumes:
      - ./sqlite_data:/app/data
    networks:
      - agent-net

  cloudflare-tunnel:
    image: cloudflare/cloudflared:latest
    container_name: agent-cloudflare-tunnel
    command: tunnel --url http://webhook-server:3000
    depends_on:
      - webhook-server
    networks:
      - agent-net

```

---

## 4. MCP Configuration (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${env:GITHUB_PERSONAL_ACCESS_TOKEN}"
      }
    },
    "sqlite-queue": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-sqlite",
        "--db-path",
        "./sqlite_data/agent_queue.db"
      ]
    }
  }
}

```

---

## 5. Host Orchestrator Script (`scripts/orchestrator.ts`)

Runs locally on macOS, polls the containerized SQLite queue, provisions an ephemeral Neon DB branch, writes `.env.local` into a Git Worktree, and spawns the Herdr worker pane inside Docker.

```typescript
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const VERCEL_POLL_URL = 'http://localhost:3000/api/agent/poll';
const AGENT_POLL_SECRET = process.env.AGENT_POLL_SECRET || 'local_dev_poll_secret_456';
const NEON_API_KEY = process.env.NEON_API_KEY!;
const NEON_PROJECT_ID = process.env.NEON_PROJECT_ID!;
const DEV_BLOB_TOKEN = process.env.DEV_BLOB_TOKEN!;

const PROJECT_PATHS: Record<string, string> = {
  'main-app': '/Users/username/code/main-app',
  'side-project': '/Users/username/code/side-project'
};

async function pollQueue() {
  try {
    const res = await fetch(VERCEL_POLL_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AGENT_POLL_SECRET}`,
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) return;

    const data = await res.json();
    if (data.task) {
      console.log(`[Orchestrator] Task received for ${data.task.project_slug} - Issue #${data.task.github_issue_id}`);
      await handleTask(data.task);
    }
  } catch (err) {
    console.error('[Orchestrator] Polling error:', err);
  }
}

async function handleTask(task: any) {
  const { project_slug, github_issue_id } = task;
  const baseRepoPath = PROJECT_PATHS[project_slug] || process.cwd();
  const worktreePath = path.resolve(baseRepoPath, `../worktrees/${project_slug}-issue-${github_issue_id}`);
  const branchName = `feat/issue-${github_issue_id}`;

  // 1. Create Git Worktree
  if (!fs.existsSync(worktreePath)) {
    console.log(`[Orchestrator] Creating worktree at ${worktreePath}`);
    execSync(`git -C ${baseRepoPath} worktree add -b ${branchName} ${worktreePath} main`);
  }

  // 2. Provision Ephemeral Neon DB Branch off 'staging'
  console.log(`[Orchestrator] Provisioning Neon Branch: agent-issue-${github_issue_id}`);
  const neonRes = await fetch(`[https://console.neon.tech/api/v2/projects/$](https://console.neon.tech/api/v2/projects/$){NEON_PROJECT_ID}/branches`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NEON_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      branch: { name: `agent-issue-${github_issue_id}`, parent_id: 'staging' }
    })
  });
  
  const neonData = await neonRes.json();
  const dbUrl = neonData.connection_uris?.[0]?.connection_uri;

  // 3. Populate Worktree .env.local
  const envConfig = `
DATABASE_URL="${dbUrl}"
BLOB_READ_WRITE_TOKEN="${DEV_BLOB_TOKEN}"
GITHUB_ISSUE_ID="${github_issue_id}"
`;
  fs.writeFileSync(path.join(worktreePath, '.env.local'), envConfig);

  // 4. Launch Docker container in a project-titled Herdr Pane
  const dockerCmd = `docker run --rm -it -v ${worktreePath}:/workspace -w /workspace local-agent-runner bash`;
  execSync(`herdr run --title "[${project_slug}] Issue #${github_issue_id}" -- ${dockerCmd}`);
}

setInterval(pollQueue, 10000);
console.log('[Orchestrator] Local daemon active and polling...');

```

---

## 6. Cleanup Action (`.github/workflows/cleanup-neon-branch.yml`)

Deletes the ephemeral Neon database branch when a PR is merged or closed.

```yaml
name: Cleanup Ephemeral Neon Branch

on:
  pull_request:
    types: [closed]

jobs:
  cleanup-db:
    runs-on: ubuntu-latest
    steps:
      - name: Extract Issue Number
        id: extract-issue
        run: |
          BRANCH_NAME="${{ github.head_ref }}"
          ISSUE_ID=$(echo "$BRANCH_NAME" | grep -oP 'issue-\K\d+' || true)
          echo "issue_id=$ISSUE_ID" >> $GITHUB_OUTPUT

      - name: Delete Neon Branch
        if: steps.extract-issue.outputs.issue_id != ''
        env:
          NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
          NEON_PROJECT_ID: ${{ secrets.NEON_PROJECT_ID }}
        run: |
          ISSUE_ID="${{ steps.extract-issue.outputs.issue_id }}"
          BRANCH_NAME="agent-issue-${ISSUE_ID}"
          
          BRANCH_ID=$(curl -s -X GET "[https://console.neon.tech/api/v2/projects/$](https://console.neon.tech/api/v2/projects/$){NEON_PROJECT_ID}/branches" \
            -H "Authorization: Bearer ${NEON_API_KEY}" \
            -H "Accept: application/json" | \
            jq -r ".branches[] | select(.name==\"${BRANCH_NAME}\") | .id")
            
          if [ -n "$BRANCH_ID" ] && [ "$BRANCH_ID" != "null" ]; then
            curl -s -X DELETE "[https://console.neon.tech/api/v2/projects/$](https://console.neon.tech/api/v2/projects/$){NEON_PROJECT_ID}/branches/${BRANCH_ID}" \
              -H "Authorization: Bearer ${NEON_API_KEY}"
            echo "Deleted Neon branch: $BRANCH_NAME"
          fi
```