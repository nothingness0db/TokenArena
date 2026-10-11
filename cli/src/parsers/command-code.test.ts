import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandCodeParser } from "./command-code";

const roots: string[] = [];
function root() {
  const dir = mkdtempSync(join(tmpdir(), "tokenarena-command-code-"));
  roots.push(dir);
  return dir;
}
function write(dir: string, name: string, rows: unknown[]) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    rows.map((row) => JSON.stringify(row)).join("\n"),
  );
}
const header = {
  type: "session",
  version: 3,
  id: "s1",
  cwd: "/work/my-project",
};
const user = {
  type: "message",
  id: "u1",
  timestamp: "2026-10-10T10:00:00Z",
  message: { role: "user" },
};
const assistant = {
  type: "message",
  id: "a1",
  timestamp: "2026-10-10T10:00:04Z",
  message: { role: "assistant" },
  model: "deepseek/deepseek-v4-flash",
  usage: {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 70,
    cacheWriteTokens: 10,
  },
};
afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("CommandCodeParser", () => {
  it("reads the real envelope format and keeps cache input out of the total twice", async () => {
    const dir = root();
    write(join(dir, "work-my-project"), "s1.jsonl", [header, user, assistant]);
    const parser = new CommandCodeParser(dir);
    expect(parser.isInstalled()).toBe(true);
    const result = await parser.parse();
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      source: "command-code",
      project: "my-project",
      model: assistant.model,
      inputTokens: 30,
      outputTokens: 20,
      cachedTokens: 70,
      reasoningTokens: 0,
      totalTokens: 120,
    });
    expect(result.sessions[0]).toMatchObject({
      messageCount: 2,
      userMessageCount: 1,
      durationSeconds: 4,
      totalTokens: 120,
      primaryModel: assistant.model,
    });
  });

  it("deduplicates copied messages and ignores checkpoint files", async () => {
    const dir = root();
    write(dir, "s1.jsonl", [header, user, assistant, assistant]);
    write(dir, "fork.jsonl", [
      { ...header, id: "fork", parentSession: join(dir, "s1.jsonl") },
      user,
      assistant,
    ]);
    write(dir, "s1.checkpoints.jsonl", [{ ...assistant, id: "checkpoint" }]);
    const result = await new CommandCodeParser(dir).parse();
    expect(result.buckets.reduce((sum, b) => sum + b.totalTokens, 0)).toBe(120);
    expect(result.sessions.reduce((sum, s) => sum + s.messageCount, 0)).toBe(2);
  });

  it("counts colliding eight-hex IDs in unrelated sessions independently", async () => {
    const dir = root();
    write(dir, "a.jsonl", [
      header,
      {
        ...assistant,
        id: "cafebabe",
        usage: { inputTokens: 100, outputTokens: 10 },
      },
    ]);
    write(dir, "b.jsonl", [
      { ...header, id: "s2" },
      {
        ...assistant,
        id: "cafebabe",
        timestamp: "2026-10-10T11:00:00Z",
        usage: { inputTokens: 200, outputTokens: 10 },
      },
    ]);
    const result = await new CommandCodeParser(dir).parse();
    expect(result.buckets.reduce((sum, b) => sum + b.totalTokens, 0)).toBe(320);
    expect(result.sessions).toHaveLength(2);
  });

  it("keeps inherited cross-project usage in its parent regardless of file order", async () => {
    const dir = root();
    const inherited = {
      ...assistant,
      id: "cafebabe",
      parentId: user.id,
      usage: { inputTokens: 100, outputTokens: 10 },
    };
    const fresh = {
      ...inherited,
      timestamp: "2026-10-10T11:00:00Z",
      usage: { inputTokens: 200, outputTokens: 10 },
    };
    write(dir, "z-parent.jsonl", [
      { ...header, id: "parent", cwd: "/work/original" },
      user,
      inherited,
    ]);
    write(dir, "a-fork.jsonl", [
      {
        ...header,
        id: "fork",
        cwd: "/work/copied-project",
        parentSession: join(dir, "z-parent.jsonl"),
      },
      user,
      { ...inherited, parentId: null },
      fresh,
    ]);
    const result = await new CommandCodeParser(dir).parse();
    expect(result.buckets.map((b) => [b.project, b.totalTokens])).toEqual([
      ["original", 110],
      ["copied-project", 210],
    ]);
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0]).toMatchObject({
      sessionHash: createHash("sha256")
        .update("parent")
        .digest("hex")
        .slice(0, 16),
      project: "original",
      totalTokens: 110,
      messageCount: 2,
    });
    expect(result.sessions[1]).toMatchObject({
      project: "copied-project",
      totalTokens: 210,
      messageCount: 1,
    });
  });

  it("resolves nested forks using both relative paths and session IDs", async () => {
    const dir = root();
    const childMessage = {
      ...assistant,
      id: "child",
      timestamp: "2026-10-10T11:00:00Z",
    };
    const grandchildMessage = {
      ...assistant,
      id: "grandchild",
      timestamp: "2026-10-10T12:00:00Z",
    };
    write(dir, "z-parent.jsonl", [header, user, assistant]);
    write(dir, "m-child.jsonl", [
      { ...header, id: "child-session", parentSession: "z-parent.jsonl" },
      user,
      assistant,
      childMessage,
    ]);
    write(dir, "a-grandchild.jsonl", [
      { ...header, id: "grandchild-session", parentSession: "child-session" },
      user,
      assistant,
      childMessage,
      grandchildMessage,
    ]);
    const result = await new CommandCodeParser(dir).parse();
    expect(result.sessions.map((s) => [s.totalTokens, s.messageCount])).toEqual(
      [
        [120, 2],
        [120, 1],
        [120, 1],
      ],
    );
    expect(result.buckets.reduce((sum, b) => sum + b.totalTokens, 0)).toBe(360);
  });

  it("retains orphan history and terminates cyclic or malformed parent references", async () => {
    const dir = root();
    write(dir, "orphan.jsonl", [
      { ...header, id: "orphan", parentSession: "missing.jsonl" },
      user,
      assistant,
    ]);
    write(dir, "cycle-a.jsonl", [
      { ...header, id: "cycle-a", parentSession: "cycle-b" },
      user,
      assistant,
    ]);
    write(dir, "cycle-b.jsonl", [
      { ...header, id: "cycle-b", parentSession: "cycle-a" },
      user,
      assistant,
    ]);
    write(dir, "bad-parent.jsonl", [
      { ...header, id: "bad-parent", parentSession: { invalid: true } },
      user,
      assistant,
    ]);
    const result = await new CommandCodeParser(dir).parse();
    expect(result.sessions).toHaveLength(3);
    expect(result.sessions.every((s) => s.totalTokens === 120)).toBe(true);
    expect(result.buckets.reduce((sum, b) => sum + b.totalTokens, 0)).toBe(360);
  });

  it("uses model changes and the directory when session metadata is missing", async () => {
    const dir = root();
    write(join(dir, "work-project"), "s.jsonl", [
      { type: "model_change", model: "glm-5" },
      { ...assistant, model: undefined },
    ]);
    const result = await new CommandCodeParser(dir).parse();
    expect(result.buckets[0]).toMatchObject({
      model: "glm-5",
      project: "project",
    });
  });

  it("skips malformed records, invalid counters, tool messages and incomplete lines", async () => {
    const dir = root();
    write(dir, "s.jsonl", [
      header,
      null,
      3,
      {},
      user,
      { ...assistant, timestamp: "invalid" },
      { ...assistant, id: "negative", usage: { inputTokens: -1 } },
      { ...assistant, id: "string", usage: { inputTokens: "100" } },
      {
        ...assistant,
        id: "cache",
        usage: { inputTokens: 1, cacheReadTokens: 2 },
      },
      { ...assistant, id: "zero", usage: {} },
      { ...assistant, id: "tool", message: { role: "tool" } },
      { ...assistant, id: "without-usage", usage: undefined },
      assistant,
    ]);
    const path = join(dir, "s.jsonl");
    writeFileSync(path, '\n{"incomplete":', { flag: "a" });
    const result = await new CommandCodeParser(dir).parse();
    expect(result.buckets[0].totalTokens).toBe(120);
    expect(result.sessions[0].messageCount).toBe(7);
  });

  it("handles absent data and Windows project paths", async () => {
    const dir = root();
    const missing = new CommandCodeParser(join(dir, "missing"));
    expect(missing.isInstalled()).toBe(false);
    expect(await missing.parse()).toEqual({ buckets: [], sessions: [] });
    write(dir, "s.jsonl", [
      { ...header, cwd: "C:\\work\\my-project\\" },
      assistant,
    ]);
    expect((await new CommandCodeParser(dir).parse()).buckets[0].project).toBe(
      "my-project",
    );
  });
});
