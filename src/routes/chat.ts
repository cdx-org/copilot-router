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
  OpenAIError,
} from "../types/openai.js";
import { createSession, destroySession } from "../copilot/client.js";

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

/**
 * Convert OpenAI messages to a single prompt for Copilot SDK
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
    } else if (message.role === "tool") {
      if (message.content) {
        conversationParts.push(`Tool Result: ${message.content}`);
      }
    }
  }

  // Get the last user message as the main prompt
  const lastUserMessage = messages.filter((m) => m.role === "user").pop();
  const prompt = lastUserMessage?.content ?? conversationParts.join("\n");

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

  const { systemMessage, prompt } = messagesToPrompt(body.messages);

  try {
    const session = await createSession(body.model, isStreaming, systemMessage);

    if (isStreaming) {
      // Streaming response using Server-Sent Events
      return stream(c, async (streamWriter) => {
        c.header("Content-Type", "text/event-stream");
        c.header("Cache-Control", "no-cache");
        c.header("Connection", "keep-alive");

        let fullContent = "";

        const done = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Request timeout"));
          }, 120000); // 2 minute timeout

          session.on((event) => {
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

              streamWriter
                .write(`data: ${JSON.stringify(chunk)}\n\n`)
                .catch(() => {
                  // Client disconnected
                });
            } else if (isIdleEvent(event)) {
              clearTimeout(timeout);

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

              streamWriter
                .write(`data: ${JSON.stringify(finalChunk)}\n\n`)
                .then(() => streamWriter.write("data: [DONE]\n\n"))
                .then(() => resolve())
                .catch(() => resolve());
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

      const done = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Request timeout"));
        }, 120000);

        session.on((event) => {
          if (isMessageDeltaEvent(event)) {
            fullContent += event.data.deltaContent;
          } else if (isMessageEvent(event)) {
            clearTimeout(timeout);
            resolve(event.data.content);
          } else if (isIdleEvent(event) && fullContent) {
            clearTimeout(timeout);
            resolve(fullContent);
          } else if (isErrorEvent(event)) {
            clearTimeout(timeout);
            reject(new Error(event.data.message));
          }
        });
      });

      await session.send({ prompt });
      const content = await done;

      // Cleanup session
      await destroySession(session.sessionId);

      // Estimate token counts (rough approximation)
      const promptTokens = Math.ceil(prompt.length / 4);
      const completionTokens = Math.ceil(content.length / 4);

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
              content,
            },
            logprobs: null,
            finish_reason: "stop",
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
