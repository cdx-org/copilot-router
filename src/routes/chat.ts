/**
 * OpenAI-compatible /v1/chat/completions endpoint
 */

import { Hono } from "hono";
import { stream } from "hono/streaming";
import { v4 as uuidv4 } from "uuid";
import type { SessionEvent } from "@github/copilot-sdk";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatMessage,
  OpenAITool,
  OpenAIError,
} from "../types/openai.js";
import { createSession, destroySession } from "../copilot/client.js";
import {
  type CapturedToolCall,
  createClientToolProxy,
  limitToolCalls,
  stringifyToolArguments,
  waitForToolCallBatch,
} from "../tools/client-tools.js";

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

const chat = new Hono();

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

function openAIToolsToClientTools(tools: OpenAITool[] | undefined) {
  return (tools ?? []).map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
}

function enabledOpenAIToolNames(
  toolChoice: ChatCompletionRequest["tool_choice"],
  allToolNames: string[],
): string[] {
  if (toolChoice === "none") {
    return [];
  }
  if (typeof toolChoice === "object") {
    const name = toolChoice.function.name;
    return allToolNames.includes(name) ? [name] : [];
  }
  return allToolNames;
}

function validateOpenAIToolChoice(
  toolChoice: ChatCompletionRequest["tool_choice"],
  allToolNames: string[],
): string | undefined {
  if (toolChoice === "required" && allToolNames.length === 0) {
    return "tool_choice 'required' requires at least one tool";
  }

  if (typeof toolChoice === "object") {
    const name = toolChoice.function.name;
    if (!allToolNames.includes(name)) {
      return `tool_choice references unknown tool '${name}'`;
    }
  }

  return undefined;
}

