import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { aggregateToBuckets } from "../domain/aggregator";
import { extractSessions } from "../domain/session-extractor";
import type {
  ParseResult,
  SessionEvent,
  TokenUsageEntry,
} from "../domain/types";
import { parseJsonl } from "../infrastructure/fs/utils";
import { decodeZstdFrames } from "../infrastructure/fs/zstd";
import { registerParser } from "./registry";
import type { IParser, ToolDefinition } from "./types";

const TOOL_ID = "deepseek-harness";

interface HarnessUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

interface HarnessEvent {
  type?: string;
  version?: number;
  id?: string;
  cwd?: string;
  seedLength?: number;
  isSeeded?: boolean;
  seq?: number;
  time?: number;
  seq0?: number;
  sourceEventSeqs?: unknown[];
  data?: {
    id?: string;
    inherited?: boolean;
    turn?: number;
    step?: number;
    chunk?: { type?: string; usage?: HarnessUsage };
    usage?: HarnessUsage;
    message?: { id?: string; source?: { model?: string } };
    stream?: Array<{
      type?: string;
      chunk?: { type?: string; usage?: HarnessUsage };
    }>;
  };
}

/** Select only the newest committed format generation in each session directory. */
function findSessionFiles(root: string): string[] {
  const generations = new Map<string, { path: string; version: number }>();
  const visit = (dir: string) => {
    if (!existsSync(dir)) return;
    let children: Dirent[];
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      const path = join(dir, child.name);
      if (child.isDirectory()) {
        visit(path);
      } else if (child.isFile()) {
        const match = /^session(?:\.v([1-9]\d*))?\.jsonl(?:\.zstd)?$/.exec(
          child.name,
        );
        if (!match) continue;
        const version = Number(match[1] || 0);
        const previous = generations.get(dirname(path));
        if (!previous || version > previous.version)
          generations.set(dirname(path), { path, version });
      }
    }
  };
  visit(root);
  return Array.from(generations.values(), ({ path }) => path).sort();
}

