import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { SessionEvent, TokenUsageEntry } from "../domain/types";

const DEFAULT_ETA_DIR = join(homedir(), ".eta");

export const ETA_LABEL_PREFIX = "eta: ";

export function resolveEtaDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TOKEN_ARENA_ETA_DIR?.trim();
  if (!override) return DEFAULT_ETA_DIR;
  if (override === "~") return homedir();
  if (override.startsWith("~/")) return join(homedir(), override.slice(2));
  return override;
}

interface EtaMeta {
  title?: unknown;
  agentId?: unknown;
  runtimeSession?: unknown;
}

function findSessionMetaFiles(dir: string): string[] {
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
      results.push(...findSessionMetaFiles(join(dir, entry.name)));
    }
  }

  return results;
}

function asNonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function buildEtaRuntimeSessionMap(
  etaDir: string = resolveEtaDir(),
): Map<string, string> {
  const map = new Map<string, string>();

  for (const metaPath of findSessionMetaFiles(etaDir)) {
    let meta: EtaMeta;
    try {
      const parsed: unknown = JSON.parse(readFileSync(metaPath, "utf-8"));
      if (!parsed || typeof parsed !== "object") continue;
      meta = parsed as EtaMeta;
    } catch {
      continue;
    }

    const runtimeSession = asNonEmptyString(meta.runtimeSession);
    if (!runtimeSession) continue;

    const label =
      asNonEmptyString(meta.title) || asNonEmptyString(meta.agentId);
    if (!label) continue;

    map.set(runtimeSession, label);
  }

  return map;
}

export function applyEtaSessionLabels(
  entries: TokenUsageEntry[],
  events: SessionEvent[],
  labels: ReadonlyMap<string, string>,
): void {
  for (const entry of entries) {
    const label = entry.sessionId ? labels.get(entry.sessionId) : undefined;
    if (label) entry.project = `${ETA_LABEL_PREFIX}${label}`;
  }
  for (const event of events) {
    const label = labels.get(event.sessionId);
    if (label) event.project = `${ETA_LABEL_PREFIX}${label}`;
  }
}
