<div align="center">

# 🧠 deepseek-agent-acp

**Native Agent Client Protocol (ACP) Adapter for DeepSeek Reasoning and Chat Models**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg?style=flat-square)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Protocol: ACP](https://img.shields.io/badge/Protocol-ACP%20(JSON--RPC%202.0)-purple?style=flat-square)](https://agentclientprotocol.org)
[![MCP Compatible](https://img.shields.io/badge/MCP-1.32.2-blueviolet.svg?style=flat-square)](https://modelcontextprotocol.io)

<p align="center">
  Bridge DeepSeek's native reasoning engine (DeepSeek-R1 / V3) with headless agent orchestration harnesses over the standard Agent Client Protocol (ACP), featuring full Model Context Protocol (MCP) tool execution.
</p>

</div>

---

## 🌟 Overview

**`deepseek-agent-acp`** is a high-performance [Agent Client Protocol (ACP)](https://agentclientprotocol.org) adapter designed specifically for **DeepSeek** models (`deepseek-reasoner`, `deepseek-chat`).

It bridges headless orchestrators, team chat relays, and multi-agent harnesses with DeepSeek's native completions API over standard line-delimited `stdio` JSON-RPC. It features native 3-phase streaming (CoT reasoning tokens, content deltas, and tool calls), strict stdio isolation, transactional rollback on cancellation, and full tool execution delegation to Model Context Protocol (MCP) servers.

---

## 🏗 System Architecture

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              AGENT ORCHESTRATOR / HARNESS                               │
│                   (e.g., Solace Buzz `buzz-acp`, ACP clients, Hubs)                    │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │ Standard Input / Output (stdio)
                                            │ Protocol: ACP (JSON-RPC 2.0)
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                  deepseek-agent-acp                                    │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │ 1. ACP Protocol Router (`src/index.ts`)                                          │  │
│  │    • JSON-RPC: initialize, session/new, session/prompt, session/cancel           │  │
│  │    • Stdio Hygiene: Stderr redirection; stdout reserved 100% for JSON-RPC        │  │
│  │    • In-Memory Secret Sanitization: Strips API keys from process.env on boot     │  │
│  │    • Transactional State Manager: Instant rollback on error or cancel            │  │
│  │    • Circuit Breaker: Auto-aborts on recurring repetitive tool failures          │  │
│  └───────────────────┬──────────────────────────────────────────────┬───────────────┘  │
│                      │                                              │                  │
│                      ▼ (SSE Stream)                                 ▼ (JSON-RPC stdio) │
│  ┌────────────────────────────────────────┐   ┌─────────────────────────────────────┐  │
│  │ 2. SSE Parser (`src/sse-parser.ts`)    │   │ 3. MCP Client (`src/mcp-client.ts`) │  │
│  │    • 3-phase streaming parser          │   │    • Dynamic tool discovery         │  │
│  │    • Phase 1: reasoning_content (CoT)  │   │    • OpenAI Schema translation      │  │
│  │    • Phase 2: response content delta   │   │    • Subprocess env sanitization    │  │
│  │    • Phase 3: tool_calls chunk assembly│   │    • Execution timeout safeguards   │  │
│  └───────────────────┬────────────────────┘   └─────────────────────┬───────────────┘  │
└──────────────────────┼──────────────────────────────────────────────┼──────────────────┘
                       │ HTTPS POST /chat/completions                 │ stdio JSON-RPC
                       ▼                                              ▼
┌───────────────────────────────────────────┐   ┌────────────────────────────────────────┐
│            DEEPSEEK REST API              │   │            MCP TOOL SERVER             │
│        (https://api.deepseek.com)         │   │       (e.g., buzz-dev-mcp, etc.)       │
└───────────────────────────────────────────┘   └────────────────────────────────────────┘
```

---

## ✨ Key Features

1. **Native 3-Phase SSE Streaming Parser**:
   * **Phase 1 (`thought`)**: Real-time streaming of `reasoning_content` (DeepSeek-R1 Chain-of-Thought tokens).
   * **Phase 2 (`text`)**: Response content tokens emitted as `session/update` notifications.
   * **Phase 3 (`tool_calls`)**: Incremental assembly of tool names and JSON argument chunks.
2. **Absolute Stdio Hygiene**:
   * All logging, diagnostics, and subprocess outputs are strictly routed to `process.stderr`.
   * `process.stdout` is 100% isolated and reserved for valid ACP JSON-RPC frames, eliminating frame corruption.
3. **In-Memory Secret Sanitization**:
   * API keys are ingested into private memory constants upon initialization and immediately purged from `process.env`.
   * Prevents credential exposure to child processes, inspect commands, or error logs.
4. **Transactional State Management & Rollback**:
   * Takes atomic message snapshots before executing each turn.
   * Restores session state seamlessly to the last stable checkpoint upon client cancellation (`session/cancel`) or uncaught runtime exceptions.
5. **Execution Circuit Breaker and Turn Limit**:
   * Detects stagnant loops: one tool failing with the same error twice in a row, or 5 tool errors in a row whatever
     their tools.
   * Caps the model calls per turn (`ACP_MAX_ITERATIONS`) and ends an exhausted turn with the ACP stop reason `max_turn_requests`.
   * Injects synthetic safeguards for remaining unexecuted tool calls to maintain strict OpenAI tool-call response invariants.
   * Before a turn it stopped ends, gives the model a short wrap-up to tell the person who asked why
     ([When the adapter stops a turn](#when-the-adapter-stops-a-turn)).
6. **Queue Holds and a Fallback Model**:
   * A request DeepSeek holds in its queue with keep-alive comments is cut at `DEEPSEEK_FIRST_EVENT_TIMEOUT_MS`
     instead of being waited out ([When a model call fails](#when-a-model-call-fails)).
   * With `DEEPSEEK_FALLBACK_MODEL`, a stalled call goes to another model, and so do the next calls while the first
     one cools down.
7. **Full Model Context Protocol (MCP) Integration**:
   * Discovers tools dynamically from connected MCP servers and translates them to OpenAI function schemas.
   * Automatically sanitizes child process environments while preserving required authorization tokens and signing keys.
   * Reports every tool call to the client as ACP `tool_call` / `tool_call_update` updates.

---

## 🚀 Installation & Usage

### Global Installation

```bash
npm install -g deepseek-agent-acp
```

### Running as an ACP Adapter

```bash
export DEEPSEEK_API_KEY="sk-your-deepseek-api-key"
export DEEPSEEK_MODEL="deepseek-chat" # or "deepseek-reasoner"
export ACP_MCP_COMMAND="buzz-dev-mcp" # or your MCP server command

deepseek-agent-acp
```

---

## ⚙️ Configuration

| Variable | Default | Description |
| :--- | :--- | :--- |
| `DEEPSEEK_API_KEY` | *(Required)* | DeepSeek API key (or `DEEPSEEK_AUTH_TOKEN`). |
| `DEEPSEEK_MODEL` | `deepseek-chat` | Target model (for example `deepseek-flash`, `deepseek-chat`, `deepseek-reasoner`). |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | Base endpoint URL for completions API. |
| `DEEPSEEK_TEMPERATURE` | `0.0` | Sampling temperature. |
| `DEEPSEEK_THINKING` | *(unset: API default)* | `enabled` or `disabled`, sent as `thinking.type`. DeepSeek models think by default, so set `disabled` for a zero-thinking agent. |
| `DEEPSEEK_REASONING_EFFORT` | *(unset: API default)* | `none` (turns thinking off) or `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, sent as `reasoning_effort`. `DEEPSEEK_THINKING=disabled` wins over any level. |
| `DEEPSEEK_REQUEST_TIMEOUT_MS`| `90000` | How long one model call waits for its response headers, then for a byte before its first useful event (a keep-alive comment counts there), then for each next useful event once the answer has started (ms): it bounds silence, not the whole answer. A positive integer up to 2147483647. |
| `DEEPSEEK_FIRST_EVENT_TIMEOUT_MS` | `300000` | The most a model call waits from sending its request to its first useful event (text, reasoning, a tool call or a finish), whatever comes before it: keep-alive comments never extend it. A positive integer up to 2147483647. With a fallback model and a person waiting, set it much lower (a meeting twin: `15000`). |
| `DEEPSEEK_FALLBACK_MODEL` | *(unset: none)* | A model that takes a call when `DEEPSEEK_MODEL` stalls, and every call while that model cools down, for example `deepseek-v4-pro`. It gets the same messages, tools and parameters. Ignored, with a warning, when it is `DEEPSEEK_MODEL` itself. |
| `DEEPSEEK_MAX_RETRIES` | `2` | How many more times one model call is sent after a failure that may pass, before any of its text was streamed: an integer from 0 to 5, `0` turns retries off. See [When a model call fails](#when-a-model-call-fails). |
| `ACP_MCP_COMMAND` | `buzz-dev-mcp` | Command to launch the Stdio MCP tool server. |
| `ACP_SYSTEM_PROMPT_FILE` | `./system-prompt.md` | Path to custom system instructions. |
| `ACP_MAX_ITERATIONS` | `15` (`25` for coder/builder) | Maximum model calls in one `session/prompt` turn, a positive integer (`BUZZ_MAX_ITERATIONS` is the fallback); a turn it stops still gets the wrap-up's `ACP_WRAPUP_ITERATIONS` calls. Every tool call costs one iteration, so an agent that stays in one turn for minutes (a meeting call that loops on `meeting_wait`) must raise it. |
| `ACP_WRAPUP_ITERATIONS` | `2` | Model calls a turn still gets after the circuit breaker or the iteration limit stopped it, so the model can tell the person why: an integer from 0 to 5, `0` turns the wrap-up off. See [When the adapter stops a turn](#when-the-adapter-stops-a-turn). |
| `MCP_TOOL_TIMEOUT_MS` | `60000` | How long one MCP tool call may run (ms), a positive integer up to 2147483647. It is the MCP request's own timeout: at that bound the call ends with the error `Tool execution timed out after <ms>ms` and the server is told to stop it (`notifications/cancelled`). Up to 0.5.1 the SDK's default of 60 s cut every longer value to 60 s. |
| `OTEL_*`, `PHOENIX_*` | *(unset: no tracing)* | Tracing to Arize Phoenix and what it records: see [Tracing](#-tracing-opentelemetry--arize-phoenix). |

`thinking` and `reasoning_effort` are only added to the request when the matching variable is set, so endpoints
that reject unknown fields keep working. Invalid values are ignored with a warning on stderr, and the effective
settings are logged once at start-up:

```text
[config] model=deepseek-flash thinking=disabled max_iterations=10000 (ACP_MAX_ITERATIONS) request_timeout_ms=90000 first_event_timeout_ms=15000 fallback_model=deepseek-v4-pro max_retries=2 wrapup_iterations=2 tool_timeout_ms=180000
```

Every `DEEPSEEK_*` variable that is not a setting listed above is treated as a secret and removed from the process
environment at start-up (see In-Memory Secret Sanitization).

### Stop reasons

`session/prompt` always ends with an ACP stop reason, so clients such as buzz-acp never see a protocol error:

| `stopReason` | When |
| :--- | :--- |
| `end_turn` | The model finished, or the circuit breaker stopped a loop of failing tool calls: the notice is streamed as text, and the [wrap-up](#when-the-adapter-stops-a-turn) runs first. |
| `max_turn_requests` | The turn used all `ACP_MAX_ITERATIONS` model calls: a notice is streamed, the [wrap-up](#when-the-adapter-stops-a-turn) runs first, and the client may rotate the session. |
| `cancelled` | The client sent `session/cancel`. The model request, the tool list and the tool call in progress are cut short at once (the MCP server is told with `notifications/cancelled`; a server that ignores it may still finish that call), the answer's remaining tool calls never run, a steer that arrives after the cancel is answered `promptRequired`, and the turn is rolled back. ACP requires this stop reason; buzz-acp waits only 5 s for it, so the answer comes at once, not when a tool would end. |
| `error` | A model call failed for good (see [When a model call fails](#when-a-model-call-fails)) and the session was rolled back. Not an ACP value: buzz-acp answers it by respawning the adapter and re-queueing the prompt. |

### When a model call fails

A turn can be long: a meeting twin's whole call is one turn of hundreds of model calls, and a turn that fails is rolled
back and answered `error`. So a model call that fails in a way that may pass is sent again, up to
`DEEPSEEK_MAX_RETRIES` times (default 2), after 1 s, then 2 s, 4 s, …:

- **What is retried.** HTTP 408, 429 and 5xx (DeepSeek's 500 and 503, a gateway's 502 or 504), a connection lost
  before or during the response, no response within `DEEPSEEK_REQUEST_TIMEOUT_MS`, a stream silent for that long, no
  useful event within `DEEPSEEK_FIRST_EVENT_TIMEOUT_MS`, and a response that ends before any useful event. A 400, 401,
  402 or 422 is not: the same request would fail the same way.
- **Only before any text.** A call whose text or reasoning had already been streamed to the client is not sent again,
  so nothing is shown twice. Nothing else of a failed call is ever applied: its tool calls run only after its stream
  has ended, so a retry sends exactly the same messages and repeats no tool call.
- **Progress, not traffic.** A useful event is a chunk with text, reasoning or tool-call pieces, or a `finish_reason`.
  Keep-alive comments and metadata-only chunks (the role-only chunk that opens every DeepSeek stream) are not progress:
  - from sending the request, the first useful event must come within `DEEPSEEK_FIRST_EVENT_TIMEOUT_MS`, and until it
    some byte must come within `DEEPSEEK_REQUEST_TIMEOUT_MS` (a keep-alive counts there: a silent connection is still
    cut at that bound);
  - once the answer has started, each next useful event must come within `DEEPSEEK_REQUEST_TIMEOUT_MS`. A long answer
    that keeps streaming is never cut, but keep-alives no longer hold a stalled one open;
  - after a `finish_reason`, the answer waits at most 5 s (`DEEPSEEK_REQUEST_TIMEOUT_MS` if shorter) for `[DONE]`,
    then is taken as it is.
- **A request DeepSeek holds.** DeepSeek admits a request it cannot serve yet with HTTP 200 and then sends only
  `: keep-alive` comments; its documentation says it closes such a request if inference has not started within 10
  minutes (about 15 were seen on 14 September 2026, when Flash's scheduler was stuck for hours while `deepseek-v4-pro`
  answered at once). Such a **stall** (no useful event in time, or a stream that ends without one) is a failed attempt
  like the others, never an empty answer.
  - With `DEEPSEEK_FALLBACK_MODEL` set, the attempt after a stall goes to that model at once, and so does every call
    of the process while the primary model cools down: 60 s after a stall, doubled at each stall in a row, at most
    10 minutes. After the cooldown the next call tries the primary again; its answer ends the cooldown.
  - An attempt on the fallback model waits at least 60 s for its first event, since its prompt cache starts cold.
    The switch uses one of the `DEEPSEEK_MAX_RETRIES` attempts; any other failure is sent to the same model again,
    after the usual wait.
  - Without a fallback model, a stall is sent to the same model again, after the usual wait.
- **Worst case.** Before its first useful event, one model call takes at most `(DEEPSEEK_MAX_RETRIES + 1) ×
  DEEPSEEK_FIRST_EVENT_TIMEOUT_MS` and the waits: about 15 minutes with the defaults, where 0.5.2 waited for as long as
  DeepSeek held each attempt (30–45 minutes). A meeting twin with `15000` and a fallback model waits 15 s before the
  fallback takes the call, and at most about 90 s if both models stall.
- **Cancel.** A `session/cancel` during the wait before a retry answers `cancelled` at once.
- Each attempt has its own LLM span, named after the model it asked; a retry's carries `deepseek.retry` (1 for the
  first retry), a fallback attempt's `deepseek.fallback`. A call that fails for good ends the turn with `error`, as
  before. `DEEPSEEK_MAX_RETRIES=0` turns retries off: the first failure ends the
  turn.

### When the adapter stops a turn

The circuit breaker and the iteration limit stop a turn the model has not finished. The breaker trips when one tool fails
with the same error twice in a row (the same error text from another tool, such as a timeout or `Not connected`, is no
repeat), or after 5 tool errors in a row whatever their tools; a successful call starts both counts again. A result
that is not an error, such as a meeting gate's refusal `{"ok": false, ...}`, counts as a success.

A client such as buzz-acp relays nothing the agent writes as text: the agent reaches people only through its tools (a
reply tool, speech in a call, the `buzz` CLI). Ended there, such a turn would leave the person who asked without a
word. So the model first gets a **wrap-up**: up to `ACP_WRAPUP_ITERATIONS` (default 2) more model calls, after one
user message from the adapter that starts with `[deepseek-agent-acp: this turn is being stopped]`. It says why the
turn stops and asks the model to tell the person who asked, in one short message, the way it normally answers them,
and then stop.

- **Tools.** Every tool stays offered: the one that failed may be how the agent answers (an agent that posts with its
  shell, whose commands the adapter's own tool timeout fails all alike). After the breaker, only a repeat of a call that
  tripped it — the same tool with the same arguments, whatever their spacing or key order, among the calls that failed
  in a row — is not run, and its result says so. `tool_choice` is never sent: DeepSeek refuses `required` and named
  choices in thinking mode, the API default.
- **No quoting.** The notice never repeats the error text. A tool's output stays in its tool message, as data, and
  never becomes an instruction from the user.
- **End.** The wrap-up ends at its budget, on an answer without tool calls, once a tool posted a message (a Buzz
  event id in its output, so it never posts twice), or when its own breaker trips.
- **Failure.** If a wrap-up call fails (HTTP error, timeout), the wrap-up ends and the turn ends as the stop ended it:
  committed, with the same stop reason. What the wrap-up already did stays, with the notice that asked for it; a notice
  nothing answered is taken out. A `session/cancel` during the wrap-up, even while one of its tool calls runs, rolls the
  whole turn back, as for any cancelled turn.
- `ACP_WRAPUP_ITERATIONS=0` ends a stopped turn at once, as 0.4.0 did.

---

## 🔭 Tracing (OpenTelemetry → Arize Phoenix)

Spans are exported (OTLP/HTTP protobuf) when `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` is
set; `OTEL_SERVICE_NAME`, `PHOENIX_PROJECT_NAME` and `PHOENIX_API_KEY` name the service, the project and the key.
Tracing is fail-open: Phoenix being slow or down never slows or breaks a turn.

```text
agent_turn (AGENT)          one ACP turn: input.value = the prompt, output.value = the answer, token totals
│                           status ERROR when the adapter stopped it (below)
├── llm:<model> (LLM)       one per model call: token counts, output.value = the text answer
│                           a call sent again after a failure: one span per attempt, deepseek.retry on the retries
│                           how its stream went: deepseek.first_event_ms, deepseek.keepalives, deepseek.stream_end
│                           sent to DEEPSEEK_FALLBACK_MODEL: named after it, deepseek.fallback(_reason)
│                           + with OTEL_CAPTURE_LLM_MESSAGES=true: the exact request and the answer (below)
├── tool:<name> (TOOL)      tool.parameters, tool.output_bytes; output.value for posting tools (posted event id)
│                           + output.value for the tools named in OTEL_CAPTURE_TOOL_OUTPUT
└── steer (CHAIN)           a message injected into the running turn
```

A turn the adapter stopped ends with status ERROR and no `output.value`: `error.kind` is `circuit_breaker` or
`iteration_limit`, `error.message` names the tools or the limit, and `deepseek.wrapup.iterations` counts the wrap-up's
model calls, whose LLM spans carry `deepseek.wrapup = true`. A message the wrap-up posted links the turn by
`nostr.posted_event_id`.

Every LLM span whose request was sent says how its stream went: `deepseek.first_event_ms` (from sending the request to
its first useful event, when one came), `deepseek.keepalives` (the keep-alive comments it had) and
`deepseek.stream_end`: `done`, `server_close`, `finish_grace` (taken after its `finish_reason` without `[DONE]`), or
the bound that cut it, `first_event` or `silence`. An attempt sent to `DEEPSEEK_FALLBACK_MODEL` also carries
`deepseek.fallback = true` and `deepseek.fallback_reason`: `stall` when the primary model stalled on this call,
`cooldown` while it cools down from an earlier stall.

Everything beyond that is opt-in. With none of these variables set, every span of a turn the model finishes is what
0.3.0 wrote, plus those three stream attributes on each LLM span.

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `OTEL_CAPTURE_LLM_MESSAGES` | off | `true`: each LLM span records the exact request sent to DeepSeek and the model's answer. |
| `OTEL_CAPTURE_LLM_TOOL_SCHEMAS` | off | `true` (with the above): also each tool's description and JSON schema. Large. |
| `OTEL_CAPTURE_TOOL_OUTPUT` | off | `true`: every tool's output; or a comma-separated list of tool names with `*` wildcards, case-insensitive (`meeting_*,thread_read`). Empty, `false`, `0`, `no`, `off` or `none`: none. |
| `OTEL_LLM_MESSAGE_MAX_CHARS` | `65536` | The longest recorded content or arguments string (64 or more); a longer one ends with `…[truncated N chars]`. |
| `OTEL_LLM_MESSAGES_MAX` | `400` | The most messages per span: the first 2 and the newest `MAX-2` (3 or more); `llm.input_messages_omitted` says how many were left out. |
| `OTEL_LLM_MESSAGES_MAX_TOTAL_CHARS` | `524288` | Budget for all recorded contents of one span: over it, the oldest middle contents (never the first 2 or the last 4) become `…[omitted for size]`; `llm.input_messages_trimmed` counts them. |

An invalid value is ignored with a warning, and one line at start-up says what is recorded:

```text
[config] tracing llm_messages=on tool_schemas=off tool_output=meeting_* message_max_chars=65536 messages_max=400 messages_max_total_chars=524288 attribute_count_limit=4096 attribute_value_length_limit=65536 export_timeout_ms=10000 export_batch=32
```

**What a captured LLM span holds** ([OpenInference](https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md) names; Phoenix shows the messages as a chat):

- `llm.input_messages.<i>.message.role` / `.content` / `.tool_call_id` /
  `.tool_calls.<j>.tool_call.{id,function.name,function.arguments}` — the messages exactly as sent, recorded right before
  the request (a failed request still shows them). `reasoning_content` is never recorded.
- `llm.input_messages_total`, and `llm.input_messages_omitted` / `llm.input_messages_trimmed` when above zero.
- `llm.invocation_parameters` — the request body without messages and tools (model, temperature, thinking,
  reasoning_effort, stream options). Never the API key or headers.
- `llm.tools.<k>.tool.name` (+ `.description` and `.json_schema` with `OTEL_CAPTURE_LLM_TOOL_SCHEMAS=true`).
- `llm.output_messages.0.message.*` — the answer: its text and tool calls, on every way the call ends (including what
  had arrived when a stream broke or the turn was cancelled).

`input.value` and `output.value` keep their meaning, so [buzz-trace](https://www.npmjs.com/package/buzz-trace) reads
turns as before. A captured tool output is `output.value` with `output.mime_type` `application/json` when the recorded
value is JSON, else `text/plain` (cut at 8 KB, as before); posting tools record their output as before.

**Limits and size.** While anything is captured, the SDK keeps up to 4096 attributes per span and values up to
`max(8192, OTEL_LLM_MESSAGE_MAX_CHARS, 8207)` characters (`OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT` / `OTEL_ATTRIBUTE_COUNT_LIMIT`
and `OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT` / `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT` override them), and the exporter gets
10 s (`OTEL_EXPORTER_OTLP_TRACES_TIMEOUT` / `OTEL_EXPORTER_OTLP_TIMEOUT`) with batches of 32 spans. Without capture they
stay 8192 characters, the SDK's 128 attributes, 1.5 s and 128 spans. Every call re-sends the whole history, so an LLM
span holds the system prompt plus the conversation so far: with a 12 KB system prompt about 13–30 KB per span, about
0.3–0.5 MB for a 10-minute call.

**Privacy.** Message capture stores everything the model reads in Phoenix: the system prompt, people's words (a call's
transcript), and every tool result. Known secrets are redacted before anything is cut — the API key and the tokens in
the adapter's environment (exact match, also base64, and their beginning when a string stops part-way through one) and
token formats such as `sk-…`, `glpat-…`, `ghp_…`, `nsec1…` and JWTs. Anything else is stored as it is. Turn capture on
only where everyone who can open the Phoenix project may read those conversations.

---

## 🛠 Supported ACP Methods

### Requests
* **`initialize`**: Exchanges protocol version (`1`), agent metadata, and capabilities (`streaming`, `tools`, `sessionCancellation`).
* **`session/new`**: Initializes a fresh session instance with an isolated message history and system prompt.
* **`session/prompt`**: Executes an autonomous multi-turn prompt, streaming reasoning and text deltas.
* **`session/cancel`** (a notification): Aborts the running model request and tool call, stops the answer's remaining tool calls, restores state to the last checkpoint, and answers the pending `session/prompt` with `stopReason: "cancelled"`.
* **`_session/steering`**: A message for the running turn (buzz-acp's `turn_handling: steer`), answered `injected`. It
  goes into the history right before the turn's next model call, after the results of the tool calls in progress: the
  DeepSeek API refuses a message between an answer's tool calls and their results (HTTP 400). One that arrives while the
  model writes its final answer gets one more model call, so the turn answers it, unless that answer was the turn's
  last allowed call (`ACP_MAX_ITERATIONS`): the turn then ends as finished. A stopped turn's wrap-up calls see it too.
  One that no call of the turn saw is kept for the next turn; a cancelled turn drops it with the rest of the turn. With no turn running, or one being cancelled, the answer is `promptRequired`, and the client sends it as a
  prompt of its own.

### Notifications
* **`session/update`**: Emits real-time stream deltas (`type: "thought"` for reasoning, `type: "text"` for content).
* **`session/update`** (ACP `update.sessionUpdate`): `tool_call` when a tool call starts (`title` = the tool's name,
  `kind` `other`, `status` `in_progress`), then `tool_call_update` when it ends (`completed` or `failed`). No arguments
  or outputs are sent. A client sees each step, and buzz-acp restarts its idle clock on it.
* **`session/turnComplete`**: Signals the clean completion of a prompt turn.

---

## 🧪 Development & Quality Assurance

```bash
# Clone the repository
git clone git@github.com:dongitran/deepseek-agent-acp.git
cd deepseek-agent-acp

# Install dependencies and setup Husky git hooks
npm install

# Run strict ESLint verification
npm run lint

# Run strict TypeScript typecheck
npm run typecheck

# Execute unit test suite
npm test

# Build distribution bundle
npm run build
```

---

## 📄 License

MIT © [Dong Tran](https://github.com/dongitran)
