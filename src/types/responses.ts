/**
 * OpenAI Responses API type definitions
 */

export interface ResponsesCreateRequest {
  model: string;
  input: string | ResponseInputItem[];
  instructions?: string;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  store?: boolean;
  metadata?: Record<string, string>;
  previous_response_id?: string;
  tools?: ResponseTool[];
  tool_choice?: string | { type: string; function?: { name: string } };
}

export interface ResponseInputItem {
  type: "message";
  role: "user" | "assistant" | "system";
  content: string | ResponseContentBlock[];
}

export interface ResponseContentBlock {
  type: "input_text" | "output_text" | "text";
  text: string;
  annotations?: unknown[];
}

export interface ResponseTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ResponsesCreateResponse {
  id: string;
  object: "response";
  created_at: number;
  status: "completed" | "failed" | "in_progress" | "cancelled" | "queued" | "incomplete";
  completed_at: number | null;
  error: ResponseError | null;
  incomplete_details: unknown | null;
  instructions: string | null;
  max_output_tokens: number | null;
  model: string;
  output: ResponseOutputItem[];
  parallel_tool_calls: boolean;
  previous_response_id: string | null;
  reasoning: {
    effort: string | null;
    summary: string | null;
  };
  store: boolean;
  temperature: number;
  text: {
    format: {
      type: string;
    };
  };
  tool_choice: string;
  tools: ResponseTool[];
  top_p: number;
  truncation: string;
  usage: ResponseUsage;
  user: string | null;
  metadata: Record<string, string>;
}

export interface ResponseOutputItem {
  type: "message";
  id: string;
  status: "completed" | "in_progress";
  role: "assistant";
  content: ResponseContentBlock[];
}

export interface ResponseUsage {
  input_tokens: number;
  input_tokens_details: {
    cached_tokens: number;
  };
  output_tokens: number;
  output_tokens_details: {
    reasoning_tokens: number;
  };
  total_tokens: number;
}

export interface ResponseError {
  type: string;
  message: string;
}

// Streaming event types
export interface ResponseStreamEvent {
  type: string;
  response?: Partial<ResponsesCreateResponse>;
  item?: ResponseOutputItem;
  content_index?: number;
  output_index?: number;
  delta?: string;
}
