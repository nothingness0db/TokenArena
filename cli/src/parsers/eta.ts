import { execFileSync } from "node:child_process";
import { type Dirent, existsSync, readdirSync } from "node:fs";
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
const SQLITE_DB_NAME = "eta.sqlite";

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

type SqlRow = Record<string, unknown>;
type UsageRowReader = (dbPath: string) => Promise<SqlRow[]>;

interface EtaSessionInfo {
  model: string;
  project: string;
  createdAt: Date | null;
}

interface NormalizedUsage {
  sessionId: string;
  model: string;
  input: number;
  output: number;
  reasoning: number;
  cached: number;
  total: number;
  cost: number;
  timestamp: Date | null;
}

const SESSION_KEYS = [
  "sessionId",
  "session_id",
  "session",
  "etaSessionId",
  "eta_session_id",
  "conversationId",
  "conversation_id",
];
const INPUT_KEYS = [
  "input",
  "inputTokens",
  "input_tokens",
  "tokensInput",
  "tokens_input",
  "promptTokens",
  "prompt_tokens",
];
const OUTPUT_KEYS = [
  "output",
  "outputTokens",
  "output_tokens",
  "tokensOutput",
  "tokens_output",
  "completionTokens",
  "completion_tokens",
];
const CACHE_READ_KEYS = [
  "cacheRead",
  "cache_read",
  "cacheReadTokens",
  "cache_read_tokens",
];
const CACHE_WRITE_KEYS = [
  "cacheWrite",
  "cache_write",
  "cacheWriteTokens",
  "cache_write_tokens",
];
const REASONING_KEYS = [
  "reasoning",
  "reasoningTokens",
  "reasoning_tokens",
  "tokensReasoning",
  "tokens_reasoning",
];
const TOTAL_KEYS = ["totalTokens", "total_tokens", "total", "tokensTotal"];
const COST_KEYS = [
  "cost",
  "costTotal",
  "cost_total",
  "totalCost",
  "total_cost",
  "price",
];
const TIMESTAMP_KEYS = [
  "timestamp",
  "createdAt",
  "created_at",
  "created",
  "time",
  "t",
  "date",
  "insertedAt",
  "inserted_at",
  "at",
];
const MODEL_KEYS = [
  "model",
  "modelId",
  "modelID",
  "model_id",
  "modelName",
  "model_name",
];
const BLOB_KEYS = [
  "usage",
  "usageData",
  "usage_json",
  "data",
  "payload",
  "row",
  "json",
  "record",
  "tokens",
];
const SQL_COLUMN_KEYS = [
  ...SESSION_KEYS,
  ...INPUT_KEYS,
  ...OUTPUT_KEYS,
  ...CACHE_READ_KEYS,
  ...CACHE_WRITE_KEYS,
  ...REASONING_KEYS,
  ...TOTAL_KEYS,
  ...COST_KEYS,
  ...TIMESTAMP_KEYS,
  ...MODEL_KEYS,
  ...BLOB_KEYS,
  "id",
];

function getEtaDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TOKEN_ARENA_ETA_DIR?.trim();
  if (!override) return DEFAULT_ETA_DIR;
  if (override === "~") return homedir();
  if (override.startsWith("~/")) return join(homedir(), override.slice(2));
  return override;
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    const date = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return toDate(Number(value));
  }
  const date = new Date(value as string);
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

