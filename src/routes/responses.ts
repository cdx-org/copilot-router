/**
 * OpenAI Responses API compatible endpoint (/v1/responses)
 */

import { Hono } from "hono";
import { stream } from "hono/streaming";
import { v4 as uuidv4 } from "uuid";
import type { SessionEvent } from "@github/copilot-sdk";
import type {
  ResponsesCreateRequest,
  ResponsesCreateResponse,
  ResponseInputItem,
  ResponseContentBlock,
  ResponseTool,
  ResponseOutputItem,
} from "../types/responses.js";
import { createSession, destroySession } from "../copilot/client.js";
import {
  type CapturedToolCall,
  type ClientToolSpec,
  createClientToolProxy,
  limitToolCalls,
  normalizeToolInputObject,
  stringifyToolArguments,
  waitForToolCallBatch,
} from "../tools/client-tools.js";

const responses = new Hono();
const MAX_STORED_RESPONSES = 100;

interface StoredResponse {
  response: ResponsesCreateResponse;
  promptText: string;
  inputItems: ResponseInputItem[];
}

const responseStore = new Map<string, StoredResponse>();

// Helper type guards for session events
function isMessageDeltaEvent(
  event: SessionEvent,
): event is Extract<SessionEvent, { type: "assistant.message_delta" }> {
  return event.type === "assistant.message_delta";
}

function isMessageEvent(
  event: SessionEvent,
): event is Extract<SessionEvent, { type: "assistant.message" }> {
  return event.type === "assistant.message";
}

function isIdleEvent(
  event: SessionEvent,
): event is Extract<SessionEvent, { type: "session.idle" }> {
  return event.type === "session.idle";
}

function isErrorEvent(
  event: SessionEvent,
): event is Extract<SessionEvent, { type: "session.error" }> {
  return event.type === "session.error";
}

