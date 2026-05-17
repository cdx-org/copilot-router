/**
 * Anthropic-compatible /v1/messages endpoint
 */

import { Hono } from "hono";
import { stream } from "hono/streaming";
import { v4 as uuidv4 } from "uuid";
import type { SessionEvent } from "@github/copilot-sdk";
import type {
  AnthropicMessageRequest,
  AnthropicMessageResponse,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTool,
  AnthropicError,
  AnthropicCountTokensRequest,
  AnthropicCountTokensResponse,
  AnthropicStopReason,
  AnthropicUsage,
} from "../types/anthropic.js";
import { createSession, destroySession } from "../copilot/client.js";
import {
  type CapturedToolCall,
  createClientToolProxy,
  limitToolCalls,
  normalizeToolInputObject,
  stringifyToolArguments,
  waitForToolCallBatch,
} from "../tools/client-tools.js";

const messages = new Hono();

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

/**
 * Convert Anthropic text/block content to prompt text.
 */
function contentToPromptText(content: string | AnthropicContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((block) => {
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }

      if (block.type === "tool_use") {
        return `Tool Call (${block.id ?? "unknown"}): ${block.name ?? "unknown"} ${stringifyForPrompt(block.input ?? {})}`;
      }

      if (block.type === "tool_result") {
        const status = block.is_error ? "error" : "success";
        return `Tool Result (${block.tool_use_id ?? "unknown"}, ${status}): ${toolResultContentToPrompt(block.content ?? "")}`;
      }

      if (block.type === "image") {
        return "[Image content]";
      }

      if (block.type === "thinking" || block.type === "redacted_thinking") {
        return "";
      }

      return stringifyForPrompt(block);
    })
    .filter(Boolean)
    .join("\n");
}

function systemToText(
  systemMessage: string | AnthropicContentBlock[] | undefined,
): string | undefined {
  if (!systemMessage) {
    return undefined;
  }
  return contentToPromptText(systemMessage);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolResultContentToPrompt(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (
          block &&
          typeof block === "object" &&
          "type" in block &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string"
        ) {
          return (block as { text: string }).text;
        }
        return stringifyForPrompt(block);
      })
      .filter(Boolean)
      .join("\n");
  }

  return stringifyForPrompt(content);
}

function anthropicToolsToClientTools(tools: AnthropicTool[] | undefined) {
  return (tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: isRecord(tool.input_schema) ? tool.input_schema : undefined,
  }));
}

function validateAnthropicTools(
  tools: AnthropicTool[] | undefined,
): string | undefined {
  const seenToolNames = new Set<string>();

  for (const tool of tools ?? []) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) {
      return `tools contains invalid tool name '${tool.name}'`;
    }
    if (seenToolNames.has(tool.name)) {
      return `tools contains duplicate tool name '${tool.name}'`;
    }
    seenToolNames.add(tool.name);
    const isBuiltInTool =
      typeof tool.type === "string" && tool.type !== "custom";
    if (!isBuiltInTool && !isRecord(tool.input_schema)) {
      return `tool '${tool.name}' is missing a valid input_schema`;
    }
  }

  return undefined;
}

function enabledAnthropicToolNames(
  toolChoice: AnthropicMessageRequest["tool_choice"],
  allToolNames: string[],
): string[] {
  if (
    toolChoice === "none" ||
    (typeof toolChoice === "object" && toolChoice.type === "none")
  ) {
    return [];
  }
  if (typeof toolChoice === "object" && toolChoice.type === "tool") {
    return allToolNames.includes(toolChoice.name) ? [toolChoice.name] : [];
  }
  return allToolNames;
}

function validateAnthropicToolChoice(
  toolChoice: AnthropicMessageRequest["tool_choice"],
  allToolNames: string[],
): string | undefined {
  if (
    (toolChoice === "any" ||
      (typeof toolChoice === "object" && toolChoice.type === "any")) &&
    allToolNames.length === 0
  ) {
    return "tool_choice 'any' requires at least one tool";
  }

  if (typeof toolChoice === "object" && toolChoice.type === "tool") {
    if (!allToolNames.includes(toolChoice.name)) {
      return `tool_choice references unknown tool '${toolChoice.name}'`;
    }
  }

  return undefined;
}

