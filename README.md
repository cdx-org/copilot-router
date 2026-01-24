<p align="center">
  <img src="https://github.com/ocmrz/copilot-router/raw/main/assets/banner.png" alt="GitHub Copilot Router" width="100%">
</p>

# GitHub Copilot Router

<p align="center">
  <a href="https://github.com/ocmrz/github-copilot-router/blob/main/LICENSE">
    <img src="https://img.shields.io/npm/l/github-copilot-router" alt="License">
  </a>
  <a href="https://www.npmjs.com/package/github-copilot-router">
    <img src="https://img.shields.io/npm/v/github-copilot-router" alt="NPM Version">
  </a>
</p>

<p align="center">
  OpenAI & Anthropic compatible chat proxy for GitHub Copilot models.
</p>

Use your existing GitHub Copilot subscription with standard OpenAI and Anthropic client libraries.

> [!WARNING]
> **This is a chat completion proxy, not a full API replacement.**
>
> - **Tool/function calling is NOT passed through** - client tool definitions are ignored
> - **Copilot has its own tools** - file operations happen on the **router's machine/directory**, not the client's
> - **Claude Code/Codex tools don't work** - their file/shell tools never get invoked; Copilot's tools run instead
> - **Best for:** Chat applications, simple completions, Q&A bots, prototyping
> - **Not for:** Agentic coding assistants expecting client-side tool execution

## What This Does

This router translates OpenAI and Anthropic API formats to GitHub Copilot SDK calls, allowing you to:

- Use `openai` and `anthropic` Python/JS libraries with Copilot models
- Access Claude, GPT, and Gemini models through your Copilot subscription
- Build chat applications without managing multiple API keys

## What This Does NOT Do

- Pass through tool/function calls to clients (Copilot executes tools server-side instead)
- Let Claude Code/Codex control file operations (Copilot's tools run in the router's directory)
- Replace direct API access for agentic tools that need client-side tool execution

## Quick Start

1. **Install [GitHub Copilot CLI](https://github.com/github/copilot-cli)**

    ```bash
    # macOS/Linux
    brew install copilot-cli

    # Windows
    winget install GitHub.Copilot

    # npm (macOS, Linux, and Windows)
    npm install -g @github/copilot

    ```

2. **Authenticate**

    ```bash
    copilot
    # Inside the CLI, type:
    /login
    ```

3. **Install and run**

    ```bash
    npm install -g github-copilot-router
    gcr     # Start the router server

    # Experimental
    gcr cc  # Launch Claude Code
    gcr cx  # Launch OpenAI Codex
    ```

    The server will start at `http://localhost:7318`.

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
    model="gpt-4o",
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
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Streaming
curl http://localhost:7318/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
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

**Does NOT work as expected for:**
- Claude Code (its tools don't work; Copilot's tools run on the router's machine instead)
- OpenAI Codex CLI (its tools don't work; Copilot's tools run on the router's machine instead)
- Any agentic tool expecting client-side tool execution

## Experimental: Claude Code & Codex Launchers

> [!CAUTION]
> **These launchers are experimental and have significant limitations.**
>
> Claude Code and Codex CLI expect to control file operations through their own tools. With this router:
>
> - **Their tools don't work** - tool calls are not passed back to the client
> - **Copilot's tools run instead** - but they operate on the **router's directory**, not your project
> - **Wrong directory problem** - if you ask to "edit src/index.ts", Copilot edits that file where the router is running, not where Claude Code/Codex is running
>
> **Workaround:** Run the router FROM your project directory: `cd /your/project && gcr cc`
>
> **For full functionality, use these tools with their official APIs.**

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
| `gcr claude-code` | Launch Claude Code (limited - see warning above) |
| `gcr cc` | Alias for `claude-code` |
| `gcr codex` | Launch OpenAI Codex (limited - see warning above) |
| `gcr cx` | Alias for `codex` |

> **Note:** `copilot-router` is an alias for `gcr` (e.g., `copilot-router cc` works too).

**Options:**

- `--port, -p <port>` - Port for the router (default: 7318)
- `--help, -h` - Show help
- `--version, -v` - Show version

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `7318` | Server port |
| `GITHUB_TOKEN` | - | GitHub PAT for authentication |

## Limitations

| Feature | Status |
|---------|--------|
| Chat completions | ✅ Supported |
| Streaming | ✅ Supported |
| Multi-turn conversations | ✅ Supported |
| Tool/function calling | ❌ Not supported |
| Vision/images | ❌ Not supported |
| File attachments | ❌ Not supported |

## Troubleshooting

### "AUTHENTICATION REQUIRED" error

You're not authenticated with GitHub Copilot. Follow the authentication steps above.

### "copilot" command shows AWS Copilot

You have AWS Copilot installed which conflicts with GitHub Copilot CLI. Either:
- Uninstall both GitHub Copilot and AWS Copilot: `brew uninstall copilot-cli`, and then install GitHub Copilot again.
- Or ensure GitHub Copilot CLI is first in your PATH

## License

MIT
