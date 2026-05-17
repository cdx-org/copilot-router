/**
 * Anthropic API compatible type definitions
 */

export interface AnthropicMessageRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string | AnthropicContentBlock[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stream?: boolean;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?:
    | "auto"
    | "any"
    | "none"
    | { type: "auto" | "any" | "none"; disable_parallel_tool_use?: boolean }
    | { type: "tool"; name: string; disable_parallel_tool_use?: boolean };
  container?: string | null;
  service_tier?: "auto" | "standard_only";
  output_config?: Record<string, unknown>;
  cache_control?: Record<string, unknown> | null;
  metadata?: {
    user_id?: string;
  };
  thinking?: {
    type?: "enabled" | "disabled" | "adaptive";
    budget_tokens?: number;
    [key: string]: unknown;
  };
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
  type:
    | "text"
    | "image"
    | "tool_use"
    | "tool_result"
    | "thinking"
    | "redacted_thinking"
    | string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[] | unknown;
  is_error?: boolean;
  // Additional fields for other content types
  [key: string]: unknown;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  type?: string | null;
  [key: string]: unknown;
}

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: AnthropicStopReason | null;
  stop_sequence: string | null;
  container?: unknown | null;
  stop_details?: unknown | null;
  usage: AnthropicUsage;
}

export type AnthropicStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "pause_turn"
  | "refusal";

export interface AnthropicUsage {
  cache_creation?: unknown | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  inference_geo?: string | null;
  input_tokens: number;
  output_tokens: number;
  server_tool_use?: {
    web_fetch_requests: number;
    web_search_requests: number;
  } | null;
  service_tier?: "standard" | "priority" | "batch" | null;
}

// Streaming types
export interface AnthropicStreamEvent {
  type: string;
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
    stop_reason?: AnthropicStopReason | null;
    stop_sequence?: string | null;
    container?: unknown | null;
    stop_details?: unknown | null;
  };
  content_block?: AnthropicContentBlock;
  message?: Partial<AnthropicMessageResponse>;
  usage?: Partial<AnthropicUsage>;
}

// Count tokens types
export interface AnthropicCountTokensRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  tools?: AnthropicTool[];
}

export interface AnthropicCountTokensResponse {
  input_tokens: number;
}

// Error types
export interface AnthropicError {
  type: "error";
  error: {
    type: string;
    message: string;
  };
}
