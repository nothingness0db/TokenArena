import { describe, expect, it } from "vitest";

import type { PricingCatalog } from "./catalog";
import {
  buildModelLookupCandidates,
  estimateCostUsd,
  resolveOfficialPricingMatch,
  resolveOfficialPricingProvider,
  resolveOfficialPricingProviderId,
} from "./resolve";

const catalog: PricingCatalog = new Map([
  [
    "minimax",
    {
      id: "minimax",
      name: "MiniMax",
      modelsByLower: new Map([
        [
          "minimax-m2.5",
          {
            id: "MiniMax-M2.5",
            name: "MiniMax M2.5",
            cost: {
              input: 0.3,
              output: 1.2,
              cache_read: 0.03,
            },
          },
        ],
      ]),
    },
  ],
  [
    "moonshotai",
    {
      id: "moonshotai",
      name: "Moonshot AI",
      modelsByLower: new Map([
        [
          "kimi-k2.5",
          {
            id: "kimi-k2.5",
            name: "Kimi K2.5",
            cost: {
              input: 0.6,
              output: 3,
              cache_read: 0.1,
            },
          },
        ],
      ]),
    },
  ],
  [
    "alibaba",
    {
      id: "alibaba",
      name: "Alibaba",
      modelsByLower: new Map([
        [
          "qwen-plus",
          {
            id: "qwen-plus",
            name: "Qwen Plus",
            cost: {
              input: 0.4,
              output: 1.2,
              reasoning: 4,
            },
          },
        ],
      ]),
    },
  ],
]);

describe("resolveOfficialPricingProviderId", () => {
  it("normalizes model casing before resolving the official provider", () => {
    expect(resolveOfficialPricingProviderId("MiniMax-M2.5")).toBe("minimax");
    expect(resolveOfficialPricingProviderId("Qwen-Plus")).toBe("alibaba");
  });
});

describe("resolveOfficialPricingMatch", () => {
  it("matches provider-prefixed model names against official catalog ids", () => {
    expect(
      resolveOfficialPricingMatch(catalog, "moonshotai/kimi-k2.5"),
    ).toEqual(
      expect.objectContaining({
        providerId: "moonshotai",
        modelId: "kimi-k2.5",
        modelName: "Kimi K2.5",
      }),
    );
  });
});

describe("resolveOfficialPricingProvider", () => {
  it("returns the official provider even when the exact catalog model is not matched", () => {
    expect(
      resolveOfficialPricingProvider(catalog, "moonshotai/kimi-k2.5:latest"),
    ).toEqual({
      providerId: "moonshotai",
      providerName: "Moonshot AI",
    });
  });
});

describe("estimateCostUsd", () => {
  it("falls back to output pricing when reasoning has no dedicated rate", () => {
    const result = estimateCostUsd(
      {
        inputTokens: 100_000,
        outputTokens: 50_000,
        reasoningTokens: 25_000,
        cachedTokens: 10_000,
      },
      {
        input: 0.6,
        output: 3,
        cache_read: 0.1,
      },
    );

    expect(result).not.toBeNull();
    expect(result?.inputUsd).toBeCloseTo(0.06);
    expect(result?.outputUsd).toBeCloseTo(0.15);
    expect(result?.reasoningUsd).toBeCloseTo(0.075);
    expect(result?.cacheUsd).toBeCloseTo(0.001);
    expect(result?.totalUsd).toBeCloseTo(0.286);
  });

  it("uses a dedicated reasoning rate when the catalog provides one", () => {
    const match = resolveOfficialPricingMatch(catalog, "qwen-plus");
    const result = estimateCostUsd(
      {
        inputTokens: 100_000,
        outputTokens: 50_000,
        reasoningTokens: 25_000,
        cachedTokens: 0,
      },
      match?.cost,
    );

    expect(result).not.toBeNull();
    expect(result?.inputUsd).toBeCloseTo(0.04);
    expect(result?.outputUsd).toBeCloseTo(0.06);
    expect(result?.reasoningUsd).toBeCloseTo(0.1);
    expect(result?.cacheUsd).toBeCloseTo(0);
    expect(result?.totalUsd).toBeCloseTo(0.2);
  });

  it("returns null when cost is null from estimateCostUsd", () => {
    expect(
      estimateCostUsd(
        {
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 25,
          cachedTokens: 10,
        },
        null,
      ),
    ).toBeNull();
  });

  it("returns zero cost from estimateCostUsd when all token counts are zero", () => {
    const result = estimateCostUsd(
      {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedTokens: 0,
      },
      { input: 1, output: 2 },
    );

    expect(result).not.toBeNull();
    expect(result?.totalUsd).toBe(0);
    expect(result?.inputUsd).toBe(0);
    expect(result?.outputUsd).toBe(0);
    expect(result?.reasoningUsd).toBe(0);
    expect(result?.cacheUsd).toBe(0);
  });
});

describe("buildModelLookupCandidates", () => {
  it("returns an empty array for an empty string", () => {
    expect(buildModelLookupCandidates("")).toEqual([]);
  });

  it("extracts both segments when model name contains / separator", () => {
    const candidates = buildModelLookupCandidates("anthropic/claude-sonnet-4");
    expect(candidates).toContain("anthropic/claude-sonnet-4");
    expect(candidates).toContain("claude-sonnet-4");
  });

  it("strips the variant suffix when model name contains : separator", () => {
    const candidates = buildModelLookupCandidates("claude-sonnet-4:latest");
    expect(candidates).toContain("claude-sonnet-4");
    expect(candidates).toContain("claude-sonnet-4:latest");
  });
});

