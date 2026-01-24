# GitHub Copilot Router

An OpenAI & Anthropic compatible API router that proxies requests to GitHub Copilot SDK. This allows you to use GitHub Copilot as a backend for any client that supports OpenAI or Anthropic APIs, including **Claude Code**.

## Features

- **OpenAI API compatible** (`/v1/chat/completions`, `/v1/models`)
- **Anthropic API compatible** (`/v1/messages`, `/v1/messages/count_tokens`)
- **Streaming support** for both API formats
- **Dynamic model listing** from Copilot SDK
- **Authentication check** at startup with helpful error messages

## Prerequisites

1. **GitHub Copilot CLI** installed
2. **GitHub Copilot subscription** (Individual, Business, or Enterprise)
3. **Node.js 20+**

### Install GitHub Copilot CLI

```bash
# macOS/Linux via Homebrew
brew install copilot-cli

# Or via npm
npm install -g @github/copilot

# Windows via WinGet
winget install GitHub.Copilot
```

### Authenticate with GitHub Copilot

**Option 1: Interactive login**
```bash
copilot
# Inside the CLI, type:
/login
```

**Option 2: Environment variable**

Create a Personal Access Token (PAT) with "Copilot Requests" permission at https://github.com/settings/personal-access-tokens/new

```bash
export GITHUB_TOKEN=github_pat_xxxxxxxxxxxx
```

**Option 3: GitHub CLI (if already authenticated)**
```bash
gh auth login
```

## Quick Start

```bash
# Clone the repository
git clone <repo-url>
cd github-copilot-router

# Install dependencies
npm install

# Start the server (development mode with hot reload)
npm run dev

# Or build and run production
npm run build
npm start
```

The server runs at `http://localhost:51741` by default.

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

## Integration with Claude Code

Claude Code can be configured to use this router as its backend, allowing you to use GitHub Copilot models through Claude Code's interface.

### Setup

1. **Start the router** (keep it running in a terminal):
   ```bash
   npm run dev
   ```

2. **Configure Claude Code** by creating/editing `.claude/settings.json` in your project:

   ```json
   {
     "env": {
       "ANTHROPIC_BASE_URL": "http://localhost:51741",
       "ANTHROPIC_AUTH_TOKEN": "<ANY-STRING>",
       "ANTHROPIC_API_KEY": "",
       "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-sonnet-4",
       "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4.5",
       "ANTHROPIC_DEFAULT_OPUS_MODEL": "gpt-5"
     }
   }
   ```

3. **Restart Claude Code** to pick up the new configuration.

### Notes

- `ANTHROPIC_AUTH_TOKEN` can be any non-empty string (authentication is handled by GitHub Copilot)
- `ANTHROPIC_API_KEY` should be empty or omitted
- Model names in the config should match models available in GitHub Copilot

## Integration with OpenAI Codex CLI

[OpenAI Codex CLI](https://github.com/openai/codex) can be configured to use this router as a custom model provider.

### Setup

1. **Start the router** (keep it running in a terminal):
   ```bash
   npm run dev
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