function anthropicToolChoiceInstruction(
  toolChoice: AnthropicMessageRequest["tool_choice"],
): string | undefined {
  if (typeof toolChoice === "object" && toolChoice.type === "tool") {
    return `You must call the client-provided tool named "${toolChoice.name}" now. Do not answer with normal text instead of making this tool call.`;
  }
  if (
    toolChoice === "any" ||
    (typeof toolChoice === "object" && toolChoice.type === "any")
  ) {
    return "You must call one of the client-provided tools now. Do not answer with normal text instead of making a tool call.";
  }
  return undefined;
}

function allowsParallelAnthropicToolCalls(
  toolChoice: AnthropicMessageRequest["tool_choice"],
): boolean {
  return !(
    typeof toolChoice === "object" &&
    toolChoice.disable_parallel_tool_use === true
  );
}

function isForcedAnthropicToolChoice(
  toolChoice: AnthropicMessageRequest["tool_choice"],
): boolean {
  return (
    toolChoice === "any" ||
    (typeof toolChoice === "object" &&
      (toolChoice.type === "any" || toolChoice.type === "tool"))
  );
}

function hasEnabledThinking(body: AnthropicMessageRequest): boolean {
  const thinking = body.thinking;
  return isRecord(thinking) && thinking["type"] !== "disabled";
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

function anthropicToolUseId(id: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "");
  if (safeId.startsWith("toolu_")) {
    return safeId;
  }
  return `toolu_${safeId || uuidv4().replace(/-/g, "")}`;
}

function toAnthropicToolUseBlock(call: CapturedToolCall): AnthropicContentBlock {
  return {
    type: "tool_use",
    id: anthropicToolUseId(call.id),
    name: call.name,
    input: normalizeToolInputObject(call.arguments),
  };
}

function buildToolUseContent(
  text: string,
  calls: CapturedToolCall[],
): AnthropicContentBlock[] {
  return [
    ...(text.trim().length > 0 ? [{ type: "text" as const, text }] : []),
    ...calls.map(toAnthropicToolUseBlock),
  ];
}

function estimateAnthropicOutputTokens(
  text: string,
  calls: CapturedToolCall[] = [],
): number {
  const toolCallChars = calls.reduce(
    (total, call) =>
      total + call.name.length + stringifyToolArguments(call.arguments).length,
    0,
  );
  return Math.ceil((text.length + toolCallChars) / 4);
}

function buildUsage(inputTokens: number, outputTokens: number): AnthropicUsage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    server_tool_use: null,
    service_tier: null,
  };
}

function normalizedStopSequences(
  stopSequences: string[] | undefined,
): string[] {
  return (stopSequences ?? []).filter((sequence) => sequence.length > 0);
}

function maxStopSequenceLength(stopSequences: string[]): number {
  return stopSequences.reduce(
    (maxLength, sequence) => Math.max(maxLength, sequence.length),
    0,
  );
}

function findFirstStopSequence(
  text: string,
  stopSequences: string[],
): { index: number; sequence: string } | undefined {
  let bestMatch: { index: number; sequence: string } | undefined;

  for (const sequence of stopSequences) {
    const index = text.indexOf(sequence);
    if (
      index >= 0 &&
      (!bestMatch ||
        index < bestMatch.index ||
        (index === bestMatch.index &&
          sequence.length > bestMatch.sequence.length))
    ) {
      bestMatch = { index, sequence };
    }
  }

  return bestMatch;
}

function applyStopSequences(
  text: string,
  stopSequences: string[],
): { text: string; stopSequence: string | null } {
  const match = findFirstStopSequence(text, stopSequences);
  if (!match) {
    return { text, stopSequence: null };
  }
  return {
    text: text.slice(0, match.index),
    stopSequence: match.sequence,
  };
}

/**
 * Convert Anthropic messages to a prompt for Copilot SDK
 *
 * Since we create a new session per request (stateless API pattern),
 * we must include the full conversation history in the prompt.
 */
function messagesToPrompt(
  messages: AnthropicMessage[],
  systemMessage?: string | AnthropicContentBlock[],
): { systemMessage: string | undefined; prompt: string } {
  const conversationParts: string[] = [];

  for (const message of messages) {
    const content = contentToPromptText(message.content);

    if (message.role === "user") {
      conversationParts.push(`User: ${content}`);
    } else if (message.role === "assistant") {
      conversationParts.push(`Assistant: ${content}`);
    }
  }

  // Include full conversation history as the prompt
  // This is necessary because we create a new session per request
  const prompt = conversationParts.join("\n\n");

  return { systemMessage: systemToText(systemMessage), prompt };
}

