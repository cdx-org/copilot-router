/**
 * OpenAI API compatible type definitions
 */

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  stop?: string | string[];
  max_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
  tools?: OpenAITool[];
  tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string } };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: Usage;
  system_fingerprint?: string;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  logprobs: null;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// Streaming types
export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  system_fingerprint?: string;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: Partial<ChatMessage>;
  logprobs: null;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

// Models endpoint types
export interface ModelsResponse {
  object: "list";
  data: Model[];
}

export interface Model {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

// Error types
export interface OpenAIError {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}
