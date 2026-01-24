#!/usr/bin/env node
/**
 * GitHub Copilot Router CLI
 *
 * Usage:
 *   npx copilot-router                    # Start the router server
 *   npx copilot-router claude-code        # Launch Claude Code through the router
 *   npx copilot-router cc                 # Alias for claude-code
 *   npx copilot-router codex              # Launch OpenAI Codex through the router
 *   npx copilot-router cx                 # Alias for codex
 *   npx copilot-router --help             # Show help
 */

import { launchClaudeCode, launchCodex } from "./launcher.js";

// Parse CLI arguments
const args = process.argv.slice(2);
const subcommand = args[0];

// Check for global help/version flags first
if (args.includes("--help") || args.includes("-h")) {
  showHelp();
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  showVersion();
} else {
  // Route to appropriate command
  switch (subcommand) {
    case "claude-code":
    case "cc":
      handleClaudeCode(args.slice(1));
      break;
    case "codex":
    case "cx":
      handleCodex(args.slice(1));
      break;
    default:
      // Default: start the server (original behavior)
      handleServer(args);
      break;
  }
}

function showHelp(): void {
  console.log(`
GitHub Copilot Router - OpenAI & Anthropic compatible API for GitHub Copilot

Usage:
  copilot-router [command] [options]

Commands:
  (default)      Start the router server
  claude-code    Launch Claude Code through the router
  cc             Alias for claude-code
  codex          Launch OpenAI Codex through the router
  cx             Alias for codex

Server Options:
  --port, -p <port>  Port to listen on (default: 7318, or PORT env var)

Global Options:
  --help, -h         Show this help message
  --version, -v      Show version

Environment Variables:
  PORT               Server port (default: 7318)
  GITHUB_TOKEN       GitHub PAT for authentication (optional if using gh auth)

Examples:
  # Start the router server
  copilot-router
  copilot-router --port 8080

  # Launch Claude Code (router starts automatically)
  copilot-router claude-code
  copilot-router cc --resume

  # Launch Codex (router starts automatically)
  copilot-router codex
  copilot-router cx --model gpt-4o

Documentation: https://github.com/yatfuchan/github-copilot-router
`);
}

function showVersion(): void {
  import("../package.json", { with: { type: "json" } })
    .then((pkg) => {
      console.log(pkg.default.version);
      process.exit(0);
    })
    .catch(() => {
      console.log("1.0.0");
      process.exit(0);
    });
}

function handleServer(args: string[]): void {
  // Parse --port or -p argument
  const portIndex = args.findIndex((arg) => arg === "--port" || arg === "-p");
  if (portIndex !== -1 && args[portIndex + 1]) {
    const portArg = args[portIndex + 1];
    if (portArg) {
      process.env["PORT"] = portArg;
    }
  }

  // Start the server
  import("./index.js");
}

function handleClaudeCode(args: string[]): void {
  // Extract port if specified
  const portIndex = args.findIndex((arg) => arg === "--port" || arg === "-p");
  let port: number | undefined;
  let passthroughArgs = args;

  if (portIndex !== -1) {
    const portArg = args[portIndex + 1];
    if (portArg !== undefined) {
      port = parseInt(portArg, 10);
      // Remove --port and its value from passthrough args
      passthroughArgs = [
        ...args.slice(0, portIndex),
        ...args.slice(portIndex + 2),
      ];
    }
  }

  launchClaudeCode({ port, passthroughArgs })
    .then((exitCode) => process.exit(exitCode))
    .catch((error: Error) => {
      console.error("Error:", error.message);
      process.exit(1);
    });
}

function handleCodex(args: string[]): void {
  // Extract port if specified
  const portIndex = args.findIndex((arg) => arg === "--port" || arg === "-p");
  let port: number | undefined;
  let passthroughArgs = args;

  if (portIndex !== -1) {
    const portArg = args[portIndex + 1];
    if (portArg !== undefined) {
      port = parseInt(portArg, 10);
      // Remove --port and its value from passthrough args
      passthroughArgs = [
        ...args.slice(0, portIndex),
        ...args.slice(portIndex + 2),
      ];
    }
  }

  launchCodex({ port, passthroughArgs })
    .then((exitCode) => process.exit(exitCode))
    .catch((error: Error) => {
      console.error("Error:", error.message);
      process.exit(1);
    });
}