/**
 * Create an Anthropic error response
 */
function createErrorResponse(
  message: string,
  type: string = "invalid_request_error",
): AnthropicError {
  return {
    type: "error",
    error: {
      type,
      message,
    },
  };
}

/**
 * POST /v1/messages - Anthropic-compatible messages endpoint
 */
messages.post("/", async (c) => {
  let body: AnthropicMessageRequest;

  try {
    body = await c.req.json<AnthropicMessageRequest>();
  } catch {
    return c.json(createErrorResponse("Invalid JSON body"), 400);
  }

  // Validate required fields
  if (!body.model) {
    return c.json(createErrorResponse("model is required"), 400);
  }

  if (
    !body.messages ||
    !Array.isArray(body.messages) ||
    body.messages.length === 0
  ) {
    return c.json(
      createErrorResponse("messages array is required and must not be empty"),
      400,
    );
  }

  if (
    typeof body.max_tokens !== "number" ||
    !Number.isFinite(body.max_tokens) ||
    body.max_tokens < 0
  ) {
    return c.json(
      createErrorResponse("max_tokens must be a non-negative number"),
      400,
    );
  }

  const requestId = `msg_${uuidv4().replace(/-/g, "")}`;
  const isStreaming = body.stream === true;

  const { systemMessage: baseSystemMessage, prompt } = messagesToPrompt(
    body.messages,
    body.system,
  );
  const toolsError = validateAnthropicTools(body.tools);
  if (toolsError) {
    return c.json(createErrorResponse(toolsError), 400);
  }
  const toolProxy = createClientToolProxy(
    anthropicToolsToClientTools(body.tools),
  );
  const toolChoiceError = validateAnthropicToolChoice(
    body.tool_choice,
    toolProxy.toolNames,
  );
  if (toolChoiceError) {
    return c.json(createErrorResponse(toolChoiceError), 400);
  }
  const forcedToolChoice = isForcedAnthropicToolChoice(body.tool_choice);
  if (forcedToolChoice && hasEnabledThinking(body)) {
    return c.json(
      createErrorResponse(
        "tool_choice 'any' or 'tool' is incompatible with extended thinking",
      ),
      400,
    );
  }
  const enabledToolNames = enabledAnthropicToolNames(
    body.tool_choice,
    toolProxy.toolNames,
  );
  const clientToolsEnabled = enabledToolNames.length > 0;
  const systemMessage = appendSystemInstruction(
    baseSystemMessage,
    clientToolsEnabled
      ? anthropicToolChoiceInstruction(body.tool_choice)
      : undefined,
  );
  const stopSequences = normalizedStopSequences(body.stop_sequences);

  if (body.max_tokens === 0) {
    const inputTokens = Math.ceil(prompt.length / 4);
    const response: AnthropicMessageResponse = {
      id: requestId,
      type: "message",
      role: "assistant",
      content: [],
      model: body.model,
      stop_reason: "max_tokens",
      stop_sequence: null,
      container: null,
      stop_details: null,
      usage: buildUsage(inputTokens, 0),
    };

    if (!isStreaming) {
      return c.json(response);
    }

    return stream(c, async (streamWriter) => {
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");
      await streamWriter.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: { ...response, stop_reason: null },
        })}\n\n`,
      );
      await streamWriter.write(
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: {
            stop_reason: "max_tokens",
            stop_sequence: null,
            container: null,
            stop_details: null,
          },
          usage: buildUsage(inputTokens, 0),
        })}\n\n`,
      );
      await streamWriter.write(
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      );
    });
  }

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
        const stopSequenceSuffixLength = Math.max(
          0,
          maxStopSequenceLength(stopSequences) - 1,
        );
        let nextContentIndex = 0;
        let textBlockIndex: number | undefined;
        let textBlockStopped = false;
        let pendingText = "";
        let writeChain = Promise.resolve();
        let terminalToolCallStarted = false;

        const writeEvent = (eventName: string, payload: unknown) =>
          streamWriter.write(
            `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`,
          );

        const enqueueWrite = (fn: () => Promise<void>) => {
          writeChain = writeChain.then(fn).catch(() => {});
          return writeChain;
        };

        const ensureTextBlock = async () => {
          if (textBlockIndex !== undefined) {
            return textBlockIndex;
          }
          textBlockIndex = nextContentIndex++;
          const contentBlockStart = {
            type: "content_block_start",
            index: textBlockIndex,
            content_block: {
              type: "text",
              text: "",
            },
          };
          await writeEvent("content_block_start", contentBlockStart);
          return textBlockIndex;
        };

        const stopTextBlock = async () => {
          if (textBlockIndex === undefined || textBlockStopped) {
            return;
          }
          textBlockStopped = true;
          await writeEvent("content_block_stop", {
            type: "content_block_stop",
            index: textBlockIndex,
          });
        };

        const writeMessageStop = async (
          stopReason: AnthropicStopReason,
          calls: CapturedToolCall[] = [],
          stopSequence: string | null = null,
        ) => {
          const messageDelta = {
            type: "message_delta",
            delta: {
              stop_reason: stopReason,
              stop_sequence: stopSequence,
              container: null,
              stop_details: null,
            },
            usage: buildUsage(
              inputTokens,
              estimateAnthropicOutputTokens(fullContent, calls),
            ),
          };
          await writeEvent("message_delta", messageDelta);
          await writeEvent("message_stop", { type: "message_stop" });
        };

        const writeTextDelta = async (text: string) => {
          if (text.length === 0) {
            return;
          }
          fullContent += text;
          const index = await ensureTextBlock();
          await writeEvent("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: {
              type: "text_delta",
              text,
            },
          });
        };

        const flushPendingText = async (force = false) => {
          if (pendingText.length === 0) {
            return;
          }
          const keepLength = force ? 0 : stopSequenceSuffixLength;
          if (pendingText.length <= keepLength) {
            return;
          }
          const emitLength = pendingText.length - keepLength;
          const text = pendingText.slice(0, emitLength);
          pendingText = pendingText.slice(emitLength);
          await writeTextDelta(text);
        };

        const handleTextDelta = async (delta: string) => {
          pendingText += delta;
          const stopMatch = findFirstStopSequence(pendingText, stopSequences);
          if (stopMatch) {
            const textBeforeStop = pendingText.slice(0, stopMatch.index);
            pendingText = "";
            await writeTextDelta(textBeforeStop);
            await stopTextBlock();
            await writeMessageStop("stop_sequence", [], stopMatch.sequence);
            return true;
          }
          await flushPendingText(false);
          return false;
        };

        const finishPendingTextBeforeToolCall = async () => {
          const stopMatch = findFirstStopSequence(pendingText, stopSequences);
          if (stopMatch) {
            const textBeforeStop = pendingText.slice(0, stopMatch.index);
            pendingText = "";
            await writeTextDelta(textBeforeStop);
            await stopTextBlock();
            await writeMessageStop("stop_sequence", [], stopMatch.sequence);
            return true;
          }
          await flushPendingText(true);
          return false;
        };

        const writeToolCalls = async (calls: CapturedToolCall[]) => {
          if (await finishPendingTextBeforeToolCall()) {
            return;
          }
          await stopTextBlock();
          for (const call of calls) {
            const index = nextContentIndex++;
            await writeEvent("content_block_start", {
              type: "content_block_start",
              index,
              content_block: {
                type: "tool_use",
                id: anthropicToolUseId(call.id),
                name: call.name,
                input: {},
              },
            });
            await writeEvent("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: {
                type: "input_json_delta",
                partial_json: "",
              },
            });
            await writeEvent("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: {
                type: "input_json_delta",
                partial_json: stringifyToolArguments(call.arguments),
              },
            });
            await writeEvent("content_block_stop", {
              type: "content_block_stop",
              index,
            });
          }
          await writeMessageStop("tool_use", calls);
        };

        // Send message_start event
        const messageStart = {
          type: "message_start",
          message: {
            id: requestId,
            type: "message",
            role: "assistant",
            content: [],
            model: body.model,
            stop_reason: null,
            stop_sequence: null,
            usage: {
              ...buildUsage(inputTokens, 0),
            },
            container: null,
            stop_details: null,
          },
        };
        await streamWriter.write(
          `event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`,
        );

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
                  await writeToolCalls(
                    limitToolCalls(
                      calls,
                      allowsParallelAnthropicToolCalls(body.tool_choice),
                    ),
                  );
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
              if (forcedToolChoice) {
                return;
              }
              const delta = event.data.deltaContent;
              enqueueWrite(async () => {
                const stopped = await handleTextDelta(delta);
                if (stopped) {
                  resolveOnce();
                }
              }).catch(() => {});
            } else if (
              isMessageEvent(event) &&
              event.data.toolRequests &&
              event.data.toolRequests.length > 0
            ) {
              toolProxy.captureToolRequests(event.data.toolRequests);
            } else if (isIdleEvent(event)) {
              if (forcedToolChoice) {
                reject(new Error("model did not produce required tool_use"));
                return;
              }
              enqueueWrite(async () => {
                await flushPendingText(true);
                await ensureTextBlock();
                await stopTextBlock();
                await writeMessageStop("end_turn");
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
            type: "error",
            error: { type: "api_error", message: errorMessage },
          };
          await streamWriter.write(
            `event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`,
          );
        }

        await destroySession(session.sessionId);
      });
    } else {
      // Non-streaming response
      let fullContent = "";

      const done = new Promise<
        | { type: "text"; content: string }
        | { type: "tool_use"; content: string; calls: CapturedToolCall[] }
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
                type: "tool_use";
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
            .then((calls) => {
              resolveOnce({
                type: "tool_use",
                content: fullContent,
                calls: limitToolCalls(
                  calls,
                  allowsParallelAnthropicToolCalls(body.tool_choice),
                ),
              });
            })
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
            if (forcedToolChoice) {
              return;
            }
            fullContent += event.data.deltaContent;
          } else if (isMessageEvent(event)) {
            if (event.data.toolRequests && event.data.toolRequests.length > 0) {
              toolProxy.captureToolRequests(event.data.toolRequests);
              return;
            }
            if (forcedToolChoice) {
              reject(new Error("model did not produce required tool_use"));
              return;
            }
            resolveOnce({ type: "text", content: event.data.content });
          } else if (isIdleEvent(event)) {
            if (forcedToolChoice) {
              reject(new Error("model did not produce required tool_use"));
              return;
            }
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
      const stoppedText =
        result.type === "text"
          ? applyStopSequences(result.content, stopSequences)
          : { text: result.content, stopSequence: null };
      const outputText = stoppedText.text;
      const outputTokens = estimateAnthropicOutputTokens(
        outputText,
        result.type === "tool_use" ? result.calls : [],
      );

      const response: AnthropicMessageResponse = {
        id: requestId,
        type: "message",
        role: "assistant",
        content:
          result.type === "tool_use"
            ? buildToolUseContent(outputText, result.calls)
            : [{ type: "text", text: outputText }],
        model: body.model,
        stop_reason:
          result.type === "tool_use"
            ? "tool_use"
            : stoppedText.stopSequence
              ? "stop_sequence"
              : "end_turn",
        stop_sequence: stoppedText.stopSequence,
        container: null,
        stop_details: null,
        usage: buildUsage(inputTokens, outputTokens),
      };

      return c.json(response);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Internal server error";
    return c.json(createErrorResponse(errorMessage, "api_error"), 500);
  }
});

