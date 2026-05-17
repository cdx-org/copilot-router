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
  tool_choice?: string | {
    type: string;
    function?: { name: string };
    name?: string;
    server_label?: string;
  };
  parallel_tool_calls?: boolean;
}

export type ResponseInputItem =
  | ResponseMessageInputItem
  | ResponseFunctionCallInputItem
  | ResponseFunctionCallOutputInputItem
  | ResponseGenericInputItem;

export interface ResponseMessageInputItem {
  type: "message";
  role: "user" | "assistant" | "system" | "developer";
  content: string | ResponseContentBlock[];
}

export interface ResponseContentBlock {
  type: "input_text" | "output_text" | "text" | "input_image";
  text?: string;
  annotations?: unknown[];
  [key: string]: unknown;
}

export interface ResponseFunctionCallInputItem {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
  status?: "completed" | "in_progress" | "incomplete";
}

export interface ResponseFunctionCallOutputInputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export interface ResponseGenericInputItem {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  input?: string;
  output?: unknown;
  action?: unknown;
  operation?: unknown;
  environment?: unknown;
  server_label?: string;
  status?: string;
  [key: string]: unknown;
}

export type ResponseTool =
  | ResponseNestedFunctionTool
  | ResponseFlatFunctionTool
  | ResponseBuiltInTool;

export interface ResponseNestedFunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ResponseFlatFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ResponseBuiltInTool {
  type: string;
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
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
  output_text: string;
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
  tool_choice: ResponsesCreateRequest["tool_choice"];
  tools: ResponseTool[];
  top_p: number;
  truncation: string;
  usage: ResponseUsage;
  user: string | null;
  metadata: Record<string, string>;
}

export type ResponseOutputItem =
  | ResponseMessageOutputItem
  | ResponseFunctionCallOutputItem
  | ResponseCustomToolCallOutputItem
  | ResponseLocalShellCallOutputItem
  | ResponseShellCallOutputItem
  | ResponseApplyPatchCallOutputItem
  | ResponseMcpCallOutputItem;

export interface ResponseMessageOutputItem {
  type: "message";
  id: string;
  status: "completed" | "in_progress";
  role: "assistant";
  content: ResponseContentBlock[];
}

export interface ResponseFunctionCallOutputItem {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: "completed" | "in_progress" | "incomplete";
}

export interface ResponseCustomToolCallOutputItem {
  type: "custom_tool_call";
  id: string;
  call_id: string;
  name: string;
  input: string;
  namespace?: string;
  status: "completed" | "in_progress" | "incomplete";
}

export interface ResponseLocalShellAction {
  type: "exec";
  command: string[];
  env: Record<string, string>;
  timeout_ms?: number | null;
  user?: string | null;
  working_directory?: string | null;
}

export interface ResponseLocalShellCallOutputItem {
  type: "local_shell_call";
  id: string;
  call_id: string;
  action: ResponseLocalShellAction | Record<string, unknown>;
  status: "completed" | "in_progress" | "incomplete";
}

export interface ResponseShellAction {
  commands: string[];
  max_output_length: number | null;
  timeout_ms: number | null;
}

export interface ResponseShellCallOutputItem {
  type: "shell_call";
  id: string;
  call_id: string;
  action: ResponseShellAction | Record<string, unknown>;
  environment: Record<string, unknown> | null;
  status: "completed" | "in_progress" | "incomplete";
}

export type ResponseApplyPatchOperation =
  | { type: "create_file"; path: string; diff: string }
  | { type: "delete_file"; path: string }
  | { type: "update_file"; path: string; diff: string }
  | Record<string, unknown>;

export interface ResponseApplyPatchCallOutputItem {
  type: "apply_patch_call";
  id: string;
  call_id: string;
  operation: ResponseApplyPatchOperation;
  status: "completed" | "in_progress";
}

export interface ResponseMcpCallOutputItem {
  type: "mcp_call";
  id: string;
  call_id: string;
  name: string;
  server_label: string;
  arguments: string;
  output?: string | null;
  error?: string | null;
  status?: "completed" | "in_progress" | "incomplete" | "calling" | "failed";
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
  sequence_number?: number;
  response?: Partial<ResponsesCreateResponse>;
  item?: ResponseOutputItem;
  item_id?: string;
  content_index?: number;
  output_index?: number;
  delta?: string;
  arguments?: string;
  input?: string;
  name?: string;
  logprobs?: unknown[];
}