describe("resolveOfficialPricingMatch edge cases", () => {
  it("returns null without a catalog or supplemental price", () => {
    expect(resolveOfficialPricingMatch(null, "claude-sonnet-4-6")).toBeNull();
  });

  it("returns null when the model is not found in the catalog", () => {
    expect(
      resolveOfficialPricingMatch(catalog, "minimax/unknown-model-xyz"),
    ).toBeNull();
  });
});

describe("supplemental model pricing", () => {
  it.each([
    ["mimo-v2-pro", "xiaomi", "mimo-v2-pro", 0.435, 0.0036, 0.87],
    ["mimo-v2.5-pro", "xiaomi", "mimo-v2.5-pro", 0.435, 0.0036, 0.87],
    ["xiaomi/mimo-v2.5", "xiaomi", "mimo-v2.5", 0.14, 0.0028, 0.28],
    ["claude-opus-4.8", "anthropic", "claude-opus-4-8", 5, 0.5, 25],
    ["anthropic/claude-opus-4.7", "anthropic", "claude-opus-4-7", 5, 0.5, 25],
    ["claude-sonnet-4", "anthropic", "claude-sonnet-4-20250514", 3, 0.3, 15],
    [
      "deepseek/deepseek-v4.1-flash",
      "deepseek",
      "deepseek-v4.1-flash",
      0.15,
      0.003,
      0.6,
    ],
    [
      "deepseek/deepseek-v4-flash-fast",
      "deepseek",
      "deepseek-v4-flash-fast",
      0.3,
      0.006,
      1.2,
    ],
    [
      "deepseek/deepseek-v4.1-flash-fast",
      "deepseek",
      "deepseek-v4.1-flash-fast",
      0.3,
      0.006,
      1.2,
    ],
    ["longcat-2.0", "longcat", "LongCat-2.0", 0.3, 0.006, 1.2],
    ["kimi-for-coding", "moonshotai", "kimi-for-coding", 0.95, 0.19, 4],
  ])(
    "prices %s even when the upstream catalog is unavailable",
    (raw, providerId, modelId, input, cache_read, output) => {
      const match = resolveOfficialPricingMatch(null, raw as string);
      expect(match).toEqual(
        expect.objectContaining({
          providerId,
          modelId,
          cost: { input, cache_read, output },
        }),
      );
    },
  );

  it("uses official catalog rates for a confirmed Claude alias", () => {
    const catalog = new Map([
      [
        "anthropic",
        {
          id: "anthropic",
          name: "Anthropic",
          modelsByLower: new Map([
            [
              "claude-opus-4-8",
              {
                id: "claude-opus-4-8",
                name: "Claude Opus 4.8",
                cost: { input: 6, output: 30, cache_read: 0.6 },
              },
            ],
          ]),
        },
      ],
    ]);
    const match = resolveOfficialPricingMatch(
      catalog,
      " ANTHROPIC/CLAUDE-OPUS-4.8:thinking ",
    );
    expect(match?.cost?.input).toBe(6);
    expect(match?.pricingSource).toBeUndefined();
  });

  it("uses the reviewed LongCat discount instead of the catalog list price", () => {
    const catalog = new Map([
      [
        "longcat",
        {
          id: "longcat",
          name: "LongCat",
          modelsByLower: new Map([
            [
              "longcat-2.0",
              {
                id: "LongCat-2.0",
                name: "LongCat 2.0",
                cost: { input: 0.75, output: 2.95, cache_read: 0.015 },
              },
            ],
          ]),
        },
      ],
    ]);
    expect(resolveOfficialPricingMatch(catalog, "longcat-2.0")).toEqual(
      expect.objectContaining({
        pricingSource: "reference",
        cost: { input: 0.3, output: 1.2, cache_read: 0.006 },
      }),
    );
  });

  it("fills an official model with no cost while keeping unrelated models unpriced", () => {
    const catalog = new Map([
      [
        "xiaomi",
        {
          id: "xiaomi",
          name: "Xiaomi",
          modelsByLower: new Map([
            ["mimo-v2.5", { id: "mimo-v2.5", name: "MiMo V2.5", cost: null }],
          ]),
        },
      ],
    ]);
    expect(resolveOfficialPricingMatch(catalog, "mimo-v2.5")?.cost?.input).toBe(
      0.14,
    );
    expect(resolveOfficialPricingMatch(catalog, "mimo-unconfirmed")).toBeNull();
  });

  it.each([
    "mimo-v2.5-free",
    "xiaomi/mimo-v2.5:free",
    "mimo-v2.5:free:thinking",
    "deepseek/deepseek-v4.1-flash:free",
    "nemotron-3-ultra-free",
    "claude-opus-4.8-free",
    "big-pickle",
    "grok-code",
    "codex-auto-review",
    "gpt-reserve",
    "hy3",
    "hy4-preview",
  ])("keeps free or unknown model %s unpriced", (raw) => {
    expect(resolveOfficialPricingMatch(catalog, raw)).toBeNull();
  });

  it("does not turn a free variant into a paid catalog model", () => {
    expect(resolveOfficialPricingMatch(catalog, "qwen-plus:free")).toBeNull();
  });

  it("labels subscription equivalents and charges reasoning once at the output rate", () => {
    const match = resolveOfficialPricingMatch(null, "kimi-for-coding");
    expect(match?.pricingSource).toBe("subscription");
    const result = estimateCostUsd(
      {
        inputTokens: 1_000_000,
        cachedTokens: 1_000_000,
        outputTokens: 750_000,
        reasoningTokens: 250_000,
      },
      match?.cost,
    );
    expect(result?.totalUsd).toBeCloseTo(5.14);
  });
});

describe("resolveOfficialPricingProviderId edge cases", () => {
  it("returns null for an unknown model that matches no provider rule", () => {
    expect(
      resolveOfficialPricingProviderId("totally-unknown-model"),
    ).toBeNull();
  });
});
