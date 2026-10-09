export type Usage = { promptTokens?: number; completionTokens?: number; cost?: number };

export class BudgetExceededError extends Error {
  code: string;
  constructor(message = "Model request budget exceeded") {
    super(message);
    this.name = "BudgetExceededError";
    this.code = "budget_exceeded";
  }
}

/** Tracks external request attempts independently of the retry policy. */
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
    if (wasInterrupted) this.interruptedAttempts++;
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
