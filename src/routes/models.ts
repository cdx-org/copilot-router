/**
 * OpenAI-compatible /v1/models endpoint
 */

import { Hono } from "hono";
import type { ModelsResponse, Model } from "../types/openai.js";
import {
  listAvailableModels,
  normalizeCopilotModelId,
  type ModelInfo,
} from "../copilot/client.js";

const models = new Hono();

// Cache for models list
let modelsCache: ModelInfo[] | null = null;
let modelsCacheTime = 0;
const CACHE_TTL_MS = 60000; // 1 minute

async function getCachedModels(): Promise<ModelInfo[]> {
  const now = Date.now();
  if (modelsCache && now - modelsCacheTime < CACHE_TTL_MS) {
    return modelsCache;
  }

  modelsCache = await listAvailableModels();
  modelsCacheTime = now;
  return modelsCache;
}

/**
 * GET /v1/models - List available models
 */
models.get("/", async (c) => {
  try {
    const copilotModels = await getCachedModels();
    const createdAt = Math.floor(Date.now() / 1000);

    const modelList: Model[] = copilotModels.map((m) => ({
      id: m.id,
      object: "model" as const,
      created: createdAt,
      owned_by: "github-copilot",
    }));

    const response: ModelsResponse = {
      object: "list",
      data: modelList,
    };

    return c.json(response);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to list models";
    return c.json(
      {
        error: {
          message: errorMessage,
          type: "api_error",
          param: null,
          code: null,
        },
      },
      500,
    );
  }
});

/**
 * GET /v1/models/:model - Get a specific model
 */
models.get("/:model", async (c) => {
  const modelId = c.req.param("model");
  const normalizedModelId = normalizeCopilotModelId(modelId);

  try {
    const copilotModels = await getCachedModels();
    const createdAt = Math.floor(Date.now() / 1000);

    const foundModel = copilotModels.find((m) => m.id === normalizedModelId);

    if (!foundModel) {
      return c.json(
        {
          error: {
            message: `The model '${modelId}' does not exist`,
            type: "invalid_request_error",
            param: "model",
            code: "model_not_found",
          },
        },
        404,
      );
    }

    const model: Model = {
      id: foundModel.id,
      object: "model",
      created: createdAt,
      owned_by: "github-copilot",
    };

    return c.json(model);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to get model";
    return c.json(
      {
        error: {
          message: errorMessage,
          type: "api_error",
          param: null,
          code: null,
        },
      },
      500,
    );
  }
});

export default models;