/**
 * POST /v1/messages/count_tokens - Token counting endpoint
 */
messages.post("/count_tokens", async (c) => {
  let body: AnthropicCountTokensRequest;

  try {
    body = await c.req.json<AnthropicCountTokensRequest>();
  } catch {
    return c.json(createErrorResponse("Invalid JSON body"), 400);
  }

  if (!body.model) {
    return c.json(createErrorResponse("model is required"), 400);
  }

  if (
    !body.messages ||
    !Array.isArray(body.messages) ||
    body.messages.length === 0
  ) {
    return c.json(
      createErrorResponse("messages array is required and must not be empty"),
      400,
    );
  }

  const toolsError = validateAnthropicTools(body.tools);
  if (toolsError) {
    return c.json(createErrorResponse(toolsError), 400);
  }

  // Simple token estimation (roughly 4 chars per token)
  let totalChars = 0;

  if (body.system) {
    totalChars += systemToText(body.system)?.length ?? 0;
  }

  for (const message of body.messages) {
    totalChars += contentToPromptText(message.content).length;
  }

  for (const tool of body.tools ?? []) {
    totalChars += tool.name.length;
    totalChars += tool.description?.length ?? 0;
    totalChars += stringifyForPrompt(tool.input_schema ?? {}).length;
  }

  const response: AnthropicCountTokensResponse = {
    input_tokens: Math.ceil(totalChars / 4),
  };

  return c.json(response);
});

export default messages;
