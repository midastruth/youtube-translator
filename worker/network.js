export class NetworkError extends Error {
  constructor(message, { statusCode, retryAfter, retryable = true, errorType = "network" } = {}) {
    super(message);
    this.name = "NetworkError";
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
    this.retryable = retryable;
    this.errorType = errorType;
  }
}

export class BudgetExceededError extends Error {
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
 * @returns {Promise<any>}
 */
export async function executeWithRetryAndBudget(
  requestFn,
  {
    maxAttempts = 3,
    budgetTracker = null,
    sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onAttempt = null,
  } = {}
) {
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
        budgetTracker.recordSuccess(result?.usage);
      }
      return result;
    } catch (err) {
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

  recordSuccess(usage = {}) {
    if (usage) {
      this.knownTokens += (usage.promptTokens || 0) + (usage.completionTokens || 0);
      this.knownCost += usage.cost || 0;
    }
  }

  recordError(err, wasInterrupted = false) {
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
