#!/usr/bin/env node
/**
 * GitHub Copilot Router CLI
 *
 * Usage:
 *   npx copilot-router
 *   npx copilot-router --port 8080
 *   npx copilot-router --help
 */

// Parse CLI arguments
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
GitHub Copilot Router - OpenAI & Anthropic compatible API for GitHub Copilot

Usage:
  copilot-router [options]

Options:
  --port, -p <port>  Port to listen on (default: 51741, or PORT env var)
  --help, -h         Show this help message
  --version, -v      Show version

Environment Variables:
  PORT               Server port (default: 51741)
  GITHUB_TOKEN       GitHub PAT for authentication (optional if using gh auth)

Examples:
  copilot-router
  copilot-router --port 8080
  PORT=3000 copilot-router

Documentation: https://github.com/yatfuchan/github-copilot-router
`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  // Dynamic import to get version from package.json
  import("../package.json", { with: { type: "json" } })
    .then((pkg) => {
      console.log(pkg.default.version);
      process.exit(0);
    })
    .catch(() => {
      console.log("1.0.0");
      process.exit(0);
    });
} else {
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
