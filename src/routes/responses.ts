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
} from "../types/responses.js";
import { createSession, destroySession } from "../copilot/client.js";

const responses = new Hono();

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
        let content: string;
        if (typeof item.content === "string") {
          content = item.content;
        } else {
          content = item.content
            .filter(
              (block): block is ResponseContentBlock & { text: string } =>
                (block.type === "input_text" ||
                  block.type === "output_text" ||
                  block.type === "text") &&
                typeof block.text === "string",
            )
            .map((block) => block.text)
            .join("\n");
        }

        if (item.role === "system") {
          systemMessage = systemMessage
            ? `${systemMessage}\n${content}`
            : content;
        } else if (item.role === "user") {
          conversationParts.push(`User: ${content}`);
        } else if (item.role === "assistant") {
          conversationParts.push(`Assistant: ${content}`);
        }
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

  const responseId = `resp_${uuidv4().replace(/-/g, "")}`;
  const messageId = `msg_${uuidv4().replace(/-/g, "")}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const isStreaming = body.stream === true;

  const { systemMessage, prompt } = inputToPrompt(body.input, body.instructions);

  try {
    const session = await createSession(body.model, isStreaming, systemMessage);

    if (isStreaming) {
      // Streaming response using Server-Sent Events
      return stream(c, async (streamWriter) => {
        c.header("Content-Type", "text/event-stream");
        c.header("Cache-Control", "no-cache");
        c.header("Connection", "keep-alive");

        let fullContent = "";
        const inputTokens = Math.ceil(prompt.length / 4);

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
          },
        };
        await streamWriter.write(`event: response.created\ndata: ${JSON.stringify(createdEvent)}\n\n`);

        // Send response.in_progress event
        const inProgressEvent = {
          type: "response.in_progress",
          response: {
            id: responseId,
            object: "response",
            created_at: createdAt,
            status: "in_progress",
            model: body.model,
          },
        };
        await streamWriter.write(`event: response.in_progress\ndata: ${JSON.stringify(inProgressEvent)}\n\n`);

        // Send output_item.added event
        const outputItemAddedEvent = {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "message",
            id: messageId,
            status: "in_progress",
            role: "assistant",
            content: [],
          },
        };
        await streamWriter.write(`event: response.output_item.added\ndata: ${JSON.stringify(outputItemAddedEvent)}\n\n`);

        // Send content_part.added event
        const contentPartAddedEvent = {
          type: "response.content_part.added",
          output_index: 0,
          content_index: 0,
          part: {
            type: "output_text",
            text: "",
            annotations: [],
          },
        };
        await streamWriter.write(`event: response.content_part.added\ndata: ${JSON.stringify(contentPartAddedEvent)}\n\n`);

        const done = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Request timeout"));
          }, 120000);

          session.on((event) => {
            if (isMessageDeltaEvent(event)) {
              const delta = event.data.deltaContent;
              fullContent += delta;

              // Send output_text.delta event
              const deltaEvent = {
                type: "response.output_text.delta",
                output_index: 0,
                content_index: 0,
                delta: delta,
              };

              streamWriter
                .write(`event: response.output_text.delta\ndata: ${JSON.stringify(deltaEvent)}\n\n`)
                .catch(() => {});
            } else if (isIdleEvent(event)) {
              clearTimeout(timeout);

              const outputTokens = Math.ceil(fullContent.length / 4);

              // Send output_text.done event
              const textDoneEvent = {
                type: "response.output_text.done",
                output_index: 0,
                content_index: 0,
                text: fullContent,
              };
              streamWriter
                .write(`event: response.output_text.done\ndata: ${JSON.stringify(textDoneEvent)}\n\n`)
                .then(() => {
                  // Send content_part.done event
                  const contentPartDoneEvent = {
                    type: "response.content_part.done",
                    output_index: 0,
                    content_index: 0,
                    part: {
                      type: "output_text",
                      text: fullContent,
                      annotations: [],
                    },
                  };
                  return streamWriter.write(`event: response.content_part.done\ndata: ${JSON.stringify(contentPartDoneEvent)}\n\n`);
                })
                .then(() => {
                  // Send output_item.done event
                  const outputItemDoneEvent = {
                    type: "response.output_item.done",
                    output_index: 0,
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
                  };
                  return streamWriter.write(`event: response.output_item.done\ndata: ${JSON.stringify(outputItemDoneEvent)}\n\n`);
                })
                .then(() => {
                  // Send response.completed event
                  const completedEvent = {
                    type: "response.completed",
                    response: {
                      id: responseId,
                      object: "response",
                      created_at: createdAt,
                      status: "completed",
                      completed_at: Math.floor(Date.now() / 1000),
                      model: body.model,
                      output: [
                        {
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
                      ],
                      usage: {
                        input_tokens: inputTokens,
                        input_tokens_details: { cached_tokens: 0 },
                        output_tokens: outputTokens,
                        output_tokens_details: { reasoning_tokens: 0 },
                        total_tokens: inputTokens + outputTokens,
                      },
                    },
                  };
                  return streamWriter.write(`event: response.completed\ndata: ${JSON.stringify(completedEvent)}\n\n`);
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
            type: "response.failed",
            response: {
              id: responseId,
              object: "response",
              created_at: createdAt,
              status: "failed",
              error: { type: "api_error", message: errorMessage },
            },
          };
          await streamWriter.write(`event: response.failed\ndata: ${JSON.stringify(errorEvent)}\n\n`);
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
      const completedAt = Math.floor(Date.now() / 1000);

      const response: ResponsesCreateResponse = {
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
        output: [
          {
            type: "message",
            id: messageId,
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: content,
                annotations: [],
              },
            ],
          },
        ],
        parallel_tool_calls: true,
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
        tool_choice: "auto",
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

      return c.json(response);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Internal server error";
    return c.json(createErrorResponse(errorMessage, "api_error"), 500);
  }
});

/**
 * GET /v1/responses/:response_id - Get a model response
 * Note: This is a stub since we don't persist responses
 */
responses.get("/:response_id", (c) => {
  const responseId = c.req.param("response_id");
  return c.json(
    createErrorResponse(
      `Response ${responseId} not found. This router does not persist responses.`,
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
