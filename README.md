<p align="center">
  <img src="https://github.com/cdx-org/copilot-router/raw/main/assets/banner.png" alt="GitHub Copilot Router" width="100%">
</p>

# GitHub Copilot Router

<p align="center">
  <a href="https://github.com/cdx-org/copilot-router/blob/main/LICENSE">
    <img src="https://img.shields.io/npm/l/github-copilot-router" alt="License">
  </a>
  <a href="https://www.npmjs.com/package/github-copilot-router">
    <img src="https://img.shields.io/npm/v/github-copilot-router" alt="NPM Version">
  </a>
</p>

<p align="center">
  OpenAI and Anthropic compatible API router for GitHub Copilot models.
</p>

Use your existing GitHub Copilot subscription with standard OpenAI and Anthropic client libraries.

> [!NOTE]
> **This is a compatibility proxy for Copilot-backed models.**
>
> - **Client-side tool/function calling is supported** when the request supplies tool definitions
> - **Anthropic Messages tool use is supported** for `tool_use` / `tool_result`, including Claude Code-style streaming
> - **OpenAI tool/function calls are supported** for Chat Completions and Responses API clients
> - **Tool results are statelessly summarized** into the next Copilot prompt
> - **Client tools run on the client side**; the router does not execute Claude Code/Codex file or shell tools
> - **Best for:** Chat applications, simple completions, Q&A bots, prototyping
> - **Compatibility target:** Agentic clients that own their own tools, including Claude Code

## What This Does

This router translates OpenAI and Anthropic API formats to GitHub Copilot SDK calls, allowing you to:

- Use `openai` and `anthropic` Python/JS libraries with Copilot models
- Access Claude, GPT, and Gemini models through your Copilot subscription
- Build chat applications without managing multiple API keys
- Run client-owned tools through Anthropic/OpenAI-compatible tool-call responses

## What This Does NOT Do

- Provide a byte-for-byte replacement for Anthropic/OpenAI APIs
- Preserve durable Copilot conversation state across process restarts
- Execute client tools inside the router process
- Support vision/image inputs or file attachments as native API payloads

## Quick Start

1. **Install the router**

    ```bash
    npm install -g github-copilot-router
    ```

    Or run from source:

    ```bash
    git clone https://github.com/cdx-org/copilot-router.git
    cd copilot-router
    npm install
    npm run build
    node dist/cli.js
    ```

2. **Authenticate GitHub Copilot**

    Use either `GITHUB_TOKEN` or the GitHub Copilot CLI login flow.

    ```bash
    # Option A: PAT with Copilot Requests permission
    export GITHUB_TOKEN=github_pat_xxxxxxxxxxxx
    ```

    ```bash
    # Option B: GitHub Copilot CLI login
    npm install -g @github/copilot
    copilot
    # Inside the CLI, type:
    /login
    ```

    The router uses its bundled `@github/copilot` CLI server when available. Set `COPILOT_CLI_PATH` only if you need to point at a specific Copilot CLI executable.

3. **Run**

    ```bash
    gcr     # Start the router server

    # Launch supported clients through the router
    gcr cc  # Launch Claude Code
    gcr cx  # Launch OpenAI Codex
    ```

    The server starts at `http://localhost:7318`.

> **Tip:** You can also authenticate via `GITHUB_TOKEN` environment variable with a [PAT](https://github.com/settings/personal-access-tokens/new) that has "Copilot Requests" permission.

## Usage Examples

### With OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:7318/v1",
    api_key="not-required"
)

response = client.chat.completions.create(
    model="gpt-4.1",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

### With Anthropic Python SDK

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://localhost:7318",
    api_key="not-required"
)

response = client.messages.create(
    model="claude-sonnet-4.5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.content[0].text)
```

### With curl (OpenAI format)

```bash
# Non-streaming
curl http://localhost:7318/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4.1",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Streaming
curl http://localhost:7318/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4.1",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### With curl (Anthropic format)

```bash
curl http://localhost:7318/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.5",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Anthropic tool use

Clients provide tool definitions in the request. The router returns `tool_use` blocks to the client; the client executes the tool and sends `tool_result` content in the next request.

```bash
curl http://localhost:7318/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.5",
    "max_tokens": 1024,
    "tools": [
      {
        "name": "get_time",
        "description": "Return the current local time",
        "input_schema": {
          "type": "object",
          "properties": {
            "timezone": { "type": "string" }
          },
          "required": ["timezone"]
        }
      }
    ],
    "messages": [
      {
        "role": "user",
        "content": "Use get_time for Asia/Seoul."
      }
    ]
  }'
```

### Claude Code through the router

```bash
gcr cc --model claude-sonnet-4.5
```

For a non-interactive smoke test:

```bash
gcr cc --bare -p "Say exactly ROUTER_OK" \
  --model claude-sonnet-4.5 \
  --output-format text \
  --no-session-persistence \
  --tools ""
```

For a client-side Bash tool smoke test:

```bash
gcr cc --bare -p "Use Bash to run: echo ROUTER_TOOL_OK" \
  --model claude-sonnet-4.5 \
  --output-format stream-json \
  --verbose \
  --no-session-persistence \
  --tools Bash \
  --allowedTools Bash \
  --permission-mode bypassPermissions
