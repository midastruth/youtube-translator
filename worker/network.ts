export type Usage = { promptTokens?: number; completionTokens?: number; cost?: number };
export type RequestFailure = Error & { statusCode?: number; status?: number; retryAfter?: string; response?: { status?: number; headers?: Record<string, string> } };
export function requestFailure(value: unknown): RequestFailure {
  return value instanceof Error ? value : new Error(String(value));
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

export class BudgetExceededError extends Error {
  code: string;
  constructor(message = "Model request budget exceeded") {
    super(message);
    this.name = "BudgetExceededError";
    this.code = "budget_exceeded";
  }
}

/**
 * Executes a logical model call with bounded network retries and budget reservation.
 *
 * @param {Function} requestFn - async () => result
 * @param {Object} options - policy options
 * @returns {Promise<T>}
 */
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
    if (budgetTracker) {
      budgetTracker.checkAndReserve();
    }

    attempt++;
    if (onAttempt) onAttempt(attempt);

    try {
      const result = await requestFn(attempt);
      if (budgetTracker) {
        const usage = result && typeof result === "object" && "usage" in result ? result.usage : undefined;
        budgetTracker.recordSuccess(usage);
      }
      return result;
    } catch (value) {
      const err = requestFailure(value);
      const statusCode = err.statusCode || err.status || (err.response && err.response.status);
      const is401or403 = statusCode === 401 || statusCode === 403;
      const isConfigError =
        statusCode === 400 ||
        err.message?.includes("unsupported model") ||
        err.message?.includes("Invalid model") ||
        err.message?.includes("invalid parameter");

      // Non-retryable errors
      if (is401or403) {
        if (budgetTracker) budgetTracker.recordError(err, false);
        throw new NetworkError(`Authentication or permission error (${statusCode}): ${err.message}`, {
          statusCode,
          retryable: false,
          errorType: "auth_error",
        });
      }

      if (isConfigError) {
        if (budgetTracker) budgetTracker.recordError(err, false);
        throw new NetworkError(`Configuration error (${statusCode}): ${err.message}`, {
          statusCode,
          retryable: false,
          errorType: "config_error",
        });
      }

      // Check if max attempts reached
      if (attempt >= maxAttempts) {
        if (budgetTracker) budgetTracker.recordError(err, true);
        throw new NetworkError(
          `Request failed after max attempts (${maxAttempts}): ${err.message}`,
          { statusCode, retryable: false }
        );
      }

      // Rate limit 429
      if (statusCode === 429) {
        let retryAfterMs = 1000;
        const retryAfterHeader =
          err.retryAfter || (err.response && err.response.headers && err.response.headers["retry-after"]);
        if (retryAfterHeader) {
          const seconds = Number.parseFloat(retryAfterHeader);
          if (!Number.isNaN(seconds)) {
            retryAfterMs = seconds * 1000;
          }
        }
        await sleepFn(retryAfterMs);
        continue;
      }

      // 5xx or network timeout -> exponential backoff
      const backoffMs = Math.min(4000, 1000 * Math.pow(2, attempt - 1));
      await sleepFn(backoffMs);
    }
  }

  throw new NetworkError(`Max attempts (${maxAttempts}) exceeded`);
}

/**
 * Budget tracker to manage external request attempt limits.
 */
export class RequestBudgetTracker {
  maxBudget: number;
  attempts: number;
  knownTokens: number;
  knownCost: number;
  interruptedAttempts: number;
  constructor({ maxBudget = 12, currentAttempts = 0, knownTokens = 0, knownCost = 0, interruptedAttempts = 0 } = {}) {
    this.maxBudget = maxBudget;
    this.attempts = currentAttempts;
    this.knownTokens = knownTokens;
    this.knownCost = knownCost;
    this.interruptedAttempts = interruptedAttempts;
  }

  checkAndReserve() {
    if (this.attempts >= this.maxBudget) {
      throw new BudgetExceededError(
        `Budget limit reached: ${this.attempts}/${this.maxBudget} attempts issued`
      );
    }
    this.attempts++;
  }

  recordSuccess(usage: unknown = {}) {
    if (usage && typeof usage === "object") {
      const prompt = "promptTokens" in usage && typeof usage.promptTokens === "number" ? usage.promptTokens : 0;
      const completion = "completionTokens" in usage && typeof usage.completionTokens === "number" ? usage.completionTokens : 0;
      this.knownTokens += prompt + completion;
      this.knownCost += "cost" in usage && typeof usage.cost === "number" ? usage.cost : 0;
    }
  }

  recordError(err: unknown, wasInterrupted = false) {
    if (wasInterrupted) {
      this.interruptedAttempts++;
    }
  }

  getUsageReport() {
    return {
      totalAttempts: this.attempts,
      maxBudget: this.maxBudget,
      knownTokens: this.knownTokens,
      knownCost: this.knownCost,
      interruptedAttempts: this.interruptedAttempts,
      remainingAttempts: Math.max(0, this.maxBudget - this.attempts),
    };
  }
}
