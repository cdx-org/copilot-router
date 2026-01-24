/**
 * GitHub Copilot Router - OpenAI & Anthropic compatible API server
 *
 * This server provides OpenAI and Anthropic compatible API interfaces
 * that route requests to the GitHub Copilot SDK.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import chatRoutes from "./routes/chat.js";
import modelsRoutes from "./routes/models.js";
import messagesRoutes from "./routes/messages.js";
import responsesRoutes from "./routes/responses.js";
import {
  shutdownClient,
  destroyAllSessions,
  getCopilotClient,
  checkAuthStatus,
} from "./copilot/client.js";

const app = new Hono();

// Middleware
app.use("*", cors());
app.use("*", logger());
app.use("*", prettyJSON());

// Health check
app.get("/", (c) => {
  return c.json({
    name: "github-copilot-router",
    version: "1.1.0",
    description:
      "OpenAI & Anthropic compatible API router for GitHub Copilot SDK",
    endpoints: {
      // OpenAI format (Chat Completions - legacy)
      chat_completions: "/v1/chat/completions",
      // OpenAI format (Responses API - recommended)
      responses: "/v1/responses",
      models: "/v1/models",
      // Anthropic format
      messages: "/v1/messages",
      count_tokens: "/v1/messages/count_tokens",
    },
  });
});

app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// OpenAI-compatible routes
app.route("/v1/chat/completions", chatRoutes);
app.route("/v1/responses", responsesRoutes);
app.route("/v1/models", modelsRoutes);

// Anthropic-compatible routes
app.route("/v1/messages", messagesRoutes);

// 404 handler
app.notFound((c) => {
  return c.json(
    {
      error: {
        message: `Not found: ${c.req.method} ${c.req.path}`,
        type: "invalid_request_error",
        param: null,
        code: null,
      },
    },
    404,
  );
});

// Error handler
app.onError((err, c) => {
  console.error("Server error:", err);
  return c.json(
    {
      error: {
        message: err.message ?? "Internal server error",
        type: "api_error",
        param: null,
        code: null,
      },
    },
    500,
  );
});

// Server configuration
// Using port 51741 (in the dynamic/private range 49152-65535) to avoid conflicts
const PORT = parseInt(process.env["PORT"] ?? "51741", 10);

// Start server
async function main(): Promise<void> {
  console.log("Initializing GitHub Copilot SDK client...");

  try {
    await getCopilotClient({ logLevel: "info" });
    console.log("Copilot SDK client initialized successfully");
  } catch (error: unknown) {
    console.error("Failed to initialize Copilot SDK client:", error);
    console.log("\nNote: Make sure the Copilot CLI is installed.");
    console.log("Install with: brew install copilot-cli");
    console.log("         or: npm install -g @github/copilot");
    process.exit(1);
  }

  // Check authentication status
  console.log("Checking authentication status...");
  try {
    const authStatus = await checkAuthStatus();

    if (!authStatus.isAuthenticated) {
      console.error(
        "\n╔══════════════════════════════════════════════════════════════╗",
      );
      console.error(
        "║                    AUTHENTICATION REQUIRED                   ║",
      );
      console.error(
        "╠══════════════════════════════════════════════════════════════╣",
      );
      console.error(
        "║  You are not authenticated with GitHub Copilot.              ║",
      );
      console.error(
        "║                                                              ║",
      );
      console.error(
        "║  Please authenticate using one of these methods:             ║",
      );
      console.error(
        "║                                                              ║",
      );
      console.error(
        "║  1. Interactive login (run copilot, then use /login):        ║",
      );
      console.error(
        "║     $ copilot                                                ║",
      );
      console.error(
        "║     > /login                                                 ║",
      );
      console.error(
        "║                                                              ║",
      );
      console.error(
        "║  2. Environment variable (PAT with Copilot Requests perm):   ║",
      );
      console.error(
        "║     $ export GITHUB_TOKEN=github_pat_xxxxxxxxxxxx            ║",
      );
      console.error(
        "║                                                              ║",
      );
      console.error(
        "║  3. Using GitHub CLI (if already authenticated):             ║",
      );
      console.error(
        "║     $ gh auth login                                          ║",
      );
      console.error(
        "║                                                              ║",
      );
      console.error(
        "║  Note: A GitHub Copilot subscription is required.            ║",
      );
      console.error(
        "║  Create PAT at: https://github.com/settings/tokens           ║",
      );
      console.error(
        "╚══════════════════════════════════════════════════════════════╝\n",
      );

      // Shutdown the client before exiting to ensure clean exit
      await shutdownClient();
      process.exit(1);
    }

    console.log(`✓ Authenticated as: ${authStatus.login ?? "unknown"}`);
    if (authStatus.authType) {
      console.log(`  Auth type: ${authStatus.authType}`);
    }
    if (authStatus.host) {
      console.log(`  Host: ${authStatus.host}`);
    }
  } catch (error: unknown) {
    console.error("Failed to check authentication status:", error);
    console.log("\nPlease ensure you are authenticated:");
    console.log("  1. Run 'copilot' and use '/login' command, or");
    console.log("  2. Set GITHUB_TOKEN environment variable");
    await shutdownClient();
    process.exit(1);
  }

  const server = serve({
    fetch: app.fetch,
    port: PORT,
  });

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║      GitHub Copilot Router - OpenAI & Anthropic Compatible   ║
╠══════════════════════════════════════════════════════════════╣
║  Server running at: http://localhost:${PORT.toString().padEnd(24)}║
║                                                              ║
║  OpenAI Endpoints:                                           ║
║    POST /v1/responses         - Responses API (recommended)  ║
║    POST /v1/chat/completions  - Chat completions (legacy)    ║
║    GET  /v1/models            - List models                  ║
║                                                              ║
║  Anthropic Endpoints:                                        ║
║    POST /v1/messages          - Messages API                 ║
║    POST /v1/messages/count_tokens - Token counting           ║
║                                                              ║
║  Usage:                                                      ║
║    base_url: http://localhost:${PORT}/v1                       ║
║    api_key: "not-required" (uses Copilot auth)               ║
╚══════════════════════════════════════════════════════════════╝
`);

  // Graceful shutdown handlers
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\nReceived ${signal}. Shutting down gracefully...`);

    try {
      await destroyAllSessions();
      await shutdownClient();
      server.close();
      console.log("Shutdown complete.");
      process.exit(0);
    } catch (error) {
      console.error("Error during shutdown:", error);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
