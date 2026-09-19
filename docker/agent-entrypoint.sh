#!/usr/bin/env bash
#
# Runner entrypoint. Deterministic bookkeeping, so the task's outcome never depends on the model
# remembering to report it.
#
# The container has no route to the queue by design, so the outcome is written to /out/result.json
# and the orchestrator relays it. That is what keeps the queue's bearer token out of every
# container while still letting the runner be authoritative about its own exit status.
set -uo pipefail

# Named-volume path only (Linux / RUNNER_MODULES_TMPFS=false). The volume may contain root-owned
# debris from an earlier partial npm ci; fix the tree, not just the mountpoint. Do not chown -R
# /home/agent — Docker Desktop often rejects that on bind mounts and aborts before run.log exists.
# macOS defaults to a tmpfs node_modules with uid=1001 and --user 1001:1001, so this block is skipped.
if [ "$(id -u)" = 0 ] && [ "${TMT_ENTRY_AS_AGENT:-}" != 1 ]; then
  mkdir -p /workspace/node_modules /home/agent
  chown -R agent:agent /workspace/node_modules
  export TMT_ENTRY_AS_AGENT=1
  exec gosu agent:agent env TMT_ENTRY_AS_AGENT=1 /usr/local/bin/agent-entrypoint.sh
fi

RESULT_FILE=/out/result.json
LOG_FILE=/out/run.log

CHAT_ID="${CHAT_ID:-}"

write_result() {
  local code="$1" reason="${2:-}"
  # jq keeps the reason and chat id correctly escaped; they are the only free-form values here.
  jq -n --argjson exit_code "${code}" \
        --arg reason "${reason}" \
        --arg chat_id "${CHAT_ID}" \
        --arg finished_at "$(date -u +%FT%TZ)" \
        '{exit_code: $exit_code, finished_at: $finished_at}
         + (if $reason == "" then {} else {reason: $reason} end)
         + (if $chat_id == "" then {} else {chat_id: $chat_id} end)' \
    > "${RESULT_FILE}" 2>/dev/null \
    || printf '{"exit_code":%s,"finished_at":"%s"}\n' "${code}" "$(date -u +%FT%TZ)" > "${RESULT_FILE}"
}

on_signal() {
  local sig="$1"
  echo "[entrypoint] received SIG${sig}, reporting termination" | tee -a "${LOG_FILE}"
  # --stop-timeout on the container is what gives this a chance to land before SIGKILL.
  write_result 143 "container terminated by SIG${sig}"
  exit 143
}
trap 'on_signal TERM' TERM
trap 'on_signal INT' INT

fail_setup() {
  echo "[entrypoint] setup failed: $1" | tee -a "${LOG_FILE}" >&2
  write_result 1 "setup failed: $1"
  exit 1
}

# Secrets arrive as a mounted 0600 file rather than environment variables, because docker inspect
# reports anything passed with -e or --env-file in Config.Env.
if [ -r /run/secrets/env ]; then
  set -a
  # shellcheck disable=SC1091
  . /run/secrets/env
  set +a
else
  fail_setup "/run/secrets/env is not readable"
fi

: "${GITHUB_TOKEN:?GITHUB_TOKEN missing from /run/secrets/env}"
: "${CURSOR_API_KEY:?CURSOR_API_KEY missing from /run/secrets/env}"

[ -r /task/prompt.md ] || fail_setup "/task/prompt.md is missing"

# The clone is a bind mount owned by the host user, so git refuses it as dubious ownership
# without this. Harmless when the uids already agree.
git config --global --add safe.directory /workspace || true
git config --global --add safe.directory '*' || true

# Credential helper reads the token from the environment, so it never lands in .git/config on disk
# and never appears in a remote URL.
git config --global credential.helper \
  '!f() { test "$1" = get && echo "username=x-access-token" && echo "password=${GITHUB_TOKEN}"; }; f'

git config --global user.name "${GIT_AUTHOR_NAME:-tmt agent}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-agent@tmt.local}"

