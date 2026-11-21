import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { aggregateToBuckets } from "../domain/aggregator";
import { extractSessions } from "../domain/session-extractor";
import type {
  ParseResult,
  SessionEvent,
  TokenUsageEntry,
} from "../domain/types";
import { findJsonlFiles, readFileSafe } from "../infrastructure/fs/utils";
import { registerParser } from "./registry";
import type { IParser, ToolDefinition } from "./types";

const DEFAULT_ETA_DIR = join(homedir(), ".eta");

const TOOL: ToolDefinition = {
  id: "eta",
  name: "Eta",
  dataDir: DEFAULT_ETA_DIR,
};

interface EtaCost {
  total?: number;
}

interface EtaUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: EtaCost;
}

interface EtaUsageRow {
  id?: string;
  entryId?: string;
  usage?: EtaUsage;
  timestamp?: string | number;
  time?: string | number;
  createdAt?: string | number;
  created?: string | number;
}

interface EtaJournalLine {
  kind?: string;
  row?: EtaUsageRow;
  timestamp?: string | number;
  time?: string | number;
  createdAt?: string | number;
  created?: string | number;
  t?: string | number;
}

interface EtaMeta {
  id?: string;
  title?: string;
  agentId?: string;
  model?: string | { id?: string; modelId?: string; name?: string };
  createdAt?: string | number;
  cwd?: string;
  conversationId?: string;
  runtime?: string;
  runtimeSession?: string;
}

function getEtaDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TOKEN_ARENA_ETA_DIR?.trim();
  if (!override) return DEFAULT_ETA_DIR;
  if (override === "~") return homedir();
  if (override.startsWith("~/")) return join(homedir(), override.slice(2));
  return override;
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date =
    typeof value === "number" ? new Date(value) : new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toTokenCount(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.trunc(number);
}

function extractTimestamp(
  line: EtaJournalLine,
  row: EtaUsageRow | undefined,
  metaDate: Date | null,
): Date | null {
  const candidates = [
    row?.timestamp,
    row?.time,
    row?.createdAt,
    row?.created,
    line.timestamp,
    line.time,
    line.createdAt,
    line.created,
    line.t,
  ];
  for (const candidate of candidates) {
    const date = toDate(candidate);
    if (date) return date;
  }
  return metaDate;
}

function extractModel(meta: EtaMeta): string {
  const model = meta.model;
  if (typeof model === "string") return model || "unknown";
  if (model && typeof model === "object") {
    return model.id || model.modelId || model.name || "unknown";
  }
  return "unknown";
}

function extractProject(meta: EtaMeta): string {
  return meta.title || meta.agentId || "unknown";
}

function readMeta(journalPath: string): EtaMeta {
  const content = readFileSafe(join(dirname(journalPath), "meta.json"));
  if (!content) return {};
  try {
    const meta = JSON.parse(content) as EtaMeta;
    return meta && typeof meta === "object" ? meta : {};
  } catch {
    return {};
  }
}

export class EtaParser implements IParser {
  readonly tool = TOOL;

  constructor(
    private readonly etaDir: string | (() => string) = () => getEtaDir(),
  ) {}

  private getEtaRoot(): string {
    return typeof this.etaDir === "function" ? this.etaDir() : this.etaDir;
  }

  async parse(): Promise<ParseResult> {
    const entries: TokenUsageEntry[] = [];
    const sessionEvents: SessionEvent[] = [];
    const seenSessionIds = new Set<string>();

    const journalFiles = findJsonlFiles(this.getEtaRoot()).filter(
      (file) => basename(file) === "journal.jsonl",
    );

    for (const journalPath of journalFiles) {
      const sessionId = basename(dirname(journalPath));
      if (seenSessionIds.has(sessionId)) continue;
      seenSessionIds.add(sessionId);

      const meta = readMeta(journalPath);
      const metaDate = toDate(meta.createdAt);
      const model = extractModel(meta);
      const project = extractProject(meta);
      const content = readFileSafe(journalPath);
      if (!content) continue;

      for (const line of content.split("\n")) {
        if (!line.trim()) continue;

        let obj: EtaJournalLine;
        try {
          obj = JSON.parse(line) as EtaJournalLine;
        } catch {
          continue;
        }
        if (obj?.kind !== "usage") continue;

        const row = obj.row;
        const usage = row?.usage;
        if (!usage || typeof usage !== "object") continue;

        const totalTokens = Number(usage.totalTokens) || 0;
        const costTotal = Number(usage.cost?.total) || 0;
        // runtime=opencode 的 ACP 会话在 journal 里 usage 全为 0，真实 token 记在
        // ~/.local/share/opencode/opencode.db 的 session 表（tokens_input/output/reasoning, cost）。
        // 这里跳过 totalTokens 与 cost.total 同时为 0 的行，避免与 opencode 采集器重复计数。
        if (totalTokens === 0 && costTotal === 0) continue;

        // 日期取该 usage 行自身的时间戳；+08:00 时区偏移由上传侧统一处理，这里不自行构造。
        const timestamp = extractTimestamp(obj, row, metaDate);
        if (!timestamp) continue;

        const inputTokens = toTokenCount(usage.input);
        const outputTokens = toTokenCount(usage.output);
        const cachedTokens =
          toTokenCount(usage.cacheRead) + toTokenCount(usage.cacheWrite);

        entries.push({
          sessionId,
          source: "eta",
          model,
          project,
          timestamp,
          inputTokens,
          outputTokens,
          reasoningTokens: 0,
          cachedTokens,
        });
        sessionEvents.push({
          sessionId,
          source: "eta",
          project,
          timestamp,
          role: "assistant",
        });
      }
    }

    return {
      buckets: aggregateToBuckets(entries),
      sessions: extractSessions(sessionEvents, entries),
    };
  }

  isInstalled(): boolean {
    return existsSync(this.getEtaRoot());
  }
}

registerParser(new EtaParser());
