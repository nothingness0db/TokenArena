import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EtaParser } from "./eta";

const roots: string[] = [];

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokenarena-eta-"));
  roots.push(dir);
  return dir;
}

function sessionDir(etaRoot: string, id: string, branch = "daemon"): string {
  const dir = join(etaRoot, branch, "sessions", id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJournal(dir: string, lines: unknown[]): void {
  writeFileSync(
    join(dir, "journal.jsonl"),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf-8",
  );
}

function writeMeta(dir: string, meta: unknown): void {
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta), "utf-8");
}

function usageRow(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  totalTokens: number,
  cost: number,
  extra: Record<string, unknown> = {},
) {
  return {
    id: `usage-${input}-${output}`,
    entryId: "entry-synthetic",
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens,
      cost: { total: cost },
    },
    ...extra,
  };
}

function usageLine(row: unknown, extra: Record<string, unknown> = {}) {
  return { kind: "usage", row, ...extra };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("EtaParser", () => {
  it("aggregates a normal session into input/output/total buckets", async () => {
    const etaRoot = root();
    const dir = sessionDir(etaRoot, "s1");
    writeMeta(dir, {
      id: "s1",
      createdAt: "2026-01-15T10:00:00.000Z",
      cwd: "/work/demo",
      title: "eta-demo",
      model: "eta-model-1",
      agentId: "agent-1",
      conversationId: "conv-1",
      runtime: "eta",
      runtimeSession: "runtime-1",
    });
    writeJournal(dir, [
      usageLine(usageRow(100, 50, 20, 10, 180, 0.01), {
        timestamp: "2026-01-15T10:05:00.000Z",
      }),
      usageLine(
        usageRow(200, 100, 40, 20, 360, 0.02, {
          timestamp: "2026-01-15T10:20:00.000Z",
        }),
      ),
      usageLine(usageRow(50, 25, 10, 5, 90, 0.005), {
        time: "2026-01-15T10:25:00.000Z",
      }),
      { kind: "message", row: {} },
      "not-json",
    ]);

    const parser = new EtaParser(() => etaRoot);
    expect(parser.tool.id).toBe("eta");
    expect(parser.isInstalled()).toBe(true);

    const result = await parser.parse();
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      source: "eta",
      model: "eta-model-1",
      project: "eta-demo",
      bucketStart: "2026-01-15T10:00:00.000Z",
      inputTokens: 350,
      outputTokens: 175,
      reasoningTokens: 0,
      cachedTokens: 105,
      totalTokens: 630,
    });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      source: "eta",
      project: "eta-demo",
      primaryModel: "eta-model-1",
      totalTokens: 630,
    });
  });

  it("skips all-zero rows so opencode ACP sessions are not double counted", async () => {
    const etaRoot = root();
    const dir = sessionDir(etaRoot, "s2");
    writeMeta(dir, {
      id: "s2",
      createdAt: "2026-01-15T09:00:00.000Z",
      title: "acp-session",
      model: "opencode-go/model",
      runtime: "opencode",
    });
    writeJournal(dir, [
      usageLine(usageRow(0, 0, 0, 0, 0, 0), {
        timestamp: "2026-01-15T09:01:00.000Z",
      }),
      usageLine(usageRow(0, 0, 0, 0, 0, 0), {
        timestamp: "2026-01-15T09:02:00.000Z",
      }),
      usageLine(usageRow(0, 0, 0, 0, 0, 0), {
        timestamp: "2026-01-15T09:03:00.000Z",
      }),
    ]);

    const result = await new EtaParser(() => etaRoot).parse();
    expect(result.buckets).toEqual([]);
    expect(result.sessions).toEqual([]);
  });

  it("does not throw when meta.json is missing and still uses the line timestamp", async () => {
    const etaRoot = root();
    const dir = sessionDir(etaRoot, "s3", "sessions");
    const timestamp = Date.parse("2026-02-01T03:10:00.000Z");
    writeJournal(dir, [
      { kind: "usage", row: usageRow(12, 8, 2, 1, 23, 0.03), timestamp },
    ]);

    const parser = new EtaParser(etaRoot);
    expect(parser.isInstalled()).toBe(true);
    const result = await parser.parse();
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      model: "unknown",
      project: "unknown",
      bucketStart: "2026-02-01T03:00:00.000Z",
      inputTokens: 12,
      outputTokens: 8,
      cachedTokens: 3,
      totalTokens: 23,
    });
  });

  it("honors TOKEN_ARENA_ETA_DIR and reads the sessions root", async () => {
    const etaRoot = root();
    const dir = sessionDir(etaRoot, "s4", "sessions");
    writeMeta(dir, {
      id: "s4",
      createdAt: "2026-03-01T00:00:00.000Z",
      model: { provider: "eta", modelId: "model-object" },
      agentId: "agent-fallback",
    });
    writeJournal(dir, [
      {
        kind: "usage",
        row: usageRow(7, 3, 0, 0, 10, 0.001),
        t: Date.parse("2026-03-01T00:15:00.000Z"),
      },
    ]);

    vi.stubEnv("TOKEN_ARENA_ETA_DIR", etaRoot);
    const parser = new EtaParser();
    expect(parser.isInstalled()).toBe(true);
    const result = await parser.parse();
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      model: "model-object",
      project: "agent-fallback",
      bucketStart: "2026-03-01T00:00:00.000Z",
      totalTokens: 10,
    });
  });

  it("returns empty results when the eta directory is absent", async () => {
    const parser = new EtaParser(() => join(root(), "missing"));
    expect(parser.isInstalled()).toBe(false);
    expect(await parser.parse()).toEqual({ buckets: [], sessions: [] });
  });
});
