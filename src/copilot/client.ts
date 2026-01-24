/**
 * GitHub Copilot SDK client wrapper
 */

import {
  CopilotClient,
  type CopilotSession,
  type ModelInfo,
  type CopilotClientOptions as SDKClientOptions,
} from "@github/copilot-sdk";

// Singleton client instance
let clientInstance: CopilotClient | null = null;
let clientStartPromise: Promise<void> | null = null;

// Re-export ModelInfo for use in routes
export type { ModelInfo };

export interface CopilotClientOptions {
  logLevel?: SDKClientOptions["logLevel"];
  autoRestart?: boolean;
}

/**
 * Get or create the singleton Copilot client
 */
export async function getCopilotClient(
  options: CopilotClientOptions = {},
): Promise<CopilotClient> {
  if (clientInstance) {
    return clientInstance;
  }

  clientInstance = new CopilotClient({
    logLevel: options.logLevel ?? "warning",
    autoRestart: options.autoRestart ?? true,
  });

  // Start the client if not already starting
  if (!clientStartPromise) {
    clientStartPromise = clientInstance.start();
  }

  await clientStartPromise;
  return clientInstance;
}

/**
 * List available models from the Copilot SDK
 */
export async function listAvailableModels(): Promise<ModelInfo[]> {
  const client = await getCopilotClient();
  return client.listModels();
}

/**
 * Check authentication status
 */
export async function checkAuthStatus(): Promise<{
  isAuthenticated: boolean;
  authType?: string;
  login?: string;
  host?: string;
  statusMessage?: string;
}> {
  const client = await getCopilotClient();
  return client.getAuthStatus();
}

/**
 * Shutdown the Copilot client gracefully
 */
export async function shutdownClient(): Promise<void> {
  if (clientInstance) {
    await clientInstance.stop();
    clientInstance = null;
    clientStartPromise = null;
  }
}

/**
 * Session manager for handling multiple concurrent sessions
 */
const activeSessions = new Map<string, CopilotSession>();

/**
 * Create a new Copilot session
 */
export async function createSession(
  model: string,
  streaming: boolean,
  systemMessage?: string,
): Promise<CopilotSession> {
  const client = await getCopilotClient();

  const session = await client.createSession({
    model,
    streaming,
    ...(systemMessage && {
      systemMessage: {
        mode: "append",
        content: systemMessage,
      },
    }),
  });

  activeSessions.set(session.sessionId, session);
  return session;
}

/**
 * Get an active session by ID
 */
export function getSession(sessionId: string): CopilotSession | undefined {
  return activeSessions.get(sessionId);
}

/**
 * Destroy a session
 */
export async function destroySession(sessionId: string): Promise<void> {
  const session = activeSessions.get(sessionId);
  if (session) {
    await session.destroy();
    activeSessions.delete(sessionId);
  }
}

/**
 * Destroy all active sessions
 */
export async function destroyAllSessions(): Promise<void> {
  const destroyPromises = Array.from(activeSessions.values()).map((session) =>
    session.destroy().catch(() => {
      // Ignore errors during cleanup
    }),
  );
  await Promise.all(destroyPromises);
  activeSessions.clear();
}
