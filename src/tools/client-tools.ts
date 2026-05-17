/**
 * Client-side tool passthrough helpers.
 *
 * Copilot SDK tools normally execute inside this process. For API clients such
 * as Claude Code and Codex, tools must instead be returned to the client so the
 * client can execute them locally and send the tool result in the next turn.
 */

import { randomUUID } from "node:crypto";
import type { Tool as CopilotTool } from "@github/copilot-sdk";

export interface ClientToolSpec {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  serverLabel?: string;
  namespace?: string;
  responseType?:
    | "function_call"
    | "custom_tool_call"
    | "local_shell_call"
    | "shell_call"
    | "apply_patch_call"
    | "mcp_call";
}

export interface CapturedToolCall {
  id: string;
  name: string;
  arguments: unknown;
  type: "function" | "custom";
  serverLabel?: string;
  namespace?: string;
  responseType?: ClientToolSpec["responseType"];
}

export interface ClientToolProxy {
  tools: CopilotTool[];
  toolNames: string[];
  hasTools: boolean;
  waitForToolCall: Promise<CapturedToolCall>;
  getCalls(): CapturedToolCall[];
  captureToolRequests(
    requests: Array<{
      toolCallId?: string;
      name?: string;
      arguments?: unknown;
      type?: "function" | "custom";
    }>,
  ): void;
}

export function createClientToolProxy(
  specs: ClientToolSpec[] | undefined,
): ClientToolProxy {
  const normalizedSpecs = dedupeToolSpecs(specs ?? []);
  const calls: CapturedToolCall[] = [];
  const seenIds = new Set<string>();
  let resolveFirst: ((call: CapturedToolCall) => void) | undefined;

  const waitForToolCall = new Promise<CapturedToolCall>((resolve) => {
    resolveFirst = resolve;
  });

  const capture = (call: CapturedToolCall): void => {
    if (seenIds.has(call.id)) {
      return;
    }
    seenIds.add(call.id);
    calls.push(call);
    if (resolveFirst) {
      resolveFirst(call);
      resolveFirst = undefined;
    }
  };

  const tools: CopilotTool[] = normalizedSpecs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    handler: (_args, invocation) => {
      capture({
        id: invocation.toolCallId || `toolu_${randomUUID().replace(/-/g, "")}`,
        name: invocation.toolName || spec.name,
        arguments: invocation.arguments ?? _args ?? {},
        type: "function",
        serverLabel: spec.serverLabel,
        namespace: spec.namespace,
        responseType: spec.responseType,
      });

      return {
        textResultForLlm:
          "The tool call was forwarded to the API client for local execution. Stop and wait for the client to send the tool result.",
        resultType: "success" as const,
        toolTelemetry: { forwardedToClient: true },
      };
    },
  }));

  return {
    tools,
    toolNames: normalizedSpecs.map((tool) => tool.name),
    hasTools: tools.length > 0,
    waitForToolCall,
    getCalls: () => [...calls],
    captureToolRequests: (requests) => {
      for (const request of requests) {
        if (!request.name) {
          continue;
        }
        const spec = normalizedSpecs.find((candidate) => candidate.name === request.name);
        capture({
          id:
            request.toolCallId || `toolu_${randomUUID().replace(/-/g, "")}`,
          name: request.name,
          arguments: request.arguments ?? {},
          type: request.type ?? "function",
          serverLabel: spec?.serverLabel,
          namespace: spec?.namespace,
          responseType: spec?.responseType,
        });
      }
    },
  };
}

export async function waitForToolCallBatch(
  proxy: ClientToolProxy,
  debounceMs = 30,
): Promise<CapturedToolCall[]> {
  await proxy.waitForToolCall;
  await new Promise((resolve) => setTimeout(resolve, debounceMs));
  return proxy.getCalls();
}

export function limitToolCalls(
  calls: CapturedToolCall[],
  allowParallel: boolean,
): CapturedToolCall[] {
  return allowParallel ? calls : calls.slice(0, 1);
}

export function stringifyToolArguments(args: unknown): string {
  try {
    return JSON.stringify(normalizeToolInputObject(args));
  } catch {
    return "{}";
  }
}

export function normalizeToolInputObject(args: unknown): Record<string, unknown> {
  if (isRecord(args)) {
    return args as Record<string, unknown>;
  }

  if (typeof args === "string") {
    try {
      const parsed: unknown = JSON.parse(args);
      if (isRecord(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    } catch {
      // Fall through to wrapping the value.
    }
  }

  return args === undefined ? {} : { value: args };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function dedupeToolSpecs(specs: ClientToolSpec[]): ClientToolSpec[] {
  const result: ClientToolSpec[] = [];
  const seen = new Set<string>();

  for (const spec of specs) {
    if (!spec.name || seen.has(spec.name)) {
      continue;
    }
    seen.add(spec.name);
    result.push(spec);
  }

  return result;
}
