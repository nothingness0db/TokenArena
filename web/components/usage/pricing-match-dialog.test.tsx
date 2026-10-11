import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PricingMatchDialog } from "./pricing-match-dialog";

vi.mock("next-intl", () => ({
  useTranslations:
    (namespace: string) =>
    (key: string): string => {
      if (namespace !== "usage.pricing") {
        return key;
      }

      return (
        {
          open: "Model prices",
          title: "Model Price Matches",
          description:
            "Review the model matches and unit prices used for estimated cost.",
          "table.rawModel": "Model",
          "table.officialMatch": "Match",
          "table.input": "Input",
          "table.output": "Output",
          "table.reasoning": "Reasoning",
          "table.cache": "Cache",
          "table.unmatched": "No official match",
          "sources.reference": "Reference estimate",
          "sources.subscription": "Subscription · reference estimate",
        }[key] ?? key
      );
    },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, ...props }: React.ComponentProps<"span">) => (
    <span data-slot="badge" {...props}>
      {children}
    </span>
  ),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

describe("PricingMatchDialog", () => {
  it("distinguishes reference estimates and unmatched models with a known provider", () => {
    const row = {
      rawModel: "deepseek/deepseek-v4.1-flash",
      pricingProviderId: "deepseek",
      pricingProviderName: "DeepSeek",
      matchedModelId: "deepseek-v4.1-flash",
      matchedModelName: "DeepSeek V4.1 Flash",
      inputRateUsdPerMillion: 0.15,
      outputRateUsdPerMillion: 0.6,
      reasoningRateUsdPerMillion: null,
      cacheRateUsdPerMillion: 0.003,
      totalTokens: 1000,
      inputTokens: 400,
      outputTokens: 300,
      reasoningTokens: 200,
      cachedTokens: 100,
      estimatedCostUsd: 0.0003603,
      estimatedInputUsd: 0.00006,
      estimatedOutputUsd: 0.00018,
      estimatedReasoningUsd: 0.00012,
      estimatedCacheUsd: 0.0000003,
    };
    const markup = renderToStaticMarkup(
      <PricingMatchDialog
        rows={[
          { ...row, pricingSource: "reference" },
          {
            ...row,
            rawModel: "kimi-for-coding",
            pricingSource: "subscription",
          },
          {
            ...row,
            rawModel: "gpt-reserve",
            matchedModelId: null,
            matchedModelName: null,
          },
        ]}
      />,
    );
    expect(markup).toContain("Reference estimate");
    expect(markup).toContain("Subscription · reference estimate");
    expect(markup).toContain("No official match");
  });

  it("renders the trigger and model price mapping rows", () => {
    const markup = renderToStaticMarkup(
      <PricingMatchDialog
        rows={[
          {
            rawModel: "glm-5",
            pricingProviderId: "zai",
            pricingProviderName: "Z.AI",
            matchedModelId: "glm-5",
            matchedModelName: "GLM-5",
            inputRateUsdPerMillion: 1,
            outputRateUsdPerMillion: 3.2,
            reasoningRateUsdPerMillion: null,
            cacheRateUsdPerMillion: 0.2,
            totalTokens: 1000,
            inputTokens: 400,
            outputTokens: 300,
            reasoningTokens: 200,
            cachedTokens: 100,
            estimatedCostUsd: 1.23,
            estimatedInputUsd: 0.4,
            estimatedOutputUsd: 0.6,
            estimatedReasoningUsd: 0.2,
            estimatedCacheUsd: 0.03,
          },
          {
            rawModel: "custom-model",
            pricingProviderId: null,
            pricingProviderName: null,
            matchedModelId: null,
            matchedModelName: null,
            inputRateUsdPerMillion: null,
            outputRateUsdPerMillion: null,
            reasoningRateUsdPerMillion: null,
            cacheRateUsdPerMillion: null,
            totalTokens: 100,
            inputTokens: 40,
            outputTokens: 30,
            reasoningTokens: 20,
            cachedTokens: 10,
            estimatedCostUsd: null,
            estimatedInputUsd: null,
            estimatedOutputUsd: null,
            estimatedReasoningUsd: null,
            estimatedCacheUsd: null,
          },
        ]}
      />,
    );

    expect(markup).toContain("Model prices");
    expect(markup).toContain("Model Price Matches");
    expect(markup).toContain("glm-5");
    expect(markup).toContain("Z.AI");
    expect(markup).toContain('data-slot="badge"');
    expect(markup).toContain("$1/M");
    expect(markup).toContain("$3.2/M");
    expect(markup).toContain("$0.2/M");
    expect(markup).toContain("custom-model");
    expect(markup).toContain("No official match");
    expect(markup).not.toContain("GLM-5");
    expect(markup).toContain("—");
  });
});