function count(value: unknown): number | null {
  if (value === undefined) return 0;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** Fold released v0/v1 top-level streams into one sample per request attempt. */
function legacyUsageRows(
  rows: HarnessEvent[],
  inheritedCut: number,
): HarnessEvent[] {
  const result: HarnessEvent[] = [];
  const seen = new Set<number>();
  let pending:
    | {
        turn?: number;
        step?: number;
        last: HarnessEvent;
        usage?: HarnessUsage;
        terminal: boolean;
      }
    | undefined;
  const flush = () => {
    if (pending?.usage) {
      result.push({
        ...pending.last,
        type: "assistant/attempt",
        data: { usage: pending.usage },
      });
    }
    pending = undefined;
  };
  for (const row of rows) {
    const packed =
      row.type === "text-chunks" ||
      row.type === "reasoning-chunks" ||
      row.type === "tool-call-chunks";
    const seq = packed ? row.seq0 : row.seq;
    if (
      typeof seq !== "number" ||
      !Number.isSafeInteger(seq) ||
      seq < inheritedCut ||
      seen.has(seq)
    )
      continue;
    if (
      row.type === "assistant/chunk" &&
      (typeof row.time !== "number" ||
        !Number.isFinite(row.time) ||
        Number.isNaN(new Date(row.time).getTime()))
    )
      continue;
    seen.add(seq);
    if (row.type === "assistant/chunk" || packed) {
      if (
        pending &&
        (pending.terminal ||
          pending.turn !== row.data?.turn ||
          pending.step !== row.data?.step)
      )
        flush();
      if (packed) continue;
      pending ??= {
        turn: row.data?.turn,
        step: row.data?.step,
        last: row,
        terminal: false,
      };
      pending.last = row;
      if (row.data?.chunk?.type === "usage")
        pending.usage = row.data.chunk.usage;
      if (row.data?.chunk?.type === "finish") pending.terminal = true;
      continue;
    }
    if (row.type === "assistant/message") {
      if (
        pending &&
        (pending.turn !== row.data?.turn ||
          pending.step !== row.data?.step ||
          row.sourceEventSeqs?.length === 0)
      )
        flush();
      // The assembled message replaces its own stream sample, including when
      // the message has no usage field and the sample only exists in chunks.
      result.push(
        pending?.usage && !row.data?.usage
          ? { ...row, data: { ...row.data, usage: pending.usage } }
          : row,
      );
      pending = undefined;
      continue;
    }
    if (
      [
        "turn/start",
        "turn/end",
        "step/start",
        "step/end",
        "llm/retry",
        "llm/retry-started",
        "session/end-seed",
      ].includes(row.type || "")
    )
      flush();
    result.push(row);
  }
  flush();
  return result;
}

export class DeepSeekHarnessParser implements IParser {
  readonly tool: ToolDefinition;

  constructor(
    private readonly dataDir = join(
      process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"),
      "sessions",
    ),
  ) {
    this.tool = { id: TOOL_ID, name: "DeepSeek Harness", dataDir };
  }

  async parse(): Promise<ParseResult> {
    const entries: TokenUsageEntry[] = [];
    const events: SessionEvent[] = [];
    const seenEvents = new Set<string>();

    for (const filePath of findSessionFiles(this.dataDir)) {
      try {
        const content = filePath.endsWith(".zstd")
          ? decodeZstdFrames(readFileSync(filePath))
          : readFileSync(filePath, "utf-8");
        if (!content) continue;
        const rows = parseJsonl<HarnessEvent | null>(content).filter(
          (row): row is HarnessEvent => row !== null && typeof row === "object",
        );
        const header = rows[0];
        if (
          header?.type !== "session" ||
          typeof header.id !== "string" ||
          !header.id
        )
          throw new Error("Invalid DeepSeek Harness session header");
        if (
          typeof header.version !== "number" ||
          !Number.isInteger(header.version) ||
          header.version < 0 ||
          header.version > 4
        )
          throw new Error(
            `Unsupported DeepSeek Harness session format: ${header.version}`,
          );
        const sessionId = header.id;
        const project =
          typeof header.cwd === "string" && header.cwd
            ? basename(header.cwd.replace(/\\/g, "/").replace(/\/+$/, "")) ||
              "unknown"
            : "unknown";
        // V0/V1 store a seed cut in the header. V2+ tag the end of inherited
        // history; it is context copied from another session, not new usage.
        const inheritedCut =
          header.version < 2
            ? (header.seedLength ?? 0)
            : rows.reduce(
                (cut, row) =>
                  row.type === "session/end-seed" &&
                  row.data?.inherited === true
                    ? Math.max(cut, row.seq ?? 0)
                    : cut,
                0,
              );
        if (
          header.version >= 2 &&
          header.isSeeded &&
          !rows.some(
            (row) => row.type === "session/end-seed" && row.data?.inherited,
          )
        )
          continue;

        const usageRows =
          header.version < 2
            ? legacyUsageRows(rows.slice(1), inheritedCut)
            : rows.slice(1);
        for (const row of usageRows) {
          if (
            typeof row.seq !== "number" ||
            !Number.isSafeInteger(row.seq) ||
            row.seq < inheritedCut
          )
            continue;
          if (
            row.type !== "user/message" &&
            row.type !== "assistant/message" &&
            row.type !== "assistant/attempt"
          )
            continue;
          if (typeof row.time !== "number" || !Number.isFinite(row.time))
            continue;
          const timestamp = new Date(row.time);
          if (Number.isNaN(timestamp.getTime())) continue;
          const key = `${sessionId}:${row.seq}`;
          if (seenEvents.has(key)) continue;
          seenEvents.add(key);
          if (row.type !== "assistant/attempt")
            events.push({
              sessionId,
              source: TOOL_ID,
              project,
              timestamp,
              role: row.type === "user/message" ? "user" : "assistant",
            });
          if (row.type === "user/message") continue;
          const data = row.data;
          let usage = data?.usage;
          if (!usage) {
            // Stream samples are cumulative within one attempt. Use the last
            // sample once, and never add it to an assembled message's usage.
            for (const record of Array.isArray(data?.stream)
              ? data.stream
              : []) {
              if (record?.type === "chunk" && record.chunk?.type === "usage")
                usage = record.chunk.usage;
            }
          }
          if (!usage) continue;
          const input = count(usage.inputTokens);
          const output = count(usage.outputTokens);
          const cachedTokens = count(usage.cacheReadTokens);
          const cacheWrite = count(usage.cacheWriteTokens);
          const reasoningTokens = count(usage.reasoningTokens);
          if (
            input === null ||
            output === null ||
            cachedTokens === null ||
            cacheWrite === null ||
            reasoningTokens === null ||
            reasoningTokens > output
          )
            continue;
          if (input + output + cachedTokens + cacheWrite === 0) continue;
          entries.push({
            sessionId,
            source: TOOL_ID,
            model:
              typeof data?.message?.source?.model === "string" &&
              data.message.source.model
                ? data.message.source.model
                : "unknown",
            project,
            timestamp,
            // DSH input is uncached. Include cache creation in input; reasoning
            // is a subset of output, so split it out without inflating totals.
            inputTokens: input + cacheWrite,
            outputTokens: output - reasoningTokens,
            cachedTokens,
            reasoningTokens,
          });
        }
      } catch (error) {
        console.warn(
          `Skipping DeepSeek Harness session ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return {
      buckets: aggregateToBuckets(entries),
      sessions: extractSessions(events, entries),
    };
  }

  isInstalled(): boolean {
    return existsSync(this.dataDir);
  }
}

registerParser(new DeepSeekHarnessParser());
