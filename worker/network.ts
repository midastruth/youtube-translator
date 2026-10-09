import { RequestBudgetTracker } from "./request-budget.js";
export { RequestBudgetTracker, BudgetExceededError } from "./request-budget.js";
export type { Usage } from "./request-budget.js";

export type RequestFailure = Error & { statusCode?: number; status?: number; retryAfter?: string; response?: { status?: number; headers?: Record<string, string> } };
export function requestFailure(value: unknown): RequestFailure {
  if (value instanceof Error) return value;
  const error: RequestFailure = new Error(String(value));
  if (!value || typeof value !== "object") return error;
  if ("message" in value && typeof value.message === "string") error.message = value.message;
  copyFailureMetadata(error, value);
  return error;
}

function copyFailureMetadata(error: RequestFailure, value: object) {
  if ("statusCode" in value && typeof value.statusCode === "number") error.statusCode = value.statusCode;
  if ("status" in value && typeof value.status === "number") error.status = value.status;
  copyRetryAfter(error, value);
  if ("response" in value && value.response && typeof value.response === "object") error.response = responseMetadata(value.response);
}

function copyRetryAfter(error: RequestFailure, value: object) {
  if ("retryAfter" in value && (typeof value.retryAfter === "string" || typeof value.retryAfter === "number")) error.retryAfter = String(value.retryAfter);
}

function responseMetadata(response: object): NonNullable<RequestFailure["response"]> {
  const metadata: NonNullable<RequestFailure["response"]> = {};
  if ("status" in response && typeof response.status === "number") metadata.status = response.status;
  if ("headers" in response && response.headers && typeof response.headers === "object") {
    metadata.headers = Object.fromEntries(Object.entries(response.headers)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  }
  return metadata;
}

export class NetworkError extends Error {
  statusCode?: number;
  retryAfter?: string;
  retryable: boolean;
  errorType: string;
  constructor(message: string, { statusCode, retryAfter, retryable = true, errorType = "network" }: { statusCode?: number; retryAfter?: string; retryable?: boolean; errorType?: string } = {}) {
    super(message);
    this.name = "NetworkError";
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
    this.retryable = retryable;
    this.errorType = errorType;
  }
}

function statusOf(error: RequestFailure) {
  return error.statusCode || error.status || error.response?.status;
}

function nonRetryableError(error: RequestFailure): NetworkError | null {
  const statusCode = statusOf(error);
  if (statusCode === 401 || statusCode === 403) {
    return new NetworkError(`Authentication or permission error (${statusCode}): ${error.message}`, {
      statusCode, retryable: false, errorType: "auth_error",
    });
  }
  if (statusCode === 400 || error.message?.includes("unsupported model") ||
      error.message?.includes("Invalid model") || error.message?.includes("invalid parameter")) {
    return new NetworkError(`Configuration error (${statusCode}): ${error.message}`, {
      statusCode, retryable: false, errorType: "config_error",
    });
  }
  return null;
}

function retryDelay(error: RequestFailure, attempt: number) {
  if (statusOf(error) !== 429) return Math.min(4000, 1000 * Math.pow(2, attempt - 1));
  const header = error.retryAfter || error.response?.headers?.["retry-after"];
  if (header) {
    const seconds = Number.parseFloat(header);
    if (!Number.isNaN(seconds)) return seconds * 1000;
  }
  return 1000;
}

/** Executes a logical model call with bounded retries and budget reservation. */
export async function executeWithRetryAndBudget<T>(
  requestFn: (attempt: number) => Promise<T>,
  {
    maxAttempts = 3,
    budgetTracker = null,
    sleepFn = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    onAttempt = null,
  }: { maxAttempts?: number; budgetTracker?: RequestBudgetTracker | null; sleepFn?: (ms: number) => Promise<void>; onAttempt?: ((attempt: number) => void) | null } = {}
): Promise<T> {
  let attempt = 0;
  while (attempt < maxAttempts) {
    budgetTracker?.checkAndReserve();
    attempt++;
    onAttempt?.(attempt);
    try {
      const result = await requestFn(attempt);
      if (budgetTracker) {
        const usage = result && typeof result === "object" && "usage" in result ? result.usage : undefined;
        budgetTracker.recordSuccess(usage);
      }
      return result;
    } catch (value) {
      const error = requestFailure(value);
      const terminal = nonRetryableError(error);
      if (terminal) {
        budgetTracker?.recordError(error, false);
        throw terminal;
      }
      if (attempt >= maxAttempts) {
        budgetTracker?.recordError(error, true);
        throw new NetworkError(`Request failed after max attempts (${maxAttempts}): ${error.message}`, {
          statusCode: statusOf(error), retryable: false,
        });
      }
      await sleepFn(retryDelay(error, attempt));
    }
  }
  throw new NetworkError(`Max attempts (${maxAttempts}) exceeded`);
}
