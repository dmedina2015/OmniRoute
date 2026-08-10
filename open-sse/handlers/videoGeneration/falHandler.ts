import { saveCallLog } from "@/lib/usageDb";
import {
  FetchTimeoutError,
  fetchWithTimeout,
  getConfiguredTimeout,
} from "@/shared/utils/fetchTimeout";
import { sanitizeErrorMessage } from "../../utils/error.ts";

interface FalVideoBody {
  prompt?: unknown;
  aspect_ratio?: unknown;
  duration?: unknown;
  resolution?: unknown;
  quality?: unknown;
  generate_audio?: unknown;
  poll_interval_ms?: unknown;
  [key: string]: unknown;
}

interface FalCredentials {
  apiKey?: unknown;
  accessToken?: unknown;
}

interface FalProviderConfig {
  baseUrl: string;
}

interface FalLog {
  info?: (scope: string, message: string, meta?: unknown) => void;
  error?: (scope: string, message: string) => void;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function grokDuration(value: unknown, fallback = 6): number {
  const numeric = numberValue(value);
  if (numeric !== undefined) return Math.round(numeric);

  if (typeof value === "string") {
    const match = value.trim().match(/^(\d+)s$/);
    if (match) return Number(match[1]);
  }

  return fallback;
}

function falDuration(value: unknown, fallback = "8s"): string {
  if (typeof value === "string" && /^(4|6|8)s$/.test(value)) return value;

  const numeric = numberValue(value);
  return numeric && [4, 6, 8].includes(numeric) ? `${numeric}s` : fallback;
}

export function buildFalVideoPayload(model: string, body: FalVideoBody): Record<string, unknown> {
  const prompt = stringValue(body.prompt) || "";
  const aspectRatio = stringValue(body.aspect_ratio) || "16:9";
  const resolution = stringValue(body.resolution) || (body.quality === "hd" ? "1080p" : "720p");

  if (model.startsWith("xai/grok-imagine-video/")) {
    return {
      prompt,
      aspect_ratio: aspectRatio,
      duration: grokDuration(body.duration),
      resolution,
    };
  }

  return {
    prompt,
    aspect_ratio: aspectRatio,
    duration: falDuration(body.duration),
    resolution,
    generate_audio: typeof body.generate_audio === "boolean" ? body.generate_audio : true,
  };
}

function absoluteFalUrl(value: unknown, baseUrl: string): string | undefined {
  const url = stringValue(value);
  if (!url) return undefined;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `${baseUrl.replace(/\/$/, "")}/${url.replace(/^\//, "")}`;
}

function normalizeFalVideoResponse(payload: unknown) {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const video =
    record.video && typeof record.video === "object"
      ? (record.video as Record<string, unknown>)
      : null;
  const url = video && typeof video.url === "string" ? video.url.trim() : "";

  if (!url) {
    return {
      success: false as const,
      status: 502,
      error: "Fal video generation returned no video URL",
    };
  }

  return {
    success: true as const,
    data: {
      created: typeof record.created === "number" ? record.created : Math.floor(Date.now() / 1000),
      data: [{ url, format: "mp4" }],
    },
  };
}

function falModelPath(model: string): string {
  return model.startsWith("xai/") ? model : `fal-ai/${model}`;
}

function getToken(credentials: FalCredentials | null | undefined): string {
  return String(credentials?.apiKey || credentials?.accessToken || "");
}

function responseError(payload: unknown): string {
  return sanitizeErrorMessage(JSON.stringify(payload).slice(0, 500));
}

export async function handleFalVideoGeneration({
  model,
  provider,
  providerConfig,
  body,
  credentials,
  log,
}: {
  model: string;
  provider: string;
  providerConfig: FalProviderConfig;
  body: FalVideoBody;
  credentials: FalCredentials | null | undefined;
  log?: FalLog | null;
}) {
  const token = getToken(credentials);
  if (!token) return { success: false as const, status: 401, error: "Fal API key is required" };

  const startTime = Date.now();
  const timeoutMs = getConfiguredTimeout();
  const pollIntervalMs = Math.max(100, numberValue(body.poll_interval_ms) || 1000);
  const baseUrl = providerConfig.baseUrl.replace(/\/$/, "");
  const queueUrl = `${baseUrl}/${falModelPath(model)}`;
  const headers = {
    Authorization: `Key ${token}`,
    "Content-Type": "application/json",
  };

  log?.info?.("VIDEO", `${provider}/${model} (fal-ai-video)`, {
    prompt: stringValue(body.prompt)?.slice(0, 200) || "",
  });

  try {
    const createResponse = await fetchWithTimeout(queueUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(buildFalVideoPayload(model, body)),
      timeoutMs,
    });
    const createPayload = await createResponse.json().catch(() => ({}));

    if (!createResponse.ok) {
      const error = responseError(createPayload);
      log?.error?.("VIDEO", `Fal create failed (${createResponse.status}): ${error}`);
      return { success: false as const, status: createResponse.status, error };
    }

    const requestId = stringValue(createPayload.request_id);
    if (!requestId) return normalizeFalVideoResponse(createPayload);

    const statusUrl =
      absoluteFalUrl(createPayload.status_url, baseUrl) ||
      `${queueUrl}/requests/${requestId}/status`;
    const responseUrl =
      absoluteFalUrl(createPayload.response_url, baseUrl) || `${queueUrl}/requests/${requestId}`;
    const deadline = startTime + timeoutMs;

    while (Date.now() < deadline) {
      const remainingMs = Math.max(1000, deadline - Date.now());
      const statusResponse = await fetchWithTimeout(statusUrl, {
        headers: { Authorization: `Key ${token}` },
        timeoutMs: Math.min(timeoutMs, remainingMs),
      });
      const statusPayload = await statusResponse.json().catch(() => ({}));

      if (!statusResponse.ok) {
        return {
          success: false as const,
          status: statusResponse.status,
          error: responseError(statusPayload),
        };
      }

      const status = stringValue(statusPayload.status);
      if (status === "COMPLETED") {
        const resultResponse = await fetchWithTimeout(responseUrl, {
          headers: { Authorization: `Key ${token}` },
          timeoutMs: Math.min(timeoutMs, Math.max(1000, deadline - Date.now())),
        });
        const resultPayload = await resultResponse.json().catch(() => ({}));
        if (!resultResponse.ok) {
          return {
            success: false as const,
            status: resultResponse.status,
            error: responseError(resultPayload),
          };
        }

        const result = normalizeFalVideoResponse(resultPayload);
        saveCallLog({
          method: "POST",
          path: "/v1/videos/generations",
          status: result.success ? 200 : result.status,
          model: `${provider}/${model}`,
          provider,
          duration: Date.now() - startTime,
          ...(result.success ? {} : { error: result.error }),
        }).catch(() => {});
        return result;
      }

      if (status && !["IN_QUEUE", "IN_PROGRESS"].includes(status)) {
        return {
          success: false as const,
          status: 502,
          error: `Fal video generation ended with status ${status}`,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)));
    }

    return {
      success: false as const,
      status: 504,
      error: `Fal video generation timed out after ${timeoutMs}ms`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout =
      error instanceof FetchTimeoutError || (error as { name?: string }).name === "AbortError";
    const status = isTimeout ? 504 : 502;
    const safeMessage = sanitizeErrorMessage(message);
    log?.error?.("VIDEO", `Fal request failed: ${safeMessage}`);
    return { success: false as const, status, error: `Fal video provider error: ${safeMessage}` };
  }
}
