import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekHarnessParser } from "./deepseek-harness";

const roots: string[] = [];
function root() {
  const dir = mkdtempSync(join(tmpdir(), "tokenarena-dsh-"));
  roots.push(dir);
  return dir;
}
function write(dir: string, version: number, rows: unknown[]) {
  mkdirSync(dir, { recursive: true });
  const name = version === 0 ? "session.jsonl" : `session.v${version}.jsonl`;
  const path = join(dir, name);
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n"));
  return path;
}
const header = {
  type: "session",
  version: 4,
  id: "s1",
  cwd: "/work/my-project",
  isSeeded: false,
};
const user = {
  type: "user/message",
  seq: 0,
  time: 1791626400000,
  data: { id: "u1" },
};
const assistant = {
  type: "assistant/message",
  seq: 1,
  time: 1791626404000,
  data: {
    message: {
      id: "a1",
      source: { kind: "model", provider: "deepseek", model: "deepseek-v4-pro" },
    },
    usage: {
      inputTokens: 30,
      outputTokens: 40,
      cacheReadTokens: 70,
      cacheWriteTokens: 10,
      reasoningTokens: 15,
    },
  },
};

// Independent raw-block encoder exercises real decompression on Node or zstd.
function rawZstd(text: string) {
  const body = Buffer.from(text);
  const header = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x60, 0, 0, 0, 0, 0]);
  // A two-byte content-size field represents length minus 256.
  if (body.length < 256) {
    header[4] = 0x20;
    header[5] = body.length;
    header.writeUIntLE((body.length << 3) | 1, 6, 3);
    return Buffer.concat([header.subarray(0, 9), body]);
  }
  header.writeUInt16LE(body.length - 256, 5);
  header.writeUIntLE((body.length << 3) | 1, 7, 3);
  return Buffer.concat([header, body]);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("DeepSeekHarnessParser", () => {
  it.each([0, 1, 2, 3, 4])(
    "reads released v%i usage with disjoint input/cache and output/reasoning",
    async (version) => {
      const dir = root();
      write(join(dir, "project", "s1"), version, [
        { ...header, version },
        user,
        assistant,
      ]);
      const parser = new DeepSeekHarnessParser(dir);
      expect(parser.isInstalled()).toBe(true);
      const result = await parser.parse();
      expect(result.buckets).toHaveLength(1);
      expect(result.buckets[0]).toMatchObject({
        source: "deepseek-harness",
        model: "deepseek-v4-pro",
        project: "my-project",
        inputTokens: 40,
        outputTokens: 25,
        cachedTokens: 70,
        reasoningTokens: 15,
        totalTokens: 150,
      });
      expect(result.sessions[0]).toMatchObject({
        durationSeconds: 4,
        messageCount: 2,
        totalTokens: 150,
      });
    },
  );

  it("uses only the newest migration generation and ignores temporary artifacts", async () => {
    const dir = root();
    const sessionDir = join(dir, "project", "s1");
    write(sessionDir, 0, [{ ...header, version: 0 }, user, assistant]);
    const current = write(sessionDir, 4, [header, user, assistant, assistant]);
    writeFileSync(join(sessionDir, "session.migration.tmp.jsonl"), "bad");
    writeFileSync(join(sessionDir, "session.v5.backup.jsonl"), "bad");
    writeFileSync(join(sessionDir, "session.v04.jsonl"), "bad");
    writeFileSync(current, '\n{"type":', { flag: "a" });
    const result = await new DeepSeekHarnessParser(dir).parse();
    expect(result.buckets[0].totalTokens).toBe(150);
    expect(result.sessions[0].messageCount).toBe(2);
  });

  it("reads all compressed frames and recovers complete batches before a torn tail", async () => {
    const dir = root();
    const path = write(dir, 4, [header, user, assistant]);
    const text = `${JSON.stringify(header)}\n`;
    const events = `${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`;
    writeFileSync(
      `${path}.zstd`,
      Buffer.concat([
        rawZstd(text),
        rawZstd(events),
        rawZstd("incomplete").subarray(0, 7),
      ]),
    );
    rmSync(path);
    const result = await new DeepSeekHarnessParser(dir).parse();
    expect(result.buckets[0].totalTokens).toBe(150);
    expect(result.sessions[0].messageCount).toBe(2);
  });

  it.each([0, 1, 2, 4])(
    "does not count inherited fork history in v%i",
    async (version) => {
      const dir = root();
      write(join(dir, "original"), version, [
        { ...header, version },
        user,
        assistant,
      ]);
      write(join(dir, "fork"), version, [
        {
          ...header,
          version,
          id: "fork",
          isSeeded: version >= 2,
          ...(version < 2 ? { seedLength: 2 } : {}),
        },
        user,
        assistant,
        { type: "session/end-seed", seq: 2, data: { inherited: true } },
        { ...user, seq: 3 },
        { ...assistant, seq: 4 },
      ]);
      const result = await new DeepSeekHarnessParser(dir).parse();
      expect(result.buckets[0].totalTokens).toBe(300);
      expect(result.sessions).toHaveLength(2);
      expect(
        result.sessions.every(
          (s) => s.messageCount === 2 && s.totalTokens === 150,
        ),
      ).toBe(true);
    },
  );

  it("uses only the final cumulative stream usage and does not add message and stream usage", async () => {
    const dir = root();
    const stream = [
      {
        type: "chunk",
        chunk: { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
      },
      { type: "chunk", chunk: { type: "usage", usage: assistant.data.usage } },
    ];
    write(dir, 4, [
      header,
      user,
      { ...assistant, data: { ...assistant.data, stream } },
      {
        ...assistant,
        seq: 2,
        data: { ...assistant.data, usage: undefined, stream },
      },
      {
        type: "assistant/attempt",
        seq: 3,
        time: assistant.time,
        data: { stream },
      },
    ]);
    const result = await new DeepSeekHarnessParser(dir).parse();
    expect(result.buckets.reduce((sum, b) => sum + b.totalTokens, 0)).toBe(450);
    expect(result.buckets.find((b) => b.model === "unknown")?.totalTokens).toBe(
      150,
    );
    expect(result.sessions[0]).toMatchObject({
      messageCount: 3,
      totalTokens: 450,
    });
  });

  it("skips bad counters, malformed rows and untimed messages", async () => {
    const dir = root();
    write(dir, 4, [
      header,
      null,
      3,
      {},
      user,
      { ...assistant, seq: 2, time: "invalid" },
      { ...assistant, seq: 3, data: { usage: { inputTokens: -1 } } },
      { ...assistant, seq: 4, data: { usage: { inputTokens: "30" } } },
      {
        ...assistant,
        seq: 5,
        data: { usage: { outputTokens: 5, reasoningTokens: 6 } },
      },
      { ...assistant, seq: 6, data: { usage: {} } },
      { ...assistant, seq: 7, data: {} },
      { ...assistant, seq: 9, data: { stream: {} } },
      { ...assistant, seq: 10, data: { stream: [null] } },
      { type: "tool/result", seq: 8, time: assistant.time },
      assistant,
    ]);
    expect(
      (await new DeepSeekHarnessParser(dir).parse()).buckets[0].totalTokens,
    ).toBe(150);
  });

  it("honors DSH_HOME and handles missing, headerless and unfinished seeded logs", async () => {
    const dir = root();
    vi.stubEnv("DSH_HOME", dir);
    const parser = new DeepSeekHarnessParser();
    expect(parser.tool.dataDir).toBe(join(dir, "sessions"));
    expect(parser.isInstalled()).toBe(false);
    expect(await parser.parse()).toEqual({ buckets: [], sessions: [] });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    write(join(dir, "sessions", "headerless"), 4, [assistant]);
    write(join(dir, "sessions", "seeded"), 4, [
      { ...header, isSeeded: true },
      user,
      assistant,
    ]);
    expect(await parser.parse()).toEqual({ buckets: [], sessions: [] });
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("Invalid DeepSeek Harness session header"),
    );
  });

  it("skips unsupported newest generations without losing other sessions or falling back", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = root();
    const usage = { inputTokens: 30, outputTokens: 40, cacheReadTokens: 70 };
    const reply = { ...assistant, data: { ...assistant.data, usage } };
    write(join(dir, "healthy"), 4, [{ ...header, id: "healthy" }, user, reply]);
    write(join(dir, "future"), 4, [header, user, reply]);
    write(join(dir, "future"), 5, [{ ...header, version: 5 }, user, reply]);
    const corrupt = write(join(dir, "corrupt"), 4, [header, user, reply]);
    rmSync(corrupt);
    writeFileSync(`${corrupt}.zstd`, Buffer.alloc(4));
    const result = await new DeepSeekHarnessParser(dir).parse();
    expect(result.buckets.reduce((sum, b) => sum + b.totalTokens, 0)).toBe(140);
    expect(result.sessions).toHaveLength(1);
    expect(warning).toHaveBeenCalledTimes(2);
    expect(
      warning.mock.calls.some(([message]) =>
        String(message).includes(
          "Unsupported DeepSeek Harness session format: 5",
        ),
      ),
    ).toBe(true);
    expect(
      warning.mock.calls.some(([message]) =>
        String(message).includes("Invalid Zstandard frame"),
      ),
    ).toBe(true);
  });

  describe.each([0, 1])("released v%i top-level streams", (version) => {
    const usage = { inputTokens: 30, outputTokens: 40, cacheReadTokens: 70 };
    const physicalHeader = (id = "legacy", seedLength?: number) => ({
      type: "session",
      version,
      id,
      createdAt: user.time,
      cwd: header.cwd,
      delegationDepth: 0,
      ...(seedLength === undefined ? {} : { seedLength }),
    });
    const chunk = (seq: number, value: unknown, step = 1) => ({
      type: "assistant/chunk",
      seq,
      time: user.time + seq * 1000,
      data: { turn: 1, step, chunk: value },
    });
    const finish = (seq: number) =>
      chunk(seq, {
        type: "finish",
        reason: {
          kind: "error",
          failure: { message: "provider failed", code: "PROVIDER_ERROR" },
        },
      });
    const sample = (seq: number, counters = usage) =>
      chunk(seq, { type: "usage", usage: counters });
    const reply = (
      seq: number,
      counters: typeof usage | undefined = usage,
    ) => ({
      ...assistant,
      seq,
      time: user.time + seq * 1000,
      sourceEventSeqs: [1, 2, 3],
      data: { ...assistant.data, turn: 1, step: 1, usage: counters },
    });

    it("counts successful assembled usage once and uses its final cumulative sample", async () => {
      const dir = root();
      write(dir, version, [
        physicalHeader(),
        user,
        sample(1, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }),
        sample(2),
        chunk(3, { type: "finish", reason: { kind: "stop" } }),
        reply(4),
      ]);
      const result = await new DeepSeekHarnessParser(dir).parse();
      expect(result.buckets[0]).toMatchObject({
        totalTokens: 140,
        model: assistant.data.message.source.model,
      });
      expect(result.sessions[0]).toMatchObject({
        messageCount: 2,
        totalTokens: 140,
      });
    });

    it("retains usage for failed and unfinished attempts without fabricating messages", async () => {
      const dir = root();
      write(join(dir, "failed"), version, [
        physicalHeader("failed"),
        user,
        sample(1),
        finish(2),
        {
          type: "step/end",
          seq: 3,
          time: user.time + 3000,
          data: { turn: 1, step: 1 },
        },
      ]);
      write(join(dir, "unfinished"), version, [
        physicalHeader("unfinished"),
        user,
        sample(1),
      ]);
      const result = await new DeepSeekHarnessParser(dir).parse();
      expect(result.buckets[0].totalTokens).toBe(280);
      expect(result.sessions).toHaveLength(2);
      expect(
        result.sessions.every(
          (s) => s.messageCount === 1 && s.totalTokens === 140,
        ),
      ).toBe(true);
    });

    it("counts a retried attempt separately from the final successful message", async () => {
      const dir = root();
      write(dir, version, [
        physicalHeader(),
        user,
        sample(1),
        finish(2),
        {
          type: "llm/retry",
          seq: 3,
          time: user.time + 3000,
          data: { turn: 1, step: 1 },
        },
        {
          type: "llm/retry-started",
          seq: 4,
          time: user.time + 4000,
          data: { turn: 1, step: 1 },
        },
        sample(5),
        chunk(6, { type: "finish", reason: { kind: "stop" } }),
        { ...reply(7), sourceEventSeqs: [5, 6] },
      ]);
      const result = await new DeepSeekHarnessParser(dir).parse();
      expect(result.buckets.reduce((sum, b) => sum + b.totalTokens, 0)).toBe(
        280,
      );
      expect(result.sessions[0]).toMatchObject({
        messageCount: 2,
        totalTokens: 280,
      });
    });

    it("excludes inherited chunks before the physical seed cut", async () => {
      const dir = root();
      write(dir, version, [
        physicalHeader("fork", 3),
        user,
        sample(1),
        finish(2),
        { type: "session/end-seed", seq: 3, time: user.time + 3000, data: {} },
        { ...user, seq: 4 },
        sample(5),
        finish(6),
      ]);
      const result = await new DeepSeekHarnessParser(dir).parse();
      expect(result.buckets[0].totalTokens).toBe(140);
      expect(result.sessions[0]).toMatchObject({
        messageCount: 1,
        totalTokens: 140,
      });
    });

    it.each(["packed successor", "step change", "unstreamed message"])(
      "separates an earlier failed prefix from a %s",
      async (boundary) => {
        const dir = root();
        const successor =
          boundary === "packed successor"
            ? [
                finish(2),
                {
                  type: "text-chunks",
                  seq0: 3,
                  time0: user.time + 3000,
                  data: {
                    turn: 1,
                    step: 1,
                    index: 0,
                    texts: ["hello"],
                    dt: [],
                  },
                },
                { ...reply(4), sourceEventSeqs: [3] },
              ]
            : boundary === "step change"
              ? [
                  chunk(2, { type: "usage", usage }, 2),
                  {
                    ...reply(3),
                    data: { ...reply(3).data, step: 2 },
                    sourceEventSeqs: [2],
                  },
                ]
              : [{ ...reply(2), sourceEventSeqs: [] }];
        write(dir, version, [physicalHeader(), user, sample(1), ...successor]);
        const result = await new DeepSeekHarnessParser(dir).parse();
        expect(result.buckets.reduce((sum, b) => sum + b.totalTokens, 0)).toBe(
          280,
        );
        expect(result.sessions[0]).toMatchObject({
          messageCount: 2,
          totalTokens: 280,
        });
      },
    );

    it("ignores malformed chunks without changing a valid attempt's boundary", async () => {
      const dir = root();
      write(dir, version, [
        physicalHeader(),
        user,
        sample(1),
        { ...chunk(2, { type: "usage", usage }, 2), time: "invalid" },
        {
          ...chunk(3, { type: "finish", reason: { kind: "stop" } }, 2),
          seq: "invalid",
        },
        { ...reply(4), sourceEventSeqs: [1] },
      ]);
      const result = await new DeepSeekHarnessParser(dir).parse();
      expect(result.buckets.reduce((sum, b) => sum + b.totalTokens, 0)).toBe(
        140,
      );
      expect(result.buckets[0].model).toBe(assistant.data.message.source.model);
    });

    it("uses the numeric seed cut even when an old header also has isSeeded", async () => {
      const dir = root();
      write(dir, version, [
        { ...physicalHeader("fork", 2), isSeeded: true },
        user,
        sample(1),
        { ...user, seq: 2 },
        sample(3),
        finish(4),
      ]);
      const result = await new DeepSeekHarnessParser(dir).parse();
      expect(result.buckets[0].totalTokens).toBe(140);
      expect(result.sessions[0].messageCount).toBe(1);
    });

    it("retains streamed usage when the assembled message omits its usage field", async () => {
      const dir = root();
      write(dir, version, [
        physicalHeader(),
        user,
        sample(1),
        chunk(2, { type: "finish", reason: { kind: "stop" } }),
        { ...reply(3), data: { ...reply(3).data, usage: undefined } },
      ]);
      const result = await new DeepSeekHarnessParser(dir).parse();
      expect(result.buckets[0].totalTokens).toBe(140);
      expect(result.sessions[0].messageCount).toBe(2);
    });
  });
});