function openAIToolChoiceInstruction(
  toolChoice: ChatCompletionRequest["tool_choice"],
): string | undefined {
  if (typeof toolChoice === "object") {
    return `You must call the client-provided tool named "${toolChoice.function.name}" now. Do not answer with normal text instead of making this tool call.`;
  }
  if (toolChoice === "required") {
    return "You must call one of the client-provided tools now. Do not answer with normal text instead of making a tool call.";
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

function toOpenAIToolCalls(calls: CapturedToolCall[]) {
  return calls.map((call) => ({
    id: call.id,
    type: "function" as const,
    function: {
      name: call.name,
      arguments: stringifyToolArguments(call.arguments),
    },
  }));
}

/**
 * Convert OpenAI messages to a single prompt for Copilot SDK
 *
 * Since we create a new session per request (stateless API pattern),
 * we must include the full conversation history in the prompt.
 */
function messagesToPrompt(messages: ChatMessage[]): {
  systemMessage: string | undefined;
  prompt: string;
} {
  let systemMessage: string | undefined;
  const conversationParts: string[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      // Collect system messages
      if (message.content) {
        systemMessage = systemMessage
          ? `${systemMessage}\n${message.content}`
          : message.content;
      }
    } else if (message.role === "user") {
      if (message.content) {
        conversationParts.push(`User: ${message.content}`);
      }
    } else if (message.role === "assistant") {
      if (message.content) {
        conversationParts.push(`Assistant: ${message.content}`);
      }
      if (message.tool_calls && message.tool_calls.length > 0) {
        conversationParts.push(
          `Assistant Tool Calls: ${stringifyForPrompt(message.tool_calls)}`,
        );
      }
    } else if (message.role === "tool") {
      if (message.content) {
        conversationParts.push(
          `Tool Result (${message.tool_call_id ?? "unknown"}): ${message.content}`,
        );
      }
    }
  }

  // Include full conversation history as the prompt
  // This is necessary because we create a new session per request
  const prompt = conversationParts.join("\n\n");

  return { systemMessage, prompt };
}

/**
 * Create an OpenAI error response
 */
function createErrorResponse(
  message: string,
  type: string = "invalid_request_error",
  code: string | null = null,
): OpenAIError {
  return {
    error: {
      message,
      type,
      param: null,
      code,
    },
  };
}

/**
 * POST /v1/chat/completions
 */
chat.post("/", async (c) => {
  let body: ChatCompletionRequest;

  try {
    body = await c.req.json<ChatCompletionRequest>();
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

  const requestId = `chatcmpl-${uuidv4()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const isStreaming = body.stream === true;

  const { systemMessage: baseSystemMessage, prompt } = messagesToPrompt(
    body.messages,
  );
  const toolProxy = createClientToolProxy(openAIToolsToClientTools(body.tools));
  const toolChoiceError = validateOpenAIToolChoice(
    body.tool_choice,
    toolProxy.toolNames,
  );
  if (toolChoiceError) {
    return c.json(createErrorResponse(toolChoiceError), 400);
  }
  const enabledToolNames = enabledOpenAIToolNames(
    body.tool_choice,
    toolProxy.toolNames,
  );
  const clientToolsEnabled = enabledToolNames.length > 0;
  const systemMessage = appendSystemInstruction(
    baseSystemMessage,
    clientToolsEnabled ? openAIToolChoiceInstruction(body.tool_choice) : undefined,
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
        let writeChain = Promise.resolve();
        let terminalToolCallStarted = false;

        const writeChunk = (chunk: ChatCompletionChunk) =>
          streamWriter.write(`data: ${JSON.stringify(chunk)}\n\n`);

        const enqueueWrite = (fn: () => Promise<void>) => {
          writeChain = writeChain.then(fn).catch(() => {});
          return writeChain;
        };

        await writeChunk({
          id: requestId,
          object: "chat.completion.chunk",
          created: createdAt,
          model: body.model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant" },
              logprobs: null,
              finish_reason: null,
            },
          ],
        });

        const writeToolCallChunks = async (calls: CapturedToolCall[]) => {
          for (const [index, call] of calls.entries()) {
            await writeChunk({
              id: requestId,
              object: "chat.completion.chunk",
              created: createdAt,
              model: body.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index,
                        id: call.id,
                        type: "function",
                        function: {
                          name: call.name,
                          arguments: "",
                        },
                      },
                    ],
                  },
                  logprobs: null,
                  finish_reason: null,
                },
              ],
            });
            await writeChunk({
              id: requestId,
              object: "chat.completion.chunk",
              created: createdAt,
              model: body.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index,
                        function: {
                          arguments: stringifyToolArguments(call.arguments),
                        },
                      },
                    ],
                  },
                  logprobs: null,
                  finish_reason: null,
                },
              ],
            });
          }

          await writeChunk({
            id: requestId,
            object: "chat.completion.chunk",
            created: createdAt,
            model: body.model,
            choices: [
              {
                index: 0,
                delta: {},
                logprobs: null,
                finish_reason: "tool_calls",
              },
            ],
          });
          await streamWriter.write("data: [DONE]\n\n");
        };

        const done = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Request timeout"));
          }, 120000); // 2 minute timeout
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
                  await writeToolCallChunks(
                    limitToolCalls(calls, body.parallel_tool_calls !== false),
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
              const delta = event.data.deltaContent;
              fullContent += delta;

              const chunk: ChatCompletionChunk = {
                id: requestId,
                object: "chat.completion.chunk",
                created: createdAt,
                model: body.model,
                choices: [
                  {
                    index: 0,
                    delta: { content: delta },
                    logprobs: null,
                    finish_reason: null,
                  },
                ],
              };

              enqueueWrite(async () => {
                await writeChunk(chunk);
              }).catch(() => {});
            } else if (
              isMessageEvent(event) &&
              event.data.toolRequests &&
              event.data.toolRequests.length > 0
            ) {
              toolProxy.captureToolRequests(event.data.toolRequests);
            } else if (isIdleEvent(event)) {
              // Send final chunk with finish_reason
              const finalChunk: ChatCompletionChunk = {
                id: requestId,
                object: "chat.completion.chunk",
                created: createdAt,
                model: body.model,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    logprobs: null,
                    finish_reason: "stop",
                  },
                ],
              };

              enqueueWrite(async () => {
                await writeChunk(finalChunk);
                await streamWriter.write("data: [DONE]\n\n");
                resolveOnce();
              }).catch(() => resolveOnce());
            } else if (isErrorEvent(event)) {
              clearTimeout(timeout);
              reject(new Error(event.data.message));
            }
          });
        });

        // Send the prompt
        await session.send({ prompt });

        // Wait for completion
        try {
          await done;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          await streamWriter.write(
            `data: ${JSON.stringify({ error: errorMessage })}\n\n`,
          );
        }

        // Cleanup session
        await destroySession(session.sessionId);
      });
    } else {
      // Non-streaming response
      let fullContent = "";

      const done = new Promise<
        | { type: "text"; content: string }
        | { type: "tool_calls"; content: string; calls: CapturedToolCall[] }
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
                type: "tool_calls";
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
                type: "tool_calls",
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

      // Cleanup session
      await destroySession(session.sessionId);

      // Estimate token counts (rough approximation)
      const promptTokens = Math.ceil(prompt.length / 4);
      const completionTokens = Math.ceil(result.content.length / 4);

      const response: ChatCompletionResponse = {
        id: requestId,
        object: "chat.completion",
        created: createdAt,
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                result.type === "tool_calls" && result.content.length === 0
                  ? null
                  : result.content,
              ...(result.type === "tool_calls" && {
                tool_calls: toOpenAIToolCalls(result.calls),
              }),
            },
            logprobs: null,
            finish_reason:
              result.type === "tool_calls" ? "tool_calls" : "stop",
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      };

      return c.json(response);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Internal server error";
    return c.json(createErrorResponse(errorMessage, "api_error"), 500);
  }
});

export default chat;