```

## API Endpoints

| Endpoint | Method | Format | Description |
|----------|--------|--------|-------------|
| `/v1/responses` | POST | OpenAI | Responses API (recommended) |
| `/v1/responses/input_tokens` | POST | OpenAI | Token counting |
| `/v1/chat/completions` | POST | OpenAI | Chat completions (legacy) |
| `/v1/models` | GET | OpenAI | List available models |
| `/v1/messages` | POST | Anthropic | Messages API |
| `/v1/messages/count_tokens` | POST | Anthropic | Token counting |
| `/health` | GET | - | Health check |

## Use Cases

**Works well for:**
- Custom chatbots and Q&A systems
- LangChain / LlamaIndex applications (chat mode only)
- Chat UIs (Open WebUI, LibreChat, etc.)
- Prototyping with multiple models
- Any application using standard chat completion APIs
- Claude Code via Anthropic `/v1/messages` with client-side tools

**Compatibility-focused for:**
- OpenAI Codex CLI
- Any agentic tool expecting exact Anthropic/OpenAI streaming semantics

## Claude Code & Codex Launchers

> [!NOTE]
> **Client-side tools are passed back to the launched CLI.**
>
> Claude Code and Codex CLI expect to control file operations through their own tools. With this router:
>
> - Anthropic `/v1/messages` tools are returned as `tool_use` content blocks and client `tool_result` history is accepted
> - Anthropic streaming emits Claude Code-compatible `content_block_start`, `input_json_delta`, `content_block_stop`, and `message_delta` events
> - OpenAI Responses `function_call`, `local_shell_call`, `shell_call`, and `apply_patch_call` items are passed back to the client
> - OpenAI Chat Completions tool calls are returned through `tool_calls`
> - Tool result history is converted back into prompt text for the next Copilot request
> - OpenAI Responses `previous_response_id` is supported with an in-memory response store
> - If a request supplies no client tools, the router creates the Copilot session with no available tools
>
> The router still uses Copilot as the upstream model provider, so vendor-specific behavior can differ from direct Anthropic/OpenAI APIs.

### Claude Code Launcher

```bash
gcr cc
# or: gcr claude-code
```

### Codex Launcher

```bash
gcr cx
# or: gcr codex
```

## Configuration

### CLI Commands

| Command | Description |
|---------|-------------|
| `gcr` | Start the router server |
| `gcr claude-code` | Launch Claude Code through Anthropic `/v1/messages` |
| `gcr cc` | Alias for `claude-code` |
| `gcr codex` | Launch OpenAI Codex through Responses API |
| `gcr cx` | Alias for `codex` |

> **Note:** `copilot-router` is an alias for `gcr` (e.g., `copilot-router cc` works too).

**Options:**

- `--port, -p <port>` - Port for the router when starting the server (default: 7318)
- `--port <port>` - Router port for launcher subcommands such as `gcr cc --port 8080 ...`
- `--help, -h` - Show help
- `--version, -v` - Show version

For launcher subcommands, short flags are passed through to the launched CLI. For example, `gcr cc -p "hello"` uses Claude Code's `-p/--print`, not the router port option.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `7318` | Server port |
| `GITHUB_TOKEN` | - | GitHub PAT for authentication |
| `COPILOT_CLI_PATH` | bundled `@github/copilot` when available, otherwise `copilot` | Override the Copilot CLI executable used by the SDK |

## Limitations

| Feature | Status |
|---------|--------|
| Chat completions | ✅ Supported |
| Streaming | ✅ Supported |
| Multi-turn conversations | ✅ Supported |
| Tool/function calling | ✅ Client-side passthrough |
| Anthropic `tool_use` / `tool_result` | ✅ Supported |
| OpenAI Chat `tool_calls` | ✅ Supported |
| OpenAI Responses function/local shell/apply patch calls | ✅ Supported |
| Vision/images | ❌ Not supported |
| File attachments | ❌ Not supported |

## Troubleshooting

### "AUTHENTICATION REQUIRED" error

You're not authenticated with GitHub Copilot. Follow the authentication steps above.

### Claude Code asks for Anthropic auth

Use the launcher (`gcr cc` or `copilot-router cc`) so the router sets `ANTHROPIC_BASE_URL` and a non-empty dummy `ANTHROPIC_API_KEY` for Claude Code.

If you launch Claude Code manually, set:

```bash
export ANTHROPIC_BASE_URL=http://localhost:7318
export ANTHROPIC_API_KEY=copilot-router
```

### "Quota exceeded" from Copilot

This comes from the upstream GitHub Copilot service or account limits. The router returns it as an API error; retry later or check the Copilot plan/account status.

### "copilot" command shows AWS Copilot

You have AWS Copilot installed which conflicts with GitHub Copilot CLI. The router prefers its bundled `@github/copilot` dependency when available. If you override `COPILOT_CLI_PATH` or rely on PATH, either:

- Uninstall both GitHub Copilot and AWS Copilot: `brew uninstall copilot-cli`, and then install GitHub Copilot again.
- Ensure GitHub Copilot CLI is first in your PATH.
- Set `COPILOT_CLI_PATH` to the intended GitHub Copilot CLI executable.

## License

MIT
