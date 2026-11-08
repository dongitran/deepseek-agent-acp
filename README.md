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
5. **Execution Circuit Breaker**:
   * Detects stagnant loops (e.g., 2 consecutive identical tool failures).
   * Injects synthetic safeguards for remaining unexecuted tool calls to maintain strict OpenAI tool-call response invariants.
6. **Full Model Context Protocol (MCP) Integration**:
   * Discovers tools dynamically from connected MCP servers and translates them to OpenAI function schemas.
   * Automatically sanitizes child process environments while preserving required authorization tokens and signing keys.

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
| `DEEPSEEK_MODEL` | `deepseek-chat` | Target model (`deepseek-chat`, `deepseek-reasoner`). |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | Base endpoint URL for completions API. |
| `DEEPSEEK_TEMPERATURE` | `0.0` | Sampling temperature. |
| `DEEPSEEK_REQUEST_TIMEOUT_MS`| `90000` | HTTP fetch and chunk read timeout (ms). |
| `ACP_MCP_COMMAND` | `buzz-dev-mcp` | Command to launch the Stdio MCP tool server. |
| `ACP_SYSTEM_PROMPT_FILE` | `./system-prompt.md` | Path to custom system instructions. |
| `ACP_MAX_ITERATIONS` | `15` (`25` for coder) | Maximum autonomous tool execution turn iterations. |
| `MCP_TOOL_TIMEOUT_MS` | `60000` | Timeout for individual MCP tool calls (ms). |

---

## 🛠 Supported ACP Methods

### Requests
* **`initialize`**: Exchanges protocol version (`1`), agent metadata, and capabilities (`streaming`, `tools`, `sessionCancellation`).
* **`session/new`**: Initializes a fresh session instance with an isolated message history and system prompt.
* **`session/prompt`**: Executes an autonomous multi-turn prompt, streaming reasoning and text deltas.
* **`session/cancel`**: Aborts ongoing completions, restores state to the last checkpoint, and confirms cancellation.

### Notifications
* **`session/update`**: Emits real-time stream deltas (`type: "thought"` for reasoning, `type: "text"` for content).
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