# github-mcp-server reads its token from its own environment, which it inherits from cursor-agent.
# Exporting it here avoids depending on placeholder expansion inside mcp.json.
export GITHUB_PERSONAL_ACCESS_TOKEN="${GITHUB_TOKEN}"

# MCP config goes into the per-issue home volume, not into /workspace, so the target repository
# stays untouched. --approve-mcps below is what lets it load without an interactive prompt.
mkdir -p "${HOME}/.cursor" || fail_setup "cannot write ${HOME}/.cursor"
cat > "${HOME}/.cursor/mcp.json" <<'JSON'
{
  "mcpServers": {
    "github": {
      "command": "github-mcp-server",
      "args": ["stdio"]
    }
  }
}
JSON

cd /workspace || fail_setup "cannot enter /workspace"

if [ -n "${SETUP_CMD:-}" ]; then
  echo "[entrypoint] running setup: ${SETUP_CMD}" | tee -a "${LOG_FILE}"
  if ! bash -lc "${SETUP_CMD}" 2>&1 | tee -a "${LOG_FILE}"; then
    # A failed dependency install is worth reporting as a failure rather than letting the agent
    # flail against a half-installed tree.
    fail_setup "setup command failed: ${SETUP_CMD}"
  fi
fi

# cursor-agent lives only in here, so the chat id is minted here and reported back in result.json.
# The orchestrator stores it so a follow-up comment on this issue resumes the same conversation
# instead of starting cold. Failing to mint one is not fatal; it only costs continuity.
#
# Bounded, because create-chat blocks indefinitely on an invalid CURSOR_API_KEY rather than
# erroring out. Without this the container sits there until the orchestrator's TASK_TIMEOUT_MS
# fires, burning a concurrency slot on a task that can never succeed.
if [ -z "${CHAT_ID}" ]; then
  minted="$(timeout "${CHAT_MINT_TIMEOUT_SECONDS:-90}" \
    cursor-agent create-chat 2>>"${LOG_FILE}" | tr -d '[:space:]')" || minted=""
  if [ -n "${minted}" ]; then
    CHAT_ID="${minted}"
    echo "[entrypoint] created chat ${CHAT_ID}" | tee -a "${LOG_FILE}"
  else
    # Not fatal on its own: it only costs conversation continuity. If the key is the problem, the
    # agent run below fails immediately and reports that as the real error.
    echo "[entrypoint] could not create a chat id; continuing without resume support" \
      | tee -a "${LOG_FILE}"
  fi
else
  echo "[entrypoint] resuming chat ${CHAT_ID}" | tee -a "${LOG_FILE}"
fi

args=(--print --output-format text --force --trust --approve-mcps)
[ -n "${AGENT_MODEL:-}" ] && args+=(--model "${AGENT_MODEL}")
[ -n "${CHAT_ID}" ] && args+=(--resume "${CHAT_ID}")

echo "[entrypoint] starting cursor-agent ${args[*]}" | tee -a "${LOG_FILE}"

# AGENT_TIMEOUT_SECONDS is an optional inner bound. The orchestrator's TASK_TIMEOUT_MS is the real
# authority, so this stays unset by default; when it is set, exit 124 says the agent ran out of time
# rather than leaving a `docker stop` to look like a crash.
agent=(cursor-agent)
if [ -n "${AGENT_TIMEOUT_SECONDS:-}" ]; then
  agent=(timeout --signal=TERM --kill-after=30 "${AGENT_TIMEOUT_SECONDS}" cursor-agent)
fi

# PIPESTATUS is why this is bash and not sh: tee must not mask the agent's exit code.
"${agent[@]}" "${args[@]}" "$(cat /task/prompt.md)" 2>&1 | tee -a "${LOG_FILE}"
code=${PIPESTATUS[0]}

if [ "${code}" -eq 124 ] && [ -n "${AGENT_TIMEOUT_SECONDS:-}" ]; then
  echo "[entrypoint] cursor-agent timed out after ${AGENT_TIMEOUT_SECONDS}s" | tee -a "${LOG_FILE}"
fi
echo "[entrypoint] cursor-agent exited ${code}" | tee -a "${LOG_FILE}"
write_result "${code}"
exit "${code}"
