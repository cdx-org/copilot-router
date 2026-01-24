<p align="center">
  <img src="assets/banner.png" alt="GitHub Copilot Router" width="100%">
</p>

# GitHub Copilot Router

<p align="center">
  <a href="https://github.com/yatfuchan/github-copilot-router/blob/main/LICENSE">
    <img src="https://img.shields.io/npm/l/github-copilot-router" alt="License">
  </a>
  <a href="https://www.npmjs.com/package/github-copilot-router">
    <img src="https://img.shields.io/npm/v/github-copilot-router" alt="NPM Version">
  </a>
</p>

<p align="center">
  Run <strong>Claude Code</strong> and <strong>OpenAI Codex</strong> with your Copilot subscription.
</p>

One command. No extra API keys. Just your existing GitHub Copilot plan.

## Quick Start

**Requirements:** [GitHub Copilot subscription](https://github.com/features/copilot) and Node.js 20+

1. **Install GitHub Copilot CLI**

    ```bash
    # macOS/Linux
    brew install copilot-cli

    # Windows
    winget install GitHub.Copilot
    ```

2. **Authenticate**

    ```bash
    copilot
    # Inside the CLI, type:
    /login
    ```

3. **Run the router**

    ```bash
    npx copilot-router cc  # Launch Claude Code
    npx copilot-router cx  # Launch OpenAI Codex
    npx copilot-router     # Start the router server only
    ```

    The server will start at `http://localhost:51741`.

> **Tip:** You can also authenticate via `GITHUB_TOKEN` environment variable with a [PAT](https://github.com/settings/personal-access-tokens/new) that has "Copilot Requests" permission.

## Claude Code Integration

[Claude Code](https://github.com/anthropics/claude-code) can be configured to use this router as its backend, allowing you to use GitHub Copilot models through Claude Code's interface.

### Quick Launch (Recommended)

The easiest way to use Claude Code with the router - no configuration needed:

```bash
npx copilot-router claude-code
# or use the shortcut
npx copilot-router cc
```

This starts the router, launches Claude Code with the correct environment variables, and cleans up when you exit. All arguments are passed through:

```bash
npx copilot-router cc --resume
npx copilot-router cc --dangerously-skip-permissions
```

### Manual Setup

If you prefer to run the router separately:

1. **Start the router** (keep it running in a terminal):
   ```bash
   npx copilot-router
   ```

2. **Configure Claude Code** by creating/editing `.claude/settings.json` in your project:

   ```json
   {
    "env": {
      "ANTHROPIC_BASE_URL": "http://localhost:51741",
      "ANTHROPIC_AUTH_TOKEN": "not-required",
      "ANTHROPIC_API_KEY": "",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "github-copilot/claude-haiku-4.5",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "github-copilot/claude-sonnet-4.5",
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "github-copilot/claude-opus-4.5"
    }
   }
   ```

3. **Restart Claude Code** to pick up the new configuration.

### Notes

- `ANTHROPIC_AUTH_TOKEN` can be any non-empty string (authentication is handled by GitHub Copilot)
- `ANTHROPIC_API_KEY` should be empty or omitted
- Model names in the config should match models available in GitHub Copilot

## OpenAI Codex Integration

[OpenAI Codex CLI](https://github.com/openai/codex) can be configured to use this router as a custom model provider.

### Quick Launch (Recommended)

The easiest way to use Codex with the router - no configuration needed:

```bash
npx copilot-router codex
# or use the shortcut
npx copilot-router cx
```

This starts the router, launches Codex with the correct provider configuration, and cleans up when you exit. All arguments are passed through:

```bash
npx copilot-router cx --model gpt-4o
npx copilot-router cx --full-auto "fix the tests"
```

### Manual Setup

If you prefer to run the router separately:

1. **Start the router** (keep it running in a terminal):
   ```bash
   npx copilot-router
   ```

2. **Configure Codex CLI** by creating/editing `~/.codex/config.toml`:

   ```toml
   model = "gpt-5.2-codex"
   model_provider = "proxy"

   [model_providers.proxy]
   name = "OpenAI using GitHub Copilot Router"
   base_url = "http://localhost:51741/v1"
   wire_api = "responses"
   ```

3. **Run Codex** as normal:
   ```bash
   codex
   ```
   It will now route requests through GitHub Copilot.

### Notes

- Model name should match a model available in GitHub Copilot (e.g., `gpt-5.2-codex`, `gpt-4o`, `claude-sonnet-4.5`)
- No API key configuration needed - authentication is handled by GitHub Copilot

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

> **Note:** The `/v1/responses` endpoint is the newer OpenAI Responses API format, which is recommended over `/v1/chat/completions`. Some clients like OpenAI Codex CLI use `wire_api = "responses"` configuration.

## Usage Examples

### With curl (OpenAI format)

```bash
# Non-streaming
curl http://localhost:51741/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Streaming
curl http://localhost:51741/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### With curl (Anthropic format)

```bash
curl http://localhost:51741/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.5",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### With OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:51741/v1",
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
    base_url="http://localhost:51741",
    api_key="not-required"
)

response = client.messages.create(
    model="claude-sonnet-4.5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.content[0].text)
```

## Configuration

### CLI Commands

| Command | Description |
|---------|-------------|
| `copilot-router` | Start the router server |
| `copilot-router claude-code` | Launch Claude Code through the router |
| `copilot-router cc` | Alias for `claude-code` |
| `copilot-router codex` | Launch OpenAI Codex through the router |
| `copilot-router cx` | Alias for `codex` |

**Options:**

- `--port, -p <port>` - Port for the router (default: 51741)
- `--help, -h` - Show help
- `--version, -v` - Show version

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `51741` | Server port |
| `GITHUB_TOKEN` | - | GitHub PAT for authentication |

## Troubleshooting

### "AUTHENTICATION REQUIRED" error

You're not authenticated with GitHub Copilot. Follow the authentication steps above.

### "copilot" command shows AWS Copilot

You have AWS Copilot installed which conflicts with GitHub Copilot CLI. Either:
- Uninstall both GitHub Copilot and AWS Copilot: `brew uninstall copilot-cli`, and then install GitHub Copilot again.
- Or ensure GitHub Copilot CLI is first in your PATH

### Server doesn't exit after auth error

This was fixed - the server now properly shuts down the Copilot CLI process before exiting.

### 404 errors with Claude Code

Make sure you're using the Anthropic API endpoints (`/v1/messages`), not just OpenAI endpoints. The router supports both.

## Development

```bash
# Type check
npm run typecheck

# Build
npm run build

# Development with hot reload
npm run dev
```

## License

MIT
