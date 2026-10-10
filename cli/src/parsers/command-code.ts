import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { aggregateToBuckets } from "../domain/aggregator";
import { extractSessions } from "../domain/session-extractor";
import type {
  ParseResult,
  SessionEvent,
  TokenUsageEntry,
} from "../domain/types";
import {
  extractProjectFromPath,
  findJsonlFiles,
  parseJsonl,
  readFileSafe,
} from "../infrastructure/fs/utils";
import { registerParser } from "./registry";
import type { IParser, ToolDefinition } from "./types";

const TOOL_ID = "command-code";
const DEFAULT_DATA_DIR = join(homedir(), ".commandcode", "projects");

interface CommandCodeEvent {
  type?: string;
  id?: string;
  timestamp?: string;
  cwd?: string;
  parentSession?: string;
  model?: string;
  message?: { role?: string };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
  };
}

function count(value: unknown): number | null {
  if (value === undefined) return 0;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function readHeader(filePath: string): CommandCodeEvent | undefined {
  const content = readFileSafe(filePath);
  if (!content) return;
  // Index only headers; retain neither messages nor whole logs between files.
  let start = 0;
  while (start < content.length) {
    const end = content.indexOf("\n", start);
    const line = content.slice(start, end === -1 ? undefined : end);
    try {
      const row = JSON.parse(line) as CommandCodeEvent | null;
      if (row && row.type === "session") return row;
    } catch {
      // Truncated or malformed lines do not hide a later valid header.
    }
    if (end === -1) break;
    start = end + 1;
  }
}

function indexSessions(dataDir: string) {
  const headers = new Map<string, CommandCodeEvent | undefined>();
  const filesById = new Map<string, string>();
  for (const file of findJsonlFiles(dataDir).sort()) {
    if (file.endsWith(".checkpoints.jsonl")) continue;
    const path = resolve(file);
    const header = readHeader(path);
    headers.set(path, header);
    if (typeof header?.id === "string" && header.id)
      filesById.set(header.id, path);
  }

  const parents = new Map<string, string>();
  const families = new Map<string, string>();
  function family(path: string): string {
    let root = path;
    while (families.has(root)) root = families.get(root) as string;
    while (families.has(path)) {
      const next = families.get(path) as string;
      families.set(path, root);
      path = next;
    }
    return root;
  }
  for (const [path, header] of headers) {
    if (typeof header?.parentSession !== "string" || !header.parentSession)
      continue;
    const parent =
      filesById.get(header.parentSession) ||
      resolve(dirname(path), header.parentSession);
    parents.set(path, parent);
    const childRoot = family(path);
    const parentRoot = family(parent);
    if (childRoot !== parentRoot) families.set(childRoot, parentRoot);
  }

  // Follow parent references before parsing descendants, even if filenames sort
  // the other way. Missing references and cycles terminate at the visited set.
  const order: string[] = [];
  const visited = new Set<string>();
  for (const path of headers.keys()) {
    const chain: string[] = [];
    let current: string | undefined = path;
    while (current && headers.has(current) && !visited.has(current)) {
      visited.add(current);
      chain.push(current);
      current = parents.get(current);
    }
    for (let index = chain.length - 1; index >= 0; index--)
      order.push(chain[index]);
  }
  return { headers, order, family };
}

/** Command Code persists usage on the message envelope, alongside its model. */
export class CommandCodeParser implements IParser {
  readonly tool: ToolDefinition;

  constructor(private readonly dataDir = DEFAULT_DATA_DIR) {
    this.tool = { id: TOOL_ID, name: "Command Code", dataDir };
  }

  async parse(): Promise<ParseResult> {
    const entries: TokenUsageEntry[] = [];
    const events: SessionEvent[] = [];
    const seenByFamily = new Map<string, Set<string>>();
    const { headers, order, family } = indexSessions(this.dataDir);

    for (const filePath of order) {
      const content = readFileSafe(filePath);
      if (!content) continue;
      const rows = parseJsonl<CommandCodeEvent | null>(content).filter(
        (row): row is CommandCodeEvent =>
          row !== null && typeof row === "object",
      );
      const header = headers.get(filePath);
      const familyId = family(filePath);
      let seenMessages = seenByFamily.get(familyId);
      if (!seenMessages) {
        seenMessages = new Set<string>();
        seenByFamily.set(familyId, seenMessages);
      }
      const sessionId =
        typeof header?.id === "string" && header.id ? header.id : filePath;
      const project =
        typeof header?.cwd === "string" && header.cwd
          ? basename(header.cwd.replace(/\\/g, "/").replace(/\/+$/, "")) ||
            "unknown"
          : extractProjectFromPath(filePath, this.dataDir);
      let model = "unknown";

      for (const row of rows) {
        if (
          row.type === "model_change" &&
          typeof row.model === "string" &&
          row.model
        )
          model = row.model;
        if (row.type !== "message" || !row.timestamp) continue;
        const role = row.message?.role;
        if (role !== "user" && role !== "assistant") continue;
        const timestamp = new Date(row.timestamp);
        if (Number.isNaN(timestamp.getTime())) continue;
        // Eight-hex IDs are only unique within a session. Forks copy entries
        // while rewriting parentId; compare complete records within that family
        // so both unrelated sessions and new requests with colliding IDs count.
        if (row.id) {
          const identity = createHash("sha256")
            .update(JSON.stringify({ ...row, parentId: undefined }))
            .digest("hex");
          if (seenMessages.has(identity)) continue;
          seenMessages.add(identity);
        }
        events.push({ sessionId, source: TOOL_ID, project, timestamp, role });
        if (role !== "assistant" || !row.usage) continue;

        const input = count(row.usage.inputTokens);
        const outputTokens = count(row.usage.outputTokens);
        const cachedTokens = count(row.usage.cacheReadTokens);
        if (input === null || outputTokens === null || cachedTokens === null)
          continue;
        if (cachedTokens > input || input + outputTokens === 0) continue;
        entries.push({
          sessionId,
          source: TOOL_ID,
          model: typeof row.model === "string" && row.model ? row.model : model,
          project,
          timestamp,
          // Input includes cache reads and writes. Keep writes in input because
          // TokenArena has no separate cache-write category; subtract reads once.
          inputTokens: input - cachedTokens,
          outputTokens,
          cachedTokens,
          reasoningTokens: 0,
        });
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

registerParser(new CommandCodeParser());