function normalizeColumn(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function buildLookup(row: Record<string, unknown>): Map<string, unknown> {
  const lookup = new Map<string, unknown>();
  for (const [key, value] of Object.entries(row)) {
    lookup.set(normalizeColumn(key), value);
  }
  return lookup;
}

function pick(lookup: Map<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    const value = lookup.get(normalizeColumn(name));
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeUsageRow(row: SqlRow): NormalizedUsage | null {
  const lookup = buildLookup(row);
  const blob = asObject(pick(lookup, BLOB_KEYS));
  const nested = blob ? asObject(pick(buildLookup(blob), ["usage"])) : null;
  const source = blob ? buildLookup(nested ?? blob) : lookup;

  const input = toTokenCount(pick(source, INPUT_KEYS));
  const output = toTokenCount(pick(source, OUTPUT_KEYS));
  const cacheRead = toTokenCount(pick(source, CACHE_READ_KEYS));
  const cacheWrite = toTokenCount(pick(source, CACHE_WRITE_KEYS));
  const reasoning = toTokenCount(pick(source, REASONING_KEYS));
  const rawTotal = Number(pick(source, TOTAL_KEYS)) || 0;
  const total = rawTotal || input + output + cacheRead + cacheWrite + reasoning;

  const rawCost = pick(source, COST_KEYS);
  const costObject = asObject(rawCost);
  const cost =
    Number(
      costObject
        ? pick(buildLookup(costObject), ["total", "totalCost", "value"])
        : rawCost,
    ) || 0;

  const rawSession = pick(lookup, SESSION_KEYS) ?? pick(source, SESSION_KEYS);
  const sessionId =
    typeof rawSession === "string" || typeof rawSession === "number"
      ? String(rawSession)
      : "unknown";
  const timestamp = toDate(
    pick(lookup, TIMESTAMP_KEYS) ?? pick(source, TIMESTAMP_KEYS),
  );
  const rawModel = pick(source, MODEL_KEYS) ?? pick(lookup, MODEL_KEYS);
  const model =
    typeof rawModel === "string" && rawModel.trim() ? rawModel.trim() : "";

  return {
    sessionId,
    model,
    input,
    output,
    reasoning,
    cached: cacheRead + cacheWrite,
    total,
    cost,
    timestamp,
  };
}

function buildUsageProjection(columns: string[]): string {
  const selected = columns.filter((column) =>
    SQL_COLUMN_KEYS.some(
      (key) => normalizeColumn(key) === normalizeColumn(column),
    ),
  );
  if (selected.length === 0) return "*";
  return selected.map((column) => `"${column.replace(/"/g, '""')}"`).join(", ");
}

function columnNamesFromPragma(rows: SqlRow[]): string[] {
  return rows
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string");
}

async function readUsageRowsWithBuiltin(
  dbPath: string,
): Promise<SqlRow[] | null> {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = ((
    warning: string | Error,
    ...args: unknown[]
  ): void => {
    const warningName =
      typeof warning === "string"
        ? typeof args[0] === "string"
          ? args[0]
          : ""
        : warning.name;
    const warningMessage =
      typeof warning === "string" ? warning : warning.message;
    if (
      warningName === "ExperimentalWarning" &&
      warningMessage.includes("SQLite")
    ) {
      return;
    }
    (
      originalEmitWarning as (
        warning: string | Error,
        ...warningArgs: unknown[]
      ) => void
    ).call(process, warning, ...args);
  }) as typeof process.emitWarning;

  try {
    // 走变量而不是字面量：打包器会把字面量 import("node:sqlite") 的 node: 前缀
    // 抹成 import("sqlite")，安装后运行时报 Cannot find package 'sqlite'。
    const sqliteModuleId = "node:sqlite";
    const sqlite = (await import(sqliteModuleId)) as {
      DatabaseSync: new (
        location: string,
        options?: { readOnly?: boolean },
      ) => {
        close(): void;
        prepare(sql: string): { all(): SqlRow[] };
      };
    };
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      const info = db.prepare("PRAGMA table_info(usage)").all() as SqlRow[];
      const projection = buildUsageProjection(columnNamesFromPragma(info));
      return db.prepare(`SELECT ${projection} FROM usage`).all() as SqlRow[];
    } finally {
      db.close();
    }
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (
      error.code === "ERR_UNKNOWN_BUILTIN_MODULE" ||
      (err as Error).message?.includes("node:sqlite")
    ) {
      return null;
    }
    throw err;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

function readUsageRowsWithCli(dbPath: string): SqlRow[] {
  const candidates = [
    process.env.TOKEN_ARENA_SQLITE3,
    "sqlite3",
    "sqlite3.exe",
  ].filter((value): value is string => Boolean(value));
  let lastError: Error | null = null;

  for (const command of candidates) {
    try {
      const query = (sql: string): string =>
        execFileSync(command, ["-readonly", "-json", dbPath, sql], {
          encoding: "utf-8",
          maxBuffer: 100 * 1024 * 1024,
          timeout: 30000,
          windowsHide: true,
        }).trim();

      const infoOutput = query("PRAGMA table_info(usage)");
      const info =
        infoOutput && infoOutput !== "[]"
          ? (JSON.parse(infoOutput) as SqlRow[])
          : [];
      const projection = buildUsageProjection(columnNamesFromPragma(info));
      const output = query(`SELECT ${projection} FROM usage`);
      if (!output || output === "[]") return [];
      return JSON.parse(output) as SqlRow[];
    } catch (err) {
      lastError = err as Error;
      const nodeError = err as NodeJS.ErrnoException & { status?: number };
      if (nodeError.status === 127 || nodeError.message?.includes("ENOENT")) {
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `sqlite3 CLI not found. Install sqlite3 or set TOKEN_ARENA_SQLITE3. Last error: ${lastError?.message || "not found"}`,
  );
}

async function readUsageRowsFromSqlite(dbPath: string): Promise<SqlRow[]> {
  const rows = await readUsageRowsWithBuiltin(dbPath);
  return rows ?? readUsageRowsWithCli(dbPath);
}

function findMetaFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  if (basename(dirname(dir)) === "sessions") {
    const metaPath = join(dir, "meta.json");
    if (existsSync(metaPath)) results.push(metaPath);
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      results.push(...findMetaFiles(join(dir, entry.name)));
    }
  }
  return results;
}

function buildMetaIndex(etaRoot: string): Map<string, EtaSessionInfo> {
  const index = new Map<string, EtaSessionInfo>();
  for (const metaPath of findMetaFiles(etaRoot)) {
    const content = readFileSafe(metaPath);
    if (!content) continue;
    let meta: EtaMeta;
    try {
      meta = JSON.parse(content) as EtaMeta;
    } catch {
      continue;
    }
    if (!meta || typeof meta !== "object") continue;

    const info: EtaSessionInfo = {
      model: extractModel(meta),
      project: extractProject(meta),
      createdAt: toDate(meta.createdAt),
    };
    const keys = [
      basename(dirname(metaPath)),
      meta.id,
      meta.conversationId,
      meta.runtimeSession,
    ];
    for (const key of keys) {
      if (typeof key === "string" && key && !index.has(key)) {
        index.set(key, info);
      }
    }
  }
  return index;
}

export class EtaParser implements IParser {
  readonly tool = TOOL;

  constructor(
    private readonly etaDir: string | (() => string) = () => getEtaDir(),
    private readonly readUsageRows: UsageRowReader = readUsageRowsFromSqlite,
  ) {}

  private getEtaRoot(): string {
    return typeof this.etaDir === "function" ? this.etaDir() : this.etaDir;
  }

  async parse(): Promise<ParseResult> {
    const etaRoot = this.getEtaRoot();
    const metaIndex = buildMetaIndex(etaRoot);
    const dbPath = join(etaRoot, SQLITE_DB_NAME);
    const entries: TokenUsageEntry[] = [];
    const sessionEvents: SessionEvent[] = [];

    // journal.jsonl 的 usage 行通常是全 0；真正的 token 在 eta.sqlite 的 usage 表里。
    if (existsSync(dbPath)) {
      try {
        const rows = await this.readUsageRows(dbPath);
        this.collectFromSqlite(rows, metaIndex, entries, sessionEvents);
      } catch (err) {
        process.stderr.write(
          `warn: eta sqlite parse failed (${(err as Error).message}), trying journals...\n`,
        );
      }
    }

    if (entries.length === 0) {
      this.collectFromJournals(etaRoot, metaIndex, entries, sessionEvents);
    }

    return {
      buckets: aggregateToBuckets(entries),
      sessions: extractSessions(sessionEvents, entries),
    };
  }

  private collectFromSqlite(
    rows: SqlRow[],
    metaIndex: ReadonlyMap<string, EtaSessionInfo>,
    entries: TokenUsageEntry[],
    sessionEvents: SessionEvent[],
  ): void {
    for (const row of rows) {
      const usage = normalizeUsageRow(row);
      if (!usage) continue;

      // runtime=opencode 的 ACP 会话在 journal/usage 里全为 0，真实 token 记在
      // ~/.local/share/opencode/opencode.db 的 session 表（tokens_input/output/reasoning, cost）。
      // 跳过 totalTokens 与 cost.total 同时为 0 的行，避免与 opencode 采集器重复计数。
      if (usage.total === 0 && usage.cost === 0) continue;

      const meta = metaIndex.get(usage.sessionId);
      // 日期取该 usage 行自身的时间戳；+08:00 时区偏移由上传侧统一处理，这里不自行构造。
      const timestamp = usage.timestamp ?? meta?.createdAt ?? null;
      if (!timestamp) continue;

      const model = usage.model || meta?.model || "unknown";
      const project = meta?.project ?? "unknown";
      entries.push({
        sessionId: usage.sessionId,
        source: "eta",
        model,
        project,
        timestamp,
        inputTokens: usage.input,
        outputTokens: usage.output,
        reasoningTokens: usage.reasoning,
        cachedTokens: usage.cached,
      });
      sessionEvents.push({
        sessionId: usage.sessionId,
        source: "eta",
        project,
        timestamp,
        role: "assistant",
      });
    }
  }

  private collectFromJournals(
    etaRoot: string,
    metaIndex: ReadonlyMap<string, EtaSessionInfo>,
    entries: TokenUsageEntry[],
    sessionEvents: SessionEvent[],
  ): void {
    const journalFiles = findJsonlFiles(etaRoot).filter(
      (file) => basename(file) === "journal.jsonl",
    );
    const seenSessionIds = new Set<string>();

    for (const journalPath of journalFiles) {
      const sessionId = basename(dirname(journalPath));
      if (seenSessionIds.has(sessionId)) continue;
      seenSessionIds.add(sessionId);

      const indexed = metaIndex.get(sessionId);
      const meta: EtaMeta = indexed
        ? {
            title: indexed.project,
            model: indexed.model,
            createdAt: indexed.createdAt?.toISOString(),
          }
        : readMeta(journalPath);
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
  }

  isInstalled(): boolean {
    return existsSync(this.getEtaRoot());
  }
}

registerParser(new EtaParser());
