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

# Tests set TMT_FS_PREFIX to a temp directory. Unset in the container, so these stay absolute.
P="${TMT_FS_PREFIX:-}"
RESULT_FILE="${P}/out/result.json"
LOG_FILE="${P}/out/run.log"
SECRETS_FILE="${P}/run/secrets/env"
PROMPT_FILE="${P}/task/prompt.md"
WORKSPACE="${P}/workspace"
CA_FILE="${P}/etc/ssl/tmt/ca.crt"

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
if [ -r "${SECRETS_FILE}" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${SECRETS_FILE}"
  set +a
else
  fail_setup "${SECRETS_FILE} is not readable"
fi

# The GitHub token stays in the credential proxy. A stale secrets file must not be able to put it
# back into this process, git, or the MCP server.
unset GITHUB_TOKEN

: "${CURSOR_API_KEY:?CURSOR_API_KEY missing from secrets env}"
: "${https_proxy:?https_proxy missing from secrets env}"
[ -r "${CA_FILE}" ] || fail_setup "${CA_FILE} is not readable"
[ -r "${PROMPT_FILE}" ] || fail_setup "${PROMPT_FILE} is missing"
[ -n "${GITHUB_TOOLSETS:-}" ] || fail_setup "GITHUB_TOOLSETS is missing"

# The clone is a bind mount owned by the host user, so git refuses it as dubious ownership
# without this. Harmless when the uids already agree.
git config --global --add safe.directory "${WORKSPACE}" || true
git config --global --add safe.directory '*' || true

# No credential helper. Git talks to GitHub through the proxy, which injects the real token.
# http.sslCAInfo replaces git's default bundle; git only speaks to GitHub, via that proxy.
git config --global --unset-all credential.helper || true
git config --global http.proxy "${https_proxy}"
git config --global https.proxy "${https_proxy}"
git config --global http.sslCAInfo "${CA_FILE}"
git config --global http.version HTTP/1.1

git config --global user.name "${GIT_AUTHOR_NAME:-tmt agent}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-agent@tmt.local}"

# NODE_EXTRA_CA_CERTS appends. SSL_CERT_FILE replaces the trust store, so it is set only on the
# GitHub MCP server (below), which talks to api.github.com through the proxy and nothing else.
# The dummy token is what github-mcp-server requires in order to start. The proxy discards it.
export NODE_EXTRA_CA_CERTS="${CA_FILE}"
export GITHUB_PERSONAL_ACCESS_TOKEN="tmt-dummy-github-token"

# MCP config goes into the per-issue home volume, not into /workspace, so the target repository
# stays untouched. --approve-mcps below is what lets it load without an interactive prompt.
write_cursor_mcp_json() {
  local mcp_path="${HOME}/.cursor/mcp.json"
  local github_env base
  # Toolsets and lockdown come from the orchestrator. The dummy token and the proxy CA live in
  # this env so the Go client does not inherit a real token and does not trust the public
  # GitHub certificate (SSL_CERT_FILE replaces its trust store).
  github_env="$(jq -n \
    --arg toolsets "${GITHUB_TOOLSETS}" \
    --arg readonly "${GITHUB_READ_ONLY:-}" \
    --arg lockdown "${GITHUB_LOCKDOWN_MODE:-1}" \
    --arg token "tmt-dummy-github-token" \
    --arg ca "${CA_FILE}" \
    '{GITHUB_TOOLSETS: $toolsets, GITHUB_LOCKDOWN_MODE: $lockdown,
      GITHUB_PERSONAL_ACCESS_TOKEN: $token, SSL_CERT_FILE: $ca}
     + (if $readonly == "" then {} else {GITHUB_READ_ONLY: $readonly} end)')"
  base="$(jq -n --argjson env "${github_env}" '{
    mcpServers: {
      github: { command: "github-mcp-server", args: ["stdio"], env: $env }
    }
  }')"

  if [ -z "${POSTHOG_MCP_API_KEY:-}" ]; then
    echo "${base}" > "${mcp_path}"
    chmod 600 "${mcp_path}" || true
    return
  fi

  local read_only="${POSTHOG_MCP_READ_ONLY:-true}"
  local url="https://mcp.posthog.com/mcp"
  local query=""
  case "${read_only}" in true|1|yes|TRUE|True) query="readonly=true" ;; esac
  if [ -n "${POSTHOG_PROJECT_ID:-}" ]; then
    if [ -n "${query}" ]; then query="${query}&"; fi
    query="${query}project_id=${POSTHOG_PROJECT_ID}"
  fi
  if [ -n "${query}" ]; then url="${url}?${query}"; fi

  local headers
  headers="$(jq -n \
    --arg auth "Bearer ${POSTHOG_MCP_API_KEY}" \
    --arg org "${POSTHOG_ORGANIZATION_ID:-}" \
    --arg proj "${POSTHOG_PROJECT_ID:-}" \
    --arg ro "${read_only}" \
    '{
      Authorization: $auth
    }
    | if $org != "" then . + {"x-posthog-organization-id": $org} else . end
    | if $proj != "" then . + {"x-posthog-project-id": $proj} else . end
    | if ($ro == "true" or $ro == "1" or $ro == "yes" or $ro == "TRUE" or $ro == "True")
      then . + {"x-posthog-read-only": "true"} else . end')"

  echo "${base}" | jq --arg url "${url}" --argjson headers "${headers}" \
    '.mcpServers.posthog = { url: $url, headers: $headers }' > "${mcp_path}"
  chmod 600 "${mcp_path}" || true
}

mkdir -p "${HOME}/.cursor" || fail_setup "cannot write ${HOME}/.cursor"
write_cursor_mcp_json

# Tests stop once gitconfig and mcp.json exist. The container never sets this.
if [ "${TMT_ENTRYPOINT_STOP:-}" = "config" ]; then
  exit 0
fi

cd "${WORKSPACE}" || fail_setup "cannot enter ${WORKSPACE}"

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
"${agent[@]}" "${args[@]}" "$(cat "${PROMPT_FILE}")" 2>&1 | tee -a "${LOG_FILE}"
code=${PIPESTATUS[0]}

if [ "${code}" -eq 124 ] && [ -n "${AGENT_TIMEOUT_SECONDS:-}" ]; then
  echo "[entrypoint] cursor-agent timed out after ${AGENT_TIMEOUT_SECONDS}s" | tee -a "${LOG_FILE}"
fi
echo "[entrypoint] cursor-agent exited ${code}" | tee -a "${LOG_FILE}"
write_result "${code}"
exit "${code}"
