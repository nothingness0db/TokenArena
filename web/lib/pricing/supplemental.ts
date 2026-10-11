import type { PricingCost } from "./catalog";

export type SupplementalPricingSource =
  | "supplemental"
  | "reference"
  | "historical"
  | "subscription";

type SupplementalPricingModel = {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  cost: PricingCost;
  pricingSource: SupplementalPricingSource;
  preferSupplemental?: boolean;
};

// Reviewed USD rates per million tokens, supplied on 2026-10-11. Keep
// reference/discount/subscription estimates distinguishable from catalog rates.
export const SUPPLEMENTAL_PRICING: Record<string, SupplementalPricingModel> = {
  "mimo-v2-pro": {
    providerId: "xiaomi",
    providerName: "Xiaomi",
    modelId: "mimo-v2-pro",
    modelName: "MiMo V2 Pro",
    cost: {
      input: 0.435,
      cache_read: 0.0036,
      output: 0.87,
    },
    pricingSource: "supplemental",
  },
  "mimo-v2.5-pro": {
    providerId: "xiaomi",
    providerName: "Xiaomi",
    modelId: "mimo-v2.5-pro",
    modelName: "MiMo V2.5 Pro",
    cost: {
      input: 0.435,
      cache_read: 0.0036,
      output: 0.87,
    },
    pricingSource: "supplemental",
  },
  "mimo-v2.5": {
    providerId: "xiaomi",
    providerName: "Xiaomi",
    modelId: "mimo-v2.5",
    modelName: "MiMo V2.5",
    cost: {
      input: 0.14,
      cache_read: 0.0028,
      output: 0.28,
    },
    pricingSource: "supplemental",
  },
  "claude-opus-4-8": {
    providerId: "anthropic",
    providerName: "Anthropic",
    modelId: "claude-opus-4-8",
    modelName: "Claude Opus 4.8",
    cost: {
      input: 5,
      cache_read: 0.5,
      output: 25,
    },
    pricingSource: "supplemental",
  },
  "claude-opus-4-7": {
    providerId: "anthropic",
    providerName: "Anthropic",
    modelId: "claude-opus-4-7",
    modelName: "Claude Opus 4.7",
    cost: {
      input: 5,
      cache_read: 0.5,
      output: 25,
    },
    pricingSource: "supplemental",
  },
  "claude-sonnet-4-20250514": {
    providerId: "anthropic",
    providerName: "Anthropic",
    modelId: "claude-sonnet-4-20250514",
    modelName: "Claude Sonnet 4",
    cost: {
      input: 3,
      cache_read: 0.3,
      output: 15,
    },
    pricingSource: "historical",
  },
  "deepseek-v4.1-flash": {
    providerId: "deepseek",
    providerName: "DeepSeek",
    modelId: "deepseek-v4.1-flash",
    modelName: "DeepSeek V4.1 Flash",
    cost: {
      input: 0.15,
      cache_read: 0.003,
      output: 0.6,
    },
    pricingSource: "reference",
    preferSupplemental: true,
  },
  "deepseek-v4-flash-fast": {
    providerId: "deepseek",
    providerName: "DeepSeek",
    modelId: "deepseek-v4-flash-fast",
    modelName: "DeepSeek V4 Flash Fast",
    cost: {
      input: 0.3,
      cache_read: 0.006,
      output: 1.2,
    },
    pricingSource: "reference",
    preferSupplemental: true,
  },
  "deepseek-v4.1-flash-fast": {
    providerId: "deepseek",
    providerName: "DeepSeek",
    modelId: "deepseek-v4.1-flash-fast",
    modelName: "DeepSeek V4.1 Flash Fast",
    cost: {
      input: 0.3,
      cache_read: 0.006,
      output: 1.2,
    },
    pricingSource: "reference",
    preferSupplemental: true,
  },
  "longcat-2.0": {
    providerId: "longcat",
    providerName: "LongCat",
    modelId: "LongCat-2.0",
    modelName: "LongCat 2.0",
    cost: {
      input: 0.3,
      cache_read: 0.006,
      output: 1.2,
    },
    pricingSource: "reference",
    preferSupplemental: true,
  },
  "kimi-for-coding": {
    providerId: "moonshotai",
    providerName: "Moonshot AI",
    modelId: "kimi-for-coding",
    modelName: "Kimi for Coding",
    cost: {
      input: 0.95,
      cache_read: 0.19,
      output: 4,
    },
    pricingSource: "subscription",
    preferSupplemental: true,
  },
};

// Only confirmed aliases: do not rewrite arbitrary versions or fast variants.
export const PRICING_MODEL_ALIASES: Record<string, string> = {
  "claude-opus-4.8": "claude-opus-4-8",
  "claude-opus-4.7": "claude-opus-4-7",
  "claude-sonnet-4": "claude-sonnet-4-20250514",
};

// These OpenCode models are free despite lacking a "free" suffix.
export const FREE_MODEL_IDS = new Set(["big-pickle", "grok-code"]);
