/**
 * Launcher module for running CLI tools through the Copilot Router
 *
 * Handles starting the router, waiting for health, spawning CLIs,
 * and managing the full lifecycle.
 */

import { spawn, ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DEFAULT_PORT = 51741;
const HEALTH_CHECK_TIMEOUT_MS = 30000;
const HEALTH_CHECK_INTERVAL_MS = 200;

interface LaunchOptions {
  port?: number;
  passthroughArgs: string[];
}

/**
 * Wait for the router's health endpoint to respond
 */
async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const startTime = Date.now();
  const url = `http://localhost:${port}/health`;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Server not ready yet, continue polling
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS));
  }

  throw new Error(`Router failed to become healthy within ${timeoutMs}ms`);
}

/**
 * Start the router as a child process
 */
function startRouter(port: number): ChildProcess {
  const currentFile = fileURLToPath(import.meta.url);
  const indexPath = path.join(path.dirname(currentFile), "index.js");

  const routerProcess = spawn(
    process.execPath,
    [indexPath],
    {
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  // Forward router stderr for debugging (but not stdout to avoid noise)
  routerProcess.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      console.error(`[router] ${line}`);
    }
  });

  return routerProcess;
}

/**
 * Launch Claude Code with the router
 */
export async function launchClaudeCode(options: LaunchOptions): Promise<number> {
  const port = options.port ?? DEFAULT_PORT;

  console.log("Starting Copilot Router...");
  const routerProcess = startRouter(port);

  // Handle router crash
  let routerExited = false;
  routerProcess.on("exit", (code) => {
    routerExited = true;
    if (code !== 0 && code !== null) {
      console.error(`Router exited unexpectedly with code ${code}`);
    }
  });

  try {
    await waitForHealth(port, HEALTH_CHECK_TIMEOUT_MS);
    console.log(`Router ready at http://localhost:${port}`);
  } catch (error) {
    routerProcess.kill("SIGTERM");
    throw error;
  }

  // Environment variables for Claude Code
  const claudeEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    ANTHROPIC_BASE_URL: `http://localhost:${port}`,
    ANTHROPIC_AUTH_TOKEN: "copilot-router",
    ANTHROPIC_API_KEY: "",
  };

  console.log("Launching Claude Code...\n");

  const claudeProcess = spawn("claude", options.passthroughArgs, {
    env: claudeEnv,
    stdio: "inherit",
  });

  return new Promise<number>((resolve) => {
    const cleanup = (exitCode: number): void => {
      if (!routerExited) {
        routerProcess.kill("SIGTERM");
      }
      resolve(exitCode);
    };

    claudeProcess.on("exit", (code) => {
      cleanup(code ?? 0);
    });

    claudeProcess.on("error", (error) => {
      console.error(`Failed to launch Claude Code: ${error.message}`);
      console.error("Make sure 'claude' is installed and in your PATH.");
      console.error("Install with: npm install -g @anthropic-ai/claude-code");
      cleanup(1);
    });

    // Forward signals to Claude process
    const forwardSignal = (signal: NodeJS.Signals): void => {
      claudeProcess.kill(signal);
    };

    process.on("SIGINT", () => forwardSignal("SIGINT"));
    process.on("SIGTERM", () => forwardSignal("SIGTERM"));

    // Handle router crash while CLI is running
    routerProcess.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        console.error("\nRouter crashed. Terminating Claude Code...");
        claudeProcess.kill("SIGTERM");
      }
    });
  });
}

/**
 * Launch OpenAI Codex with the router
 */
export async function launchCodex(options: LaunchOptions): Promise<number> {
  const port = options.port ?? DEFAULT_PORT;

  console.log("Starting Copilot Router...");
  const routerProcess = startRouter(port);

  // Handle router crash
  let routerExited = false;
  routerProcess.on("exit", (code) => {
    routerExited = true;
    if (code !== 0 && code !== null) {
      console.error(`Router exited unexpectedly with code ${code}`);
    }
  });

  try {
    await waitForHealth(port, HEALTH_CHECK_TIMEOUT_MS);
    console.log(`Router ready at http://localhost:${port}`);
  } catch (error) {
    routerProcess.kill("SIGTERM");
    throw error;
  }

  // Build Codex args with inline config (TOML inline table format)
  const providerConfig = `{ name = "GitHub Copilot Router", base_url = "http://localhost:${port}/v1", wire_api = "responses" }`;

  const codexArgs = [
    "-c", `model_providers.copilot=${providerConfig}`,
    "-c", "model_provider=copilot",
    ...options.passthroughArgs,
  ];

  console.log("Launching Codex...\n");

  const codexProcess = spawn("codex", codexArgs, {
    stdio: "inherit",
  });

  return new Promise<number>((resolve) => {
    const cleanup = (exitCode: number): void => {
      if (!routerExited) {
        routerProcess.kill("SIGTERM");
      }
      resolve(exitCode);
    };

    codexProcess.on("exit", (code) => {
      cleanup(code ?? 0);
    });

    codexProcess.on("error", (error) => {
      console.error(`Failed to launch Codex: ${error.message}`);
      console.error("Make sure 'codex' is installed and in your PATH.");
      console.error("Install with: npm install -g @openai/codex");
      cleanup(1);
    });

    // Forward signals to Codex process
    const forwardSignal = (signal: NodeJS.Signals): void => {
      codexProcess.kill(signal);
    };

    process.on("SIGINT", () => forwardSignal("SIGINT"));
    process.on("SIGTERM", () => forwardSignal("SIGTERM"));

    // Handle router crash while CLI is running
    routerProcess.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        console.error("\nRouter crashed. Terminating Codex...");
        codexProcess.kill("SIGTERM");
      }
    });
  });
}
