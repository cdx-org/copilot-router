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
  AnthropicError,
  AnthropicCountTokensRequest,
  AnthropicCountTokensResponse,
} from "../types/anthropic.js";
import { createSession, destroySession } from "../copilot/client.js";

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
 * Convert Anthropic messages to a prompt for Copilot SDK
 *
 * Since we create a new session per request (stateless API pattern),
 * we must include the full conversation history in the prompt.
 */
function messagesToPrompt(
  messages: AnthropicMessage[],
  systemMessage?: string,
): { systemMessage: string | undefined; prompt: string } {
  const conversationParts: string[] = [];

  for (const message of messages) {
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter(
              (block): block is AnthropicContentBlock & { text: string } =>
                block.type === "text" && typeof block.text === "string",
            )
            .map((block) => block.text)
            .join("\n");

    if (message.role === "user") {
      conversationParts.push(`User: ${content}`);
    } else if (message.role === "assistant") {
      conversationParts.push(`Assistant: ${content}`);
    }
  }

  // Include full conversation history as the prompt
  // This is necessary because we create a new session per request
  const prompt = conversationParts.join("\n\n");

  return { systemMessage, prompt };
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

  if (!body.max_tokens) {
    return c.json(createErrorResponse("max_tokens is required"), 400);
  }

  const requestId = `msg_${uuidv4().replace(/-/g, "")}`;
  const isStreaming = body.stream === true;

  const { systemMessage, prompt } = messagesToPrompt(
    body.messages,
    body.system,
  );

  try {
    const session = await createSession(body.model, isStreaming, systemMessage);

    if (isStreaming) {
      // Streaming response using Server-Sent Events
      return stream(c, async (streamWriter) => {
        c.header("Content-Type", "text/event-stream");
        c.header("Cache-Control", "no-cache");
        c.header("Connection", "keep-alive");

        let fullContent = "";
        let inputTokens = Math.ceil(prompt.length / 4);

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
              input_tokens: inputTokens,
              output_tokens: 0,
            },
          },
        };
        await streamWriter.write(
          `event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`,
        );

        // Send content_block_start event
        const contentBlockStart = {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        };
        await streamWriter.write(
          `event: content_block_start\ndata: ${JSON.stringify(contentBlockStart)}\n\n`,
        );

        const done = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Request timeout"));
          }, 120000);

          session.on((event) => {
            if (isMessageDeltaEvent(event)) {
              const delta = event.data.deltaContent;
              fullContent += delta;

              const contentDelta = {
                type: "content_block_delta",
                index: 0,
                delta: {
                  type: "text_delta",
                  text: delta,
                },
              };

              streamWriter
                .write(
                  `event: content_block_delta\ndata: ${JSON.stringify(contentDelta)}\n\n`,
                )
                .catch(() => {});
            } else if (isIdleEvent(event)) {
              clearTimeout(timeout);

              // Send content_block_stop
              const contentBlockStop = { type: "content_block_stop", index: 0 };
              streamWriter
                .write(
                  `event: content_block_stop\ndata: ${JSON.stringify(contentBlockStop)}\n\n`,
                )
                .then(() => {
                  // Send message_delta with stop_reason
                  const messageDelta = {
                    type: "message_delta",
                    delta: {
                      stop_reason: "end_turn",
                      stop_sequence: null,
                    },
                    usage: {
                      output_tokens: Math.ceil(fullContent.length / 4),
                    },
                  };
                  return streamWriter.write(
                    `event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`,
                  );
                })
                .then(() => {
                  // Send message_stop
                  const messageStop = { type: "message_stop" };
                  return streamWriter.write(
                    `event: message_stop\ndata: ${JSON.stringify(messageStop)}\n\n`,
                  );
                })
                .then(() => resolve())
                .catch(() => resolve());
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

      await destroySession(session.sessionId);

      const inputTokens = Math.ceil(prompt.length / 4);
      const outputTokens = Math.ceil(content.length / 4);

      const response: AnthropicMessageResponse = {
        id: requestId,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: content }],
        model: body.model,
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
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

  // Simple token estimation (roughly 4 chars per token)
  let totalChars = 0;

  if (body.system) {
    totalChars += body.system.length;
  }

  for (const message of body.messages) {
    if (typeof message.content === "string") {
      totalChars += message.content.length;
    } else {
      for (const block of message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          totalChars += block.text.length;
        }
      }
    }
  }

  const response: AnthropicCountTokensResponse = {
    input_tokens: Math.ceil(totalChars / 4),
  };

  return c.json(response);
});

export default messages;
