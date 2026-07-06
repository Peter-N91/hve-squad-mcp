/**
 * Azure OpenAI `ModelBackend` (the single Phase 1 backend).
 *
 * Calls the Azure OpenAI Chat Completions REST API with `fetch` and a bearer
 * token from an INJECTED token provider — so the backend has no Azure SDK
 * dependency and is unit-testable with a stub `fetch`. Security posture:
 *
 *   * SEC-3 — the endpoint and deployment come from operator config (validated
 *     against an allow-list in `operator-config.ts`); they are NEVER taken from a
 *     caller input, so a caller cannot redirect inference elsewhere.
 *   * SEC-10 — the access token (and an API key, if that token provider is used)
 *     is registered with the logger for redaction and never logged. Error paths
 *     do not include the response body, which could echo a prompt or secret.
 *
 * The managed-identity token provider lives in a separate module so `@azure/identity`
 * loads only in the live process (`managed-identity-credential.ts`).
 */
import type { BackendRequest, BackendResult, ModelBackend } from "../model-backend.js";
import type { RedactingLogger } from "../../observability/logger.js";

/** Per-million-token pricing used for the best-effort cost estimate (COST-2). */
export interface ModelPricing {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
}

export interface AzureOpenAIBackendOptions {
  /** AOAI resource endpoint, e.g. `https://my-aoai.openai.azure.com` (operator config). */
  endpoint: string;
  /** Deployment name (operator config). */
  deployment: string;
  /** REST API version. */
  apiVersion: string;
  /** Returns a fresh bearer token (managed identity or Key Vault key). */
  getAccessToken: () => Promise<string>;
  /** Injectable fetch (default: global fetch). */
  fetchImpl?: typeof fetch;
  /** Logger to register the token as a secret (SEC-10). */
  logger?: RedactingLogger;
  /** Optional pricing for the cost estimate. */
  pricing?: ModelPricing;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function estimateCostUsd(
  promptTokens: number | undefined,
  completionTokens: number | undefined,
  pricing: ModelPricing | undefined,
): number | undefined {
  if (!pricing) {
    return undefined;
  }
  const input = ((promptTokens ?? 0) / 1_000_000) * pricing.inputPerMTokUsd;
  const output = ((completionTokens ?? 0) / 1_000_000) * pricing.outputPerMTokUsd;
  return input + output;
}

export class AzureOpenAIBackend implements ModelBackend {
  readonly id = "azure-openai";
  private readonly endpoint: string;
  private readonly deployment: string;
  private readonly apiVersion: string;
  private readonly getAccessToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: RedactingLogger;
  private readonly pricing?: ModelPricing;

  constructor(options: AzureOpenAIBackendOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.deployment = options.deployment;
    this.apiVersion = options.apiVersion;
    this.getAccessToken = options.getAccessToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    this.pricing = options.pricing;
  }

  async complete(request: BackendRequest): Promise<BackendResult> {
    const token = await this.getAccessToken();
    this.logger?.registerSecret(token);

    const url =
      `${this.endpoint}/openai/deployments/${encodeURIComponent(this.deployment)}` +
      `/chat/completions?api-version=${encodeURIComponent(this.apiVersion)}`;

    const body = {
      messages: [
        { role: "system", content: request.system },
        ...request.messages.map((message) => ({ role: message.role, content: message.content })),
      ],
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxOutputTokens ?? 1500,
    };

    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      // Never include the response body — it can echo the prompt or a secret.
      throw new Error(`Azure OpenAI request failed with status ${response.status}.`);
    }

    const json = (await response.json()) as ChatCompletionResponse;
    const choice = json.choices?.[0];
    const text = choice?.message?.content ?? "";
    const finishReason = choice?.finish_reason ?? "stop";
    const promptTokens = json.usage?.prompt_tokens;
    const completionTokens = json.usage?.completion_tokens;

    return {
      text,
      finishReason,
      usage: {
        inputTokens: promptTokens,
        outputTokens: completionTokens,
        estimatedCostUsd: estimateCostUsd(promptTokens, completionTokens, this.pricing),
      },
      backendId: this.id,
    };
  }
}