function stringifyForPrompt(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function responseToolsToClientTools(
  tools: ResponseTool[] | undefined,
): ClientToolSpec[] {
  return (tools ?? [])
    .flatMap((tool): ClientToolSpec[] => {
      const nestedFunction = (tool as { function?: unknown }).function;
      if (
        tool.type === "function" &&
        nestedFunction &&
        typeof nestedFunction === "object" &&
        "name" in nestedFunction &&
        typeof (nestedFunction as { name?: unknown }).name === "string"
      ) {
        const fn = nestedFunction as {
          name: string;
          description?: string;
          parameters?: Record<string, unknown>;
        };
        return [{
          name: fn.name,
          description: fn.description,
          parameters: fn.parameters,
          responseType: "function_call",
        }];
      }
      if (tool.type === "function" && "name" in tool && tool.name) {
        return [{
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          responseType: "function_call",
        }];
      }
      if (tool.type === "local_shell") {
        return [{
          name: "local_shell",
          description:
            tool.description ??
            "Run a local shell command on the API client's machine.",
          parameters: tool.parameters ?? {
            type: "object",
            properties: {
              action: { type: "object" },
              command: {
                oneOf: [
                  { type: "string" },
                  { type: "array", items: { type: "string" } },
                ],
              },
            },
          },
          responseType: "local_shell_call",
        }];
      }
      if (tool.type === "shell") {
        return [{
          name: "shell",
          description:
            tool.description ??
            "Run shell commands on the API client's machine.",
          parameters: tool.parameters ?? {
            type: "object",
            properties: {
              action: { type: "object" },
              commands: {
                oneOf: [
                  { type: "string" },
                  { type: "array", items: { type: "string" } },
                ],
              },
              command: { type: "string" },
            },
          },
          responseType: "shell_call",
        }];
      }
      if (tool.type === "apply_patch") {
        return [{
          name: "apply_patch",
          description:
            tool.description ??
            "Apply a patch on the API client's machine.",
          parameters: tool.parameters ?? {
            type: "object",
            properties: {
              operation: { type: "object" },
              path: { type: "string" },
              diff: { type: "string" },
            },
          },
          responseType: "apply_patch_call",
        }];
      }
      if (tool.type === "mcp") {
        const mcpTool = tool as {
          server_label?: string;
          allowed_tools?:
            | string[]
            | { tool_names?: string[] }
            | null;
          name?: string;
          description?: string;
          parameters?: Record<string, unknown>;
        };
        const allowedToolNames = Array.isArray(mcpTool.allowed_tools)
          ? mcpTool.allowed_tools
          : Array.isArray(mcpTool.allowed_tools?.tool_names)
            ? mcpTool.allowed_tools.tool_names
            : mcpTool.name
              ? [mcpTool.name]
              : mcpTool.server_label
                ? [mcpTool.server_label]
                : [];
        return allowedToolNames.map((name) => ({
          name,
          description:
            mcpTool.description ??
            `Call the "${name}" tool on MCP server "${mcpTool.server_label ?? "mcp"}".`,
          parameters: mcpTool.parameters,
          serverLabel: mcpTool.server_label,
          responseType: "mcp_call",
        }));
      }
      if (tool.type === "custom" && tool.name) {
        return [{
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          namespace:
            typeof tool["namespace"] === "string" ? tool["namespace"] : undefined,
          responseType: "custom_tool_call",
        }];
      }
      const genericTool = tool as {
        name?: string;
        description?: string;
        parameters?: Record<string, unknown>;
      };
      if (!genericTool.name) {
        return [];
      }
      return [{
        name: genericTool.name,
        description: genericTool.description,
        parameters: genericTool.parameters,
        responseType: "function_call",
      }];
    })
    .filter((tool) => !!tool.name);
}

function enabledResponseToolNames(
  toolChoice: ResponsesCreateRequest["tool_choice"],
  allTools: ClientToolSpec[],
): string[] {
  const allToolNames = allTools.map((tool) => tool.name);
  if (toolChoice === "none") {
    return [];
  }
  if (typeof toolChoice === "object") {
    if (toolChoice.type === "none") {
      return [];
    }
    if (toolChoice.type === "mcp") {
      const serverLabel = (toolChoice as { server_label?: string }).server_label;
      const name = toolChoice.name;
      return allTools
        .filter((tool) => {
          if (tool.responseType !== "mcp_call") {
            return false;
          }
          if (serverLabel && tool.serverLabel !== serverLabel) {
            return false;
          }
          return name ? tool.name === name : true;
        })
        .map((tool) => tool.name);
    }
    const name =
      toolChoice.function?.name ??
      (toolChoice as { name?: string | undefined }).name;
    if (name) {
      return allToolNames.includes(name) ? [name] : [];
    }
  }
  return allToolNames;
}

function responseToolChoiceName(
  toolChoice: ResponsesCreateRequest["tool_choice"],
): string | undefined {
  if (typeof toolChoice !== "object") {
    return undefined;
  }
  if (
    toolChoice.type === "local_shell" ||
    toolChoice.type === "shell" ||
    toolChoice.type === "apply_patch"
  ) {
    return toolChoice.type;
  }
  if (toolChoice.type === "mcp") {
    return toolChoice.name ?? (toolChoice as { server_label?: string }).server_label;
  }
  return (
    toolChoice.function?.name ??
    toolChoice.name
  );
}

function validateResponseToolChoice(
  toolChoice: ResponsesCreateRequest["tool_choice"],
  allTools: ClientToolSpec[],
): string | undefined {
  const allToolNames = allTools.map((tool) => tool.name);
  if (toolChoice === "required" && allToolNames.length === 0) {
    return "tool_choice 'required' requires at least one tool";
  }

  if (typeof toolChoice === "object" && toolChoice.type === "mcp") {
    const serverLabel = (toolChoice as { server_label?: string }).server_label;
    const name = toolChoice.name;
    const matched = allTools.some((tool) => {
      if (tool.responseType !== "mcp_call") {
        return false;
      }
      if (serverLabel && tool.serverLabel !== serverLabel) {
        return false;
      }
      return name ? tool.name === name : true;
    });
    return matched
      ? undefined
      : "tool_choice references unknown MCP tool";
  }

  const name = responseToolChoiceName(toolChoice);
  if (name && !allToolNames.includes(name)) {
    return `tool_choice references unknown tool '${name}'`;
  }

  return undefined;
}

function responseToolChoiceInstruction(
  toolChoice: ResponsesCreateRequest["tool_choice"],
): string | undefined {
  if (toolChoice === "required") {
    return "You must call one of the client-provided tools now. Do not answer with normal text instead of making a tool call.";
  }

  if (typeof toolChoice === "object") {
    if (toolChoice.type === "mcp") {
      const serverLabel = (toolChoice as { server_label?: string }).server_label;
      if (toolChoice.name && serverLabel) {
        return `You must call the client-provided MCP tool named "${toolChoice.name}" on server "${serverLabel}" now. Do not answer with normal text instead of making this tool call.`;
      }
      if (serverLabel) {
        return `You must call one of the client-provided MCP tools on server "${serverLabel}" now. Do not answer with normal text instead of making a tool call.`;
      }
    }
    const name = responseToolChoiceName(toolChoice);
    if (name) {
      return `You must call the client-provided tool named "${name}" now. Do not answer with normal text instead of making this tool call.`;
    }
  }

  return undefined;
}

function appendSystemInstruction(
  systemMessage: string | undefined,
  instruction: string | undefined,
): string | undefined {
  if (!instruction) {
    return systemMessage;
  }
  return systemMessage ? `${systemMessage}\n\n${instruction}` : instruction;
}

function responseItemId(prefix: string, callId: string): string {
  return `${prefix}_${callId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === "string") {
    return [value];
  }
  return [];
}

function asStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, mapValue]) => mapValue !== undefined && mapValue !== null)
      .map(([key, mapValue]) => [key, String(mapValue)]),
  );
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function optionalStringOrNull(value: unknown): string | null | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return null;
  }
  return undefined;
}

function toLocalShellAction(args: unknown): Record<string, unknown> {
  const input = normalizeToolInputObject(args);
  const action = isRecord(input["action"]) ? input["action"] : input;
  const command = input["command"];
  const normalized: Record<string, unknown> = {
    type: "exec",
    command: asStringArray(action["command"] ?? command),
    env: asStringMap(action["env"] ?? input["env"]),
  };

  const timeoutMs = numberOrNull(action["timeout_ms"] ?? input["timeout_ms"]);
  if (timeoutMs !== null || action["timeout_ms"] === null || input["timeout_ms"] === null) {
    normalized["timeout_ms"] = timeoutMs;
  }

  const user = optionalStringOrNull(action["user"] ?? input["user"]);
  if (user !== undefined) {
    normalized["user"] = user;
  }

  const workingDirectory = optionalStringOrNull(
    action["working_directory"] ?? input["working_directory"],
  );
  if (workingDirectory !== undefined) {
    normalized["working_directory"] = workingDirectory;
  }

  return normalized;
}

function toShellAction(args: unknown): Record<string, unknown> {
  const input = normalizeToolInputObject(args);
  const action = isRecord(input["action"]) ? input["action"] : input;
  const commands = action["commands"] ?? input["commands"] ?? input["command"];
  return {
    commands: asStringArray(commands),
    max_output_length: numberOrNull(
      action["max_output_length"] ?? input["max_output_length"],
    ),
    timeout_ms: numberOrNull(action["timeout_ms"] ?? input["timeout_ms"]),
  };
}

function toShellEnvironment(args: unknown): Record<string, unknown> | null {
  const input = normalizeToolInputObject(args);
  const action = isRecord(input["action"]) ? input["action"] : {};
  const environment = input["environment"] ?? action["environment"];
  return isRecord(environment) ? environment : null;
}

function toApplyPatchOperation(args: unknown): Record<string, unknown> {
  const input = normalizeToolInputObject(args);
  const operation = isRecord(input["operation"]) ? input["operation"] : input;
  const path =
    typeof operation["path"] === "string"
      ? operation["path"]
      : typeof input["path"] === "string"
        ? input["path"]
        : "";
  const diff =
    typeof operation["diff"] === "string"
      ? operation["diff"]
      : typeof input["diff"] === "string"
        ? input["diff"]
        : "";
  const explicitType = operation["type"] ?? input["type"];
  const validTypes = new Set(["create_file", "delete_file", "update_file"]);
  const type =
    typeof explicitType === "string" && validTypes.has(explicitType)
      ? explicitType
      : operation["delete"] === true || input["delete"] === true
        ? "delete_file"
        : operation["create"] === true || input["create"] === true
          ? "create_file"
          : "update_file";

  if (type === "delete_file") {
    return { type, path };
  }

  return {
    type,
    path,
    diff,
  };
}

function toResponseToolCallOutputItem(call: CapturedToolCall): ResponseOutputItem {
  switch (call.responseType) {
    case "custom_tool_call":
      return {
        type: "custom_tool_call",
        id: responseItemId("ctc", call.id),
        call_id: call.id,
        name: call.name,
        input: stringifyToolArguments(call.arguments),
        ...(call.namespace && { namespace: call.namespace }),
        status: "completed",
      };
    case "local_shell_call":
      return {
        type: "local_shell_call",
        id: responseItemId("lsc", call.id),
        call_id: call.id,
        action: toLocalShellAction(call.arguments),
        status: "completed",
      };
    case "shell_call":
      return {
        type: "shell_call",
        id: responseItemId("shc", call.id),
        call_id: call.id,
        action: toShellAction(call.arguments),
        environment: toShellEnvironment(call.arguments),
        status: "completed",
      };
    case "apply_patch_call":
      return {
        type: "apply_patch_call",
        id: responseItemId("apc", call.id),
        call_id: call.id,
        operation: toApplyPatchOperation(call.arguments),
        status: "completed",
      };
    case "mcp_call":
      return {
        type: "mcp_call",
        id: responseItemId("mcpc", call.id),
        call_id: call.id,
        name: call.name,
        server_label:
          call.serverLabel ??
          (normalizeToolInputObject(call.arguments)["server_label"] as
            | string
            | undefined) ??
          call.name,
        arguments: stringifyToolArguments(call.arguments),
        status: "completed",
      };
    case "function_call":
    default:
      return {
        type: "function_call",
        id: responseItemId("fc", call.id),
        call_id: call.id,
        name: call.name,
        arguments: stringifyToolArguments(call.arguments),
        status: "completed",
      };
  }
}

function buildResponseOutput(
  messageId: string,
  text: string,
  calls: CapturedToolCall[] = [],
): ResponseOutputItem[] {
  const output: ResponseOutputItem[] = [];

  if (text.length > 0 || calls.length === 0) {
    output.push({
      type: "message",
      id: messageId,
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text,
          annotations: [],
        },
      ],
    });
  }

  output.push(...calls.map(toResponseToolCallOutputItem));
  return output;
}

function outputItemsToPrompt(output: ResponseOutputItem[]): string {
  return output
    .map((item) => {
      if (item.type === "message") {
        const text = item.content
          .filter((block) => typeof block.text === "string")
          .map((block) => block.text)
          .join("\n");
        return text ? `Assistant: ${text}` : "";
      }
      if (item.type === "function_call") {
        return `Assistant Tool Call (${item.call_id}): ${item.name} ${item.arguments}`;
      }
      if (item.type === "custom_tool_call") {
        return `Assistant Tool Call (${item.call_id}): ${item.name} ${item.input}`;
      }
      if (item.type === "local_shell_call" || item.type === "shell_call") {
        return `Assistant Tool Call (${item.call_id}): ${item.type} ${stringifyForPrompt(item.action)}`;
      }
      if (item.type === "apply_patch_call") {
        return `Assistant Tool Call (${item.call_id}): ${item.type} ${stringifyForPrompt(item.operation)}`;
      }
      if (item.type === "mcp_call") {
        return `Assistant Tool Call (${item.call_id}): ${item.name} ${item.arguments}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function normalizeResponseInputItems(
  input: string | ResponseInputItem[],
): ResponseInputItem[] {
  if (typeof input !== "string") {
    return input;
  }
  return [
    {
      type: "message",
      role: "user",
      content: input,
    },
  ];
}

function previousResponsePrompt(responseId: string | undefined): string {
  if (!responseId) {
    return "";
  }

  const chain: StoredResponse[] = [];
  const seen = new Set<string>();
  let currentId: string | undefined = responseId;

  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const stored = responseStore.get(currentId);
    if (!stored) {
      break;
    }
    chain.unshift(stored);
    currentId = stored.response.previous_response_id ?? undefined;
  }

  return chain
    .flatMap((stored) => [
      stored.promptText,
      outputItemsToPrompt(stored.response.output),
    ])
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

function rememberResponse(
  response: ResponsesCreateResponse,
  promptText: string,
  inputItems: ResponseInputItem[],
): void {
  responseStore.set(response.id, { response, promptText, inputItems });
  while (responseStore.size > MAX_STORED_RESPONSES) {
    const oldestKey = responseStore.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    responseStore.delete(oldestKey);
  }
}

function buildCompletedResponse(
  body: ResponsesCreateRequest,
  responseId: string,
  messageId: string,
  createdAt: number,
  completedAt: number,
  text: string,
  calls: CapturedToolCall[],
  inputTokens: number,
): ResponsesCreateResponse {
  const outputTokens = Math.ceil(text.length / 4);
  return {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status: "completed",
    completed_at: completedAt,
    error: null,
    incomplete_details: null,
    instructions: body.instructions ?? null,
    max_output_tokens: body.max_output_tokens ?? null,
    model: body.model,
    output: buildResponseOutput(messageId, text, calls),
    output_text: text,
    parallel_tool_calls: body.parallel_tool_calls ?? true,
    previous_response_id: body.previous_response_id ?? null,
    reasoning: {
      effort: null,
      summary: null,
    },
    store: body.store ?? true,
    temperature: body.temperature ?? 1,
    text: {
      format: {
        type: "text",
      },
    },
    tool_choice: body.tool_choice ?? "auto",
    tools: body.tools ?? [],
    top_p: body.top_p ?? 1,
    truncation: "disabled",
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: {
        cached_tokens: 0,
      },
      output_tokens: outputTokens,
      output_tokens_details: {
        reasoning_tokens: 0,
      },
      total_tokens: inputTokens + outputTokens,
    },
    user: null,
    metadata: body.metadata ?? {},
  };
}

/**
 * Convert Responses API input to a prompt for Copilot SDK
 *
 * Since we create a new session per request (stateless API pattern),
 * we must include the full conversation history in the prompt.
 */
function inputToPrompt(
  input: string | ResponseInputItem[],
  instructions?: string,
): { systemMessage: string | undefined; prompt: string } {
  let systemMessage = instructions;
  let prompt: string;

  if (typeof input === "string") {
    prompt = input;
  } else {
    const conversationParts: string[] = [];

    for (const item of input) {
      if (item.type === "message") {
        const messageItem = item as {
          role?: string;
          content?: string | ResponseContentBlock[];
        };
        let content: string;
        if (typeof messageItem.content === "string") {
          content = messageItem.content;
        } else if (Array.isArray(messageItem.content)) {
          const contentBlocks = messageItem.content;
          content = contentBlocks
            .filter(
              (block): block is ResponseContentBlock & { text: string } =>
                (block.type === "input_text" ||
                  block.type === "output_text" ||
                  block.type === "text") &&
                typeof block.text === "string",
            )
            .map((block) => block.text)
            .join("\n");
        } else {
          content = "";
        }

        if (messageItem.role === "system" || messageItem.role === "developer") {
          systemMessage = systemMessage
            ? `${systemMessage}\n${content}`
            : content;
        } else if (messageItem.role === "user") {
          conversationParts.push(`User: ${content}`);
        } else if (messageItem.role === "assistant") {
          conversationParts.push(`Assistant: ${content}`);
        }
      } else if (item.type === "function_call") {
        conversationParts.push(
          `Assistant Tool Call (${item.call_id}): ${item.name} ${item.arguments}`,
        );
      } else if (item.type === "function_call_output") {
        conversationParts.push(
          `Tool Result (${item.call_id}): ${stringifyForPrompt(item.output)}`,
        );
      } else if (
        item.type === "local_shell_call" ||
        item.type === "shell_call" ||
        item.type === "apply_patch_call" ||
        item.type === "mcp_call" ||
        item.type === "custom_tool_call"
      ) {
        conversationParts.push(
          `Assistant Tool Call (${item.call_id ?? item.id ?? "unknown"}): ${item.type} ${stringifyForPrompt(item)}`,
        );
      } else if (
        item.type === "local_shell_call_output" ||
        item.type === "shell_call_output" ||
        item.type === "apply_patch_call_output" ||
        item.type === "mcp_call_output" ||
        item.type === "custom_tool_call_output"
      ) {
        conversationParts.push(
          `Tool Result (${item.call_id ?? "unknown"}): ${stringifyForPrompt(item.output ?? item)}`,
        );
      }
    }

    // Include full conversation history as the prompt
    // This is necessary because we create a new session per request
    prompt = conversationParts.join("\n\n");
  }

  return { systemMessage, prompt };
}

/**
 * Create an error response
 */
function createErrorResponse(message: string, type: string = "invalid_request_error") {
  return {
    error: {
      type,
      message,
    },
  };
}

/**
 * POST /v1/responses - Create a model response
 */
responses.post("/", async (c) => {
  let body: ResponsesCreateRequest;

  try {
    body = await c.req.json<ResponsesCreateRequest>();
  } catch {
    return c.json(createErrorResponse("Invalid JSON body"), 400);
  }

  // Validate required fields
  if (!body.model) {
    return c.json(createErrorResponse("model is required"), 400);
  }

  if (!body.input) {
    return c.json(createErrorResponse("input is required"), 400);
  }

  if (
    body.previous_response_id &&
    !responseStore.has(body.previous_response_id)
  ) {
    return c.json(
      createErrorResponse(
        `Response ${body.previous_response_id} not found`,
        "not_found_error",
      ),
      404,
    );
  }

  const responseId = `resp_${uuidv4().replace(/-/g, "")}`;
  const messageId = `msg_${uuidv4().replace(/-/g, "")}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const isStreaming = body.stream === true;

  const { systemMessage: baseSystemMessage, prompt: currentPrompt } = inputToPrompt(
    body.input,
    body.instructions,
  );
  const priorPrompt = previousResponsePrompt(body.previous_response_id);
  const prompt = [priorPrompt, currentPrompt]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  const inputItems = normalizeResponseInputItems(body.input);
  const clientToolSpecs = responseToolsToClientTools(body.tools);
  const toolProxy = createClientToolProxy(clientToolSpecs);
  const toolChoiceError = validateResponseToolChoice(
    body.tool_choice,
    clientToolSpecs,
  );
  if (toolChoiceError) {
    return c.json(createErrorResponse(toolChoiceError), 400);
  }
  const enabledToolNames = enabledResponseToolNames(
    body.tool_choice,
    clientToolSpecs,
  );
  const clientToolsEnabled = enabledToolNames.length > 0;
  const systemMessage = appendSystemInstruction(
    baseSystemMessage,
    clientToolsEnabled
      ? responseToolChoiceInstruction(body.tool_choice)
      : undefined,
  );

  try {
    const session = await createSession(
      body.model,
      isStreaming,
      systemMessage,
      toolProxy.hasTools ? toolProxy.tools : undefined,
      enabledToolNames,
    );

    if (isStreaming) {
      // Streaming response using Server-Sent Events
      return stream(c, async (streamWriter) => {
        c.header("Content-Type", "text/event-stream");
        c.header("Cache-Control", "no-cache");
        c.header("Connection", "keep-alive");

        let fullContent = "";
        const inputTokens = Math.ceil(prompt.length / 4);
        let sequenceNumber = 0;

        const writeEvent = (
          eventName: string,
          payload: Record<string, unknown>,
        ) =>
          streamWriter.write(
            `event: ${eventName}\ndata: ${JSON.stringify({
              ...payload,
              sequence_number: ++sequenceNumber,
            })}\n\n`,
          );

        // Send response.created event
        const createdEvent = {
          type: "response.created",
          response: {
            id: responseId,
            object: "response",
            created_at: createdAt,
            status: "in_progress",
            model: body.model,
            output: [],
            output_text: "",
            parallel_tool_calls: body.parallel_tool_calls ?? true,
            tool_choice: body.tool_choice ?? "auto",
            tools: body.tools ?? [],
          },
        };
        await writeEvent("response.created", createdEvent);

        // Send response.in_progress event
        const inProgressEvent = {
          type: "response.in_progress",
          response: {
            id: responseId,
            object: "response",
            created_at: createdAt,
            status: "in_progress",
            model: body.model,
            output: [],
            output_text: "",
            parallel_tool_calls: body.parallel_tool_calls ?? true,
            tool_choice: body.tool_choice ?? "auto",
            tools: body.tools ?? [],
          },
        };
        await writeEvent("response.in_progress", inProgressEvent);

        let nextOutputIndex = 0;
        let messageOutputIndex: number | undefined;
        let messageOutputDone = false;
        let writeChain = Promise.resolve();
        let terminalToolCallStarted = false;

        const enqueueWrite = (fn: () => Promise<void>) => {
          writeChain = writeChain.then(fn).catch(() => {});
          return writeChain;
        };

        const ensureMessageOutput = async () => {
          if (messageOutputIndex !== undefined) {
            return messageOutputIndex;
          }

          messageOutputIndex = nextOutputIndex++;
          await writeEvent("response.output_item.added", {
            type: "response.output_item.added",
            output_index: messageOutputIndex,
            item: {
              type: "message",
              id: messageId,
              status: "in_progress",
              role: "assistant",
              content: [],
            },
          });
          await writeEvent("response.content_part.added", {
            type: "response.content_part.added",
            output_index: messageOutputIndex,
            item_id: messageId,
            content_index: 0,
            part: {
              type: "output_text",
              text: "",
              annotations: [],
            },
          });
          return messageOutputIndex;
        };

        const finishMessageOutput = async (force = false) => {
          if (messageOutputDone) {
            return;
          }
          if (messageOutputIndex === undefined) {
            if (!force) {
              return;
            }
            await ensureMessageOutput();
          }
          const outputIndex = messageOutputIndex ?? 0;
          messageOutputDone = true;
          await writeEvent("response.output_text.done", {
            type: "response.output_text.done",
            output_index: outputIndex,
            item_id: messageId,
            content_index: 0,
            logprobs: [],
            text: fullContent,
          });
          await writeEvent("response.content_part.done", {
            type: "response.content_part.done",
            output_index: outputIndex,
            item_id: messageId,
            content_index: 0,
            part: {
              type: "output_text",
              text: fullContent,
              annotations: [],
            },
          });
          await writeEvent("response.output_item.done", {
            type: "response.output_item.done",
            output_index: outputIndex,
            item: {
              type: "message",
              id: messageId,
              status: "completed",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: fullContent,
                  annotations: [],
                },
              ],
            },
          });
        };

        const writeToolCallItems = async (calls: CapturedToolCall[]) => {
          await finishMessageOutput(false);

          for (const call of calls) {
            const outputIndex = nextOutputIndex++;
            const item = toResponseToolCallOutputItem(call);
            const addedItem =
              item.type === "function_call"
                ? { ...item, arguments: "", status: "in_progress" as const }
                : item.type === "custom_tool_call"
                  ? { ...item, input: "", status: "in_progress" as const }
                  : item.type === "mcp_call"
                    ? { ...item, arguments: "", status: "in_progress" as const }
                    : { ...item, status: "in_progress" as const };
            await writeEvent("response.output_item.added", {
              type: "response.output_item.added",
              output_index: outputIndex,
              item: addedItem,
            });
            if (item.type === "function_call") {
              await writeEvent("response.function_call_arguments.delta", {
                type: "response.function_call_arguments.delta",
                output_index: outputIndex,
                item_id: item.id,
                delta: item.arguments,
              });
              await writeEvent("response.function_call_arguments.done", {
                type: "response.function_call_arguments.done",
                output_index: outputIndex,
                item_id: item.id,
                name: item.name,
                arguments: item.arguments,
              });
            } else if (item.type === "custom_tool_call") {
              await writeEvent("response.custom_tool_call_input.delta", {
                type: "response.custom_tool_call_input.delta",
                output_index: outputIndex,
                item_id: item.id,
                delta: item.input,
              });
              await writeEvent("response.custom_tool_call_input.done", {
                type: "response.custom_tool_call_input.done",
                output_index: outputIndex,
                item_id: item.id,
                input: item.input,
              });
            } else if (item.type === "mcp_call") {
              await writeEvent("response.mcp_call.in_progress", {
                type: "response.mcp_call.in_progress",
                output_index: outputIndex,
                item_id: item.id,
              });
              await writeEvent("response.mcp_call_arguments.delta", {
                type: "response.mcp_call_arguments.delta",
                output_index: outputIndex,
                item_id: item.id,
                delta: item.arguments,
              });
              await writeEvent("response.mcp_call_arguments.done", {
                type: "response.mcp_call_arguments.done",
                output_index: outputIndex,
                item_id: item.id,
                arguments: item.arguments,
              });
              await writeEvent("response.mcp_call.completed", {
                type: "response.mcp_call.completed",
                output_index: outputIndex,
                item_id: item.id,
              });
            }
            await writeEvent("response.output_item.done", {
              type: "response.output_item.done",
              output_index: outputIndex,
              item,
            });
          }
        };

        const writeCompletedResponse = async (calls: CapturedToolCall[] = []) => {
          const completedAt = Math.floor(Date.now() / 1000);
          const completedResponse = buildCompletedResponse(
            body,
            responseId,
            messageId,
            createdAt,
            completedAt,
            fullContent,
            calls,
            inputTokens,
          );
          if (completedResponse.store) {
            rememberResponse(completedResponse, currentPrompt, inputItems);
          }
          await writeEvent("response.completed", {
            type: "response.completed",
            response: completedResponse,
          });
        };

        const done = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Request timeout"));
          }, 120000);
          let resolved = false;

          const resolveOnce = () => {
            if (resolved) {
              return;
            }
            resolved = true;
            clearTimeout(timeout);
            resolve();
          };

          if (clientToolsEnabled) {
            toolProxy.waitForToolCall.then(() => {
              terminalToolCallStarted = true;
            });
            waitForToolCallBatch(toolProxy)
              .then((calls) =>
                enqueueWrite(async () => {
                  const callsToReturn = limitToolCalls(
                    calls,
                    body.parallel_tool_calls !== false,
                  );
                  await writeToolCallItems(callsToReturn);
                  await writeCompletedResponse(callsToReturn);
                  resolveOnce();
                }),
              )
              .catch(reject);
          }

          session.on((event) => {
            if (resolved) {
              return;
            }
            if (terminalToolCallStarted && !isErrorEvent(event)) {
              if (
                isMessageEvent(event) &&
                event.data.toolRequests &&
                event.data.toolRequests.length > 0
              ) {
                toolProxy.captureToolRequests(event.data.toolRequests);
              }
              return;
            }
            if (isMessageDeltaEvent(event)) {
              const delta = event.data.deltaContent;
              fullContent += delta;

              enqueueWrite(async () => {
                const outputIndex = await ensureMessageOutput();
                await writeEvent("response.output_text.delta", {
                  type: "response.output_text.delta",
                  output_index: outputIndex,
                  item_id: messageId,
                  content_index: 0,
                  logprobs: [],
                  delta,
                });
              }).catch(() => {});
            } else if (
              isMessageEvent(event) &&
              event.data.toolRequests &&
              event.data.toolRequests.length > 0
            ) {
              toolProxy.captureToolRequests(event.data.toolRequests);
            } else if (isIdleEvent(event)) {
              enqueueWrite(async () => {
                await finishMessageOutput(true);
                await writeCompletedResponse();
                resolveOnce();
              }).catch(() => resolveOnce());
            } else if (isErrorEvent(event)) {
              clearTimeout(timeout);
              reject(new Error(event.data.message));
            }
          });
        });

        await session.send({ prompt });

        try {
          await done;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          const errorEvent = {
            type: "response.failed",
            response: {
              id: responseId,
              object: "response",
              created_at: createdAt,
              status: "failed",
              error: { type: "api_error", message: errorMessage },
            },
          };
          await writeEvent("response.failed", errorEvent);
        }

        await destroySession(session.sessionId);
      });
    } else {
      // Non-streaming response
      let fullContent = "";

      const done = new Promise<
        | { type: "text"; content: string }
        | { type: "function_call"; content: string; calls: CapturedToolCall[] }
      >((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Request timeout"));
        }, 120000);
        let resolved = false;
        let terminalToolCallStarted = false;

        const resolveOnce = (
          result:
            | { type: "text"; content: string }
            | {
                type: "function_call";
                content: string;
                calls: CapturedToolCall[];
              },
        ) => {
          if (resolved) {
            return;
          }
          resolved = true;
          clearTimeout(timeout);
          resolve(result);
        };

        if (clientToolsEnabled) {
          toolProxy.waitForToolCall.then(() => {
            terminalToolCallStarted = true;
          });
          waitForToolCallBatch(toolProxy)
            .then((calls) =>
              resolveOnce({
                type: "function_call",
                content: fullContent,
                calls: limitToolCalls(calls, body.parallel_tool_calls !== false),
              }),
            )
            .catch(reject);
        }

        session.on((event) => {
          if (resolved) {
            return;
          }
          if (terminalToolCallStarted && !isErrorEvent(event)) {
            if (
              isMessageEvent(event) &&
              event.data.toolRequests &&
              event.data.toolRequests.length > 0
            ) {
              toolProxy.captureToolRequests(event.data.toolRequests);
            }
            return;
          }
          if (isMessageDeltaEvent(event)) {
            fullContent += event.data.deltaContent;
          } else if (isMessageEvent(event)) {
            if (event.data.toolRequests && event.data.toolRequests.length > 0) {
              toolProxy.captureToolRequests(event.data.toolRequests);
              return;
            }
            resolveOnce({ type: "text", content: event.data.content });
          } else if (isIdleEvent(event)) {
            resolveOnce({ type: "text", content: fullContent });
          } else if (isErrorEvent(event)) {
            clearTimeout(timeout);
            reject(new Error(event.data.message));
          }
        });
      });

      await session.send({ prompt });
      const result = await done;

      await destroySession(session.sessionId);

      const inputTokens = Math.ceil(prompt.length / 4);
      const completedAt = Math.floor(Date.now() / 1000);
      const responseCalls =
        result.type === "function_call" ? result.calls : [];

      const response = buildCompletedResponse(
        body,
        responseId,
        messageId,
        createdAt,
        completedAt,
        result.content,
        responseCalls,
        inputTokens,
      );

      if (response.store) {
        rememberResponse(response, currentPrompt, inputItems);
      }

      return c.json(response);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Internal server error";
    return c.json(createErrorResponse(errorMessage, "api_error"), 500);
  }
});

/**
 * GET /v1/responses/:response_id/input_items - List stored input items.
 */
responses.get("/:response_id/input_items", (c) => {
  const responseId = c.req.param("response_id");
  const stored = responseStore.get(responseId);
  if (!stored) {
    return c.json(
      createErrorResponse(`Response ${responseId} not found`, "not_found_error"),
      404,
    );
  }

  return c.json({
    object: "list",
    data: stored.inputItems,
    first_id:
      (stored.inputItems[0] as { id?: string } | undefined)?.id ?? null,
    last_id:
      (stored.inputItems.at(-1) as { id?: string } | undefined)?.id ?? null,
    has_more: false,
  });
});

/**
 * GET /v1/responses/:response_id - Get a stored model response.
 */
responses.get("/:response_id", (c) => {
  const responseId = c.req.param("response_id");
  const stored = responseStore.get(responseId);
  if (stored) {
    return c.json(stored.response);
  }
  return c.json(
    createErrorResponse(
      `Response ${responseId} not found`,
      "not_found_error",
    ),
    404,
  );
});

/**
 * DELETE /v1/responses/:response_id - Delete a model response
 * Note: This is a stub since we don't persist responses
 */
responses.delete("/:response_id", (c) => {
  const responseId = c.req.param("response_id");
  responseStore.delete(responseId);
  return c.json({
    id: responseId,
    object: "response",
    deleted: true,
  });
});

/**
 * POST /v1/responses/input_tokens - Get input token counts
 */
responses.post("/input_tokens", async (c) => {
  let body: { model?: string; input?: string | ResponseInputItem[]; instructions?: string };

  try {
    body = await c.req.json();
  } catch {
    return c.json(createErrorResponse("Invalid JSON body"), 400);
  }

  const { prompt } = inputToPrompt(body.input ?? "", body.instructions);

  // Simple token estimation (roughly 4 chars per token)
  const inputTokens = Math.ceil(prompt.length / 4);

  return c.json({
    object: "response.input_tokens",
    input_tokens: inputTokens,
  });
});

export default responses;
