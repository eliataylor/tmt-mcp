# Inspecting a cursor-agent run

`worker.log` and the transcripts are on the per-issue home volume, `tmt-agent-home-<slug>-<issue>`. In Docker Desktop, expand `.cursor`, then `projects`, then `workspace`.

```text
.cursor/projects/workspace/worker.log
.cursor/projects/workspace/agent-transcripts/<chat-id>/<chat-id>.jsonl
```

The same chat ids also appear as directories under `.cursor/chats/`. The commands below read the `agent-transcripts` copies.

```bash
SLUG=projectslug
ISSUE=131
docker run --rm -it --user 1001:1001 --read-only --entrypoint bash \
  -v "tmt-agent-home-${SLUG}-${ISSUE}:/home/agent:ro" \
  -w /home/agent/.cursor/projects/workspace \
  tmt-agent-runner
```

That shell starts in the directory that holds `worker.log` and `agent-transcripts/`. Each transcript is one JSON object per line. `role` is `user`, `assistant`, or `turn_ended`. Assistant text and tool calls are in `.message.content[]`, with `type` of `text` or `tool_use`.

## worker.log

```bash
less worker.log
rg -n -i 'error|fail|tool|command' worker.log
```

## Transcripts

```bash
ls -lt agent-transcripts
```

Assistant reasoning, in order:

```bash
jq -r '
  select(.role == "assistant")
  | .message.content[]?
  | select(.type == "text")
  | .text
' agent-transcripts/*/*.jsonl
```

One chat:

```bash
CHAT=34558516-384f-4ca1-9e2b-b63adc49d746
jq -r '
  select(.role == "assistant")
  | [.message.content[]? | select(.type == "text") | .text]
  | join("\n")
' "agent-transcripts/$CHAT/$CHAT.jsonl"
```

Shell commands the agent ran:

```bash
jq -r '
  .message.content[]?
  | select(.type == "tool_use" and .name == "Shell")
  | .input.command
' agent-transcripts/*/*.jsonl
```

Tool-name counts:

```bash
jq -r '
  .message.content[]?
  | select(.type == "tool_use")
  | .name
' agent-transcripts/*/*.jsonl | sort | uniq -c | sort -nr
```

Fetched URLs and search queries:

```bash
jq -r '
  .message.content[]?
  | select(.type == "tool_use")
  | if .name == "WebFetch" then "FETCH\t" + .input.url
    elif .name == "WebSearch" then "SEARCH\t" + .input.query
    else empty end
' agent-transcripts/*/*.jsonl
```

