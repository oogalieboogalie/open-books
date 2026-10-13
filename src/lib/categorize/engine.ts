import { getCategory } from "../categories";
import { KEYWORD_RULES } from "./keywords";
import { containsWords, normalizeDescription } from "./normalize";

export interface TransactionInput {
  description: string;
  /** Integer cents. Positive is money in, negative is money out. */
  amountCents: number;
}

export interface Suggestion {
  categoryId: string;
  /** 0 to 1. Below REVIEW_THRESHOLD the transaction is flagged for review. */
  confidence: number;
  source: "rule" | "keyword" | "fallback" | "ai";
  reason: string;
  ruleId?: number;
}

export type MatchType = "contains" | "starts_with" | "exact";

/** A rule the user created, usually by recategorizing a transaction. */
export interface UserRule {
  id: number;
  pattern: string;
  matchType: MatchType;
  direction: "any" | "in" | "out";
  categoryId: string;
}

/**
 * A step in the categorization chain. Returns null to pass to the next step.
 * This is the extension point for smarter categorizers, such as an AI model
 * that sees the merchant, amount, and the business's history.
 */
export interface Classifier {
  name: string;
  classify(tx: TransactionInput, normalized: string): Suggestion | null;
}

export const REVIEW_THRESHOLD = 0.7;

function directionOf(amountCents: number): "in" | "out" {
  return amountCents >= 0 ? "in" : "out";
}

export function ruleMatches(rule: Pick<UserRule, "pattern" | "matchType" | "direction">, normalized: string, amountCents: number): boolean {
  if (rule.direction !== "any" && rule.direction !== directionOf(amountCents)) return false;
  const pattern = normalizeDescription(rule.pattern);
  if (!pattern) return false;
  switch (rule.matchType) {
    case "exact":
      return normalized === pattern;
    case "starts_with":
      return normalized === pattern || normalized.startsWith(pattern + " ");
    case "contains":
      return containsWords(normalized, pattern);
  }
}

export function userRuleClassifier(rules: UserRule[]): Classifier {
  return {
    name: "user-rules",
    classify(tx, normalized) {
      let best: UserRule | null = null;
      for (const rule of rules) {
        if (!ruleMatches(rule, normalized, tx.amountCents)) continue;
        if (!best || rule.pattern.length > best.pattern.length) best = rule;
      }
      if (!best) return null;
      return {
        categoryId: best.categoryId,
        confidence: 0.99,
        source: "rule",
        reason: `Your rule: "${best.pattern}"`,
        ruleId: best.id,
      };
    },
  };
}

export const keywordClassifier: Classifier = {
  name: "keywords",
  classify(tx, normalized) {
    const dir = directionOf(tx.amountCents);
    let best: { category: string; confidence: number; keyword: string; directed: boolean } | null = null;
    for (const entry of KEYWORD_RULES) {
      if (entry.direction && entry.direction !== dir) continue;
      for (const keyword of entry.keywords) {
        if (!containsWords(normalized, keyword)) continue;
        const candidate = { category: entry.category, confidence: entry.confidence, keyword, directed: !!entry.direction };
        if (!best || isBetter(candidate, best)) best = candidate;
      }
    }
    if (!best) return null;

    const category = getCategory(best.category);
    const isRefund = dir === "in" && (category.kind === "expense" || category.kind === "cogs");
    return {
      categoryId: best.category,
      confidence: isRefund ? Math.min(best.confidence, 0.75) : best.confidence,
      source: "keyword",
      reason: isRefund ? `Refund or credit from "${best.keyword}"` : `Matched "${best.keyword}"`,
    };
  },
};

/** Longer keyword wins; then direction-specific entries; then confidence. */
function isBetter(
  a: { keyword: string; directed: boolean; confidence: number },
  b: { keyword: string; directed: boolean; confidence: number },
): boolean {
  if (a.keyword.length !== b.keyword.length) return a.keyword.length > b.keyword.length;
  if (a.directed !== b.directed) return a.directed;
  return a.confidence > b.confidence;
}

export const fallbackClassifier: Classifier = {
  name: "fallback",
  classify(tx) {
    if (tx.amountCents > 0) {
      return { categoryId: "gross_receipts", confidence: 0.4, source: "fallback", reason: "Deposit from an unrecognized source; confirm it is business income" };
    }
    return { categoryId: "uncategorized", confidence: 0, source: "fallback", reason: "No match" };
  },
};

export function categorize(tx: TransactionInput, classifiers: Classifier[]): Suggestion {
  const normalized = normalizeDescription(tx.description);
  for (const classifier of classifiers) {
    const suggestion = classifier.classify(tx, normalized);
    if (suggestion) return suggestion;
  }
  return fallbackClassifier.classify(tx, normalized)!;
}

/** The standard chain: the user's rules, then built-in knowledge, then fallback. */
export function defaultClassifiers(rules: UserRule[]): Classifier[] {
  return [userRuleClassifier(rules), keywordClassifier, fallbackClassifier];
}
