import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EtaParser } from "./eta";

type SqlTestRow = Record<string, string | number | null>;

async function writeSqliteDb(
  dbPath: string,
  rows: SqlTestRow[],
): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    const columns = Object.keys(rows[0] ?? {});
    const names = columns.map((column) => `"${column}"`).join(", ");
    const placeholders = columns.map(() => "?").join(", ");
    db.exec(`CREATE TABLE usage (${names})`);
    const insert = db.prepare(
      `INSERT INTO usage (${names}) VALUES (${placeholders})`,
    );
    for (const row of rows) insert.run(...columns.map((c) => row[c]));
  } finally {
    db.close();
  }
}

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

  it("reads non-zero usage from eta.sqlite and ignores all-zero journals", async () => {
    const etaRoot = root();
    const dir = sessionDir(etaRoot, "s5");
    writeMeta(dir, {
      id: "s5",
      createdAt: "2026-04-01T08:00:00.000Z",
      title: "sqlite-title",
      model: "eta-sqlite-model",
    });
    writeJournal(dir, [
      usageLine(usageRow(0, 0, 0, 0, 0, 0), {
        timestamp: "2026-04-01T08:05:00.000Z",
      }),
    ]);
    await writeSqliteDb(join(etaRoot, "eta.sqlite"), [
      {
        session_id: "s5",
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 20,
        cache_write_tokens: 10,
        total_tokens: 180,
        cost_total: 0.01,
        timestamp: "2026-04-01T08:05:00.000Z",
      },
      {
        session_id: "s5",
        input_tokens: 200,
        output_tokens: 100,
        cache_read_tokens: 40,
        cache_write_tokens: 20,
        total_tokens: 360,
        cost_total: 0.02,
        timestamp: "2026-04-01T08:20:00.000Z",
      },
      {
        session_id: "s5",
        input_tokens: 50,
        output_tokens: 25,
        cache_read_tokens: 10,
        cache_write_tokens: 5,
        total_tokens: 90,
        cost_total: 0.005,
        timestamp: "2026-04-01T08:25:00.000Z",
      },
    ]);

    const result = await new EtaParser(etaRoot).parse();
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      source: "eta",
      model: "eta-sqlite-model",
      project: "sqlite-title",
      bucketStart: "2026-04-01T08:00:00.000Z",
      inputTokens: 350,
      outputTokens: 175,
      cachedTokens: 105,
      totalTokens: 630,
    });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({ totalTokens: 630 });
  });

  it("skips all-zero sqlite rows", async () => {
    const etaRoot = root();
    await writeSqliteDb(join(etaRoot, "eta.sqlite"), [
      {
        sessionId: "s-zero",
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: 0,
        timestamp: "2026-04-02T01:00:00.000Z",
      },
    ]);

    const result = await new EtaParser(etaRoot).parse();
    expect(result.buckets).toEqual([]);
    expect(result.sessions).toEqual([]);
  });

  it("reads a JSON usage blob and numeric-second timestamps", async () => {
    const etaRoot = root();
    writeFileSync(join(etaRoot, "eta.sqlite"), "");
    const blob = JSON.stringify({
      usage: {
        input: 5,
        output: 3,
        cacheRead: 1,
        cacheWrite: 0,
        totalTokens: 9,
        cost: { total: 0.02 },
      },
    });
    const rows: SqlTestRow[] = [
      {
        session_id: "s6",
        data: blob,
        created: Date.parse("2026-05-01T12:10:00.000Z") / 1000,
      },
      { session_id: "s6", data: "not-json", created: 0 },
      { session_id: "s6", data: blob, created: null },
    ];
    const reader = vi.fn(async () => rows);
    const result = await new EtaParser(etaRoot, reader).parse();
    expect(reader).toHaveBeenCalledWith(join(etaRoot, "eta.sqlite"));
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      model: "unknown",
      project: "unknown",
      bucketStart: "2026-05-01T12:00:00.000Z",
      inputTokens: 5,
      outputTokens: 3,
      cachedTokens: 1,
      totalTokens: 9,
    });
  });

  it("falls back to journals when the sqlite reader throws", async () => {
    const etaRoot = root();
    const dir = sessionDir(etaRoot, "s7");
    writeFileSync(join(etaRoot, "eta.sqlite"), "");
    writeJournal(dir, [
      usageLine(usageRow(4, 2, 1, 0, 7, 0.01), {
        timestamp: "2026-06-01T02:05:00.000Z",
      }),
    ]);
    const reader = vi.fn(async () => {
      throw new Error("db locked");
    });
    const warn = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const result = await new EtaParser(etaRoot, reader).parse();
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({ totalTokens: 7 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("uses row at/model and keeps sessions that have no meta.json", async () => {
    const etaRoot = root();
    const dir = sessionDir(etaRoot, "with-meta");
    writeMeta(dir, {
      id: "with-meta",
      createdAt: "2026-07-01T00:00:00.000Z",
      title: "meta-title",
      model: "meta-model",
    });
    await writeSqliteDb(join(etaRoot, "eta.sqlite"), [
      {
        session_id: "with-meta",
        model: "model-a",
        input: 10,
        output: 5,
        cache_read: 0,
        cache_write: 0,
        total_tokens: 15,
        cost_total: 0.01,
        at: "2026-07-01T09:10:00.000Z",
      },
      {
        session_id: "with-meta",
        model: "model-b",
        input: 20,
        output: 10,
        cache_read: 0,
        cache_write: 0,
        total_tokens: 30,
        cost_total: 0.02,
        at: "2026-07-01T10:10:00.000Z",
      },
      {
        session_id: "no-meta",
        model: "model-c",
        input: 100,
        output: 50,
        cache_read: 0,
        cache_write: 0,
        total_tokens: 150,
        cost_total: 0.03,
        at: "2026-07-01T11:10:00.000Z",
      },
    ]);

    const result = await new EtaParser(etaRoot).parse();
    expect(result.buckets).toHaveLength(3);
    const byModel = new Map(
      result.buckets.map((bucket) => [bucket.model, bucket]),
    );
    expect(byModel.get("model-a")).toMatchObject({
      bucketStart: "2026-07-01T09:00:00.000Z",
      project: "meta-title",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
    expect(byModel.get("model-b")).toMatchObject({
      bucketStart: "2026-07-01T10:00:00.000Z",
      project: "meta-title",
      totalTokens: 30,
    });
    expect(byModel.get("model-c")).toMatchObject({
      bucketStart: "2026-07-01T11:00:00.000Z",
      project: "unknown",
      inputTokens: 100,
      totalTokens: 150,
    });
    expect(result.buckets.reduce((sum, b) => sum + b.totalTokens, 0)).toBe(195);
    expect(
      result.buckets.some(
        (bucket) => bucket.bucketStart === "2026-07-01T00:00:00.000Z",
      ),
    ).toBe(false);
  });

  it("returns empty results when the eta directory is absent", async () => {
    const parser = new EtaParser(() => join(root(), "missing"));
    expect(parser.isInstalled()).toBe(false);
    expect(await parser.parse()).toEqual({ buckets: [], sessions: [] });
  });
});
