import { DocumentPermanentError } from "./document-translation.js";

export const DEFAULT_TOKEN_BUDGET = 20_000_000;

export function documentTokenBudget(requested?: number, fallback = DEFAULT_TOKEN_BUDGET): number {
  const configured = process.env.TRANSLATION_TOKEN_BUDGET?.trim();
  const budget = requested ?? (configured ? Number(configured) : fallback);
  if (!Number.isSafeInteger(budget) || budget < 0) {
    throw new Error("翻译 Token 预算必须是非负安全整数，0 表示关闭限制（TRANSLATION_TOKEN_BUDGET）");
  }
  return budget;
}

export function checkTokenBudget(limit: number | undefined, used: number) {
  if (limit && used >= limit) {
    throw new DocumentPermanentError("budget", `翻译 Token 预算已耗尽（本轮已用 ${used}，上限 ${limit}，主/子 Agent 共享）；草稿已保留，请重新开启翻译以重置 Token 预算并续翻`);
  }
}
