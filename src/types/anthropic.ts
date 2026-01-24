/**
 * Anthropic API compatible type definitions
 */

export interface AnthropicMessageRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stream?: boolean;
  stop_sequences?: string[];
  metadata?: {
    user_id?: string;
  };
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
  type: "text" | "image" | "tool_use" | "tool_result";
  text?: string;
  // Additional fields for other content types
  [key: string]: unknown;
}

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

// Streaming types
export interface AnthropicStreamEvent {
  type: string;
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    stop_reason?: string;
    stop_sequence?: string | null;
  };
  content_block?: AnthropicContentBlock;
  message?: Partial<AnthropicMessageResponse>;
  usage?: Partial<AnthropicUsage>;
}

// Count tokens types
export interface AnthropicCountTokensRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
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
