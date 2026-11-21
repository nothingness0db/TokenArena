import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent, TokenUsageEntry } from "../domain/types";
import {
  applyEtaSessionLabels,
  buildEtaRuntimeSessionMap,
  ETA_LABEL_PREFIX,
  resolveEtaDir,
} from "./eta-session-map";

const roots: string[] = [];

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokenarena-eta-map-"));
  roots.push(dir);
  return dir;
}

function writeMeta(etaRoot: string, branch: string, id: string, meta: unknown) {
  const dir = join(etaRoot, branch, "sessions", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta), "utf-8");
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveEtaDir", () => {
  it("defaults to ~/.eta and honors the TOKEN_ARENA_ETA_DIR override", () => {
    expect(resolveEtaDir({})).toBe(join(homedir(), ".eta"));
    expect(resolveEtaDir({ TOKEN_ARENA_ETA_DIR: "  /tmp/eta-custom  " })).toBe(
      "/tmp/eta-custom",
    );
    expect(resolveEtaDir({ TOKEN_ARENA_ETA_DIR: "~" })).toBe(homedir());
    expect(resolveEtaDir({ TOKEN_ARENA_ETA_DIR: "~/sandbox/eta" })).toBe(
      join(homedir(), "sandbox", "eta"),
    );
  });
});

describe("buildEtaRuntimeSessionMap", () => {
  it("maps runtimeSession to title across both sessions roots", () => {
    const etaRoot = root();
    writeMeta(etaRoot, "daemon", "d1", {
      title: "Fix login",
      agentId: "agent-1",
      runtimeSession: "ses_daemon",
    });
    writeMeta(etaRoot, "", "s1", {
      title: "Refactor cache",
      runtimeSession: "ses_plain",
    });

    const map = buildEtaRuntimeSessionMap(etaRoot);
    expect(map.get("ses_daemon")).toBe("Fix login");
    expect(map.get("ses_plain")).toBe("Refactor cache");
  });

  it("falls back to agentId and skips metas without a usable mapping", () => {
    const etaRoot = root();
    writeMeta(etaRoot, "daemon", "a1", {
      agentId: "agent-fallback",
      runtimeSession: "ses_agent",
    });
    writeMeta(etaRoot, "daemon", "a2", {
      title: "no runtime session",
      agentId: "agent-2",
    });
    writeMeta(etaRoot, "daemon", "a3", {
      runtimeSession: "ses_no_label",
    });
    writeMeta(etaRoot, "daemon", "a4", {
      runtimeSession: "   ",
      title: "blank runtime session",
    });
    for (const [id, content] of [
      ["a5", ""],
      ["a6", "42"],
    ]) {
      const dir = join(etaRoot, "daemon", "sessions", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "meta.json"), content, "utf-8");
    }

    const map = buildEtaRuntimeSessionMap(etaRoot);
    expect(map.get("ses_agent")).toBe("agent-fallback");
    expect(map.size).toBe(1);
  });

  it("returns an empty map when the eta directory is absent", () => {
    expect(buildEtaRuntimeSessionMap(join(root(), "missing")).size).toBe(0);
  });
});

describe("applyEtaSessionLabels", () => {
  const entry = (
    sessionId: string | undefined,
    project: string,
  ): TokenUsageEntry => ({
    sessionId,
    source: "opencode",
    model: "gpt-4",
    project,
    timestamp: new Date("2026-01-15T10:00:00.000Z"),
    inputTokens: 1,
    outputTokens: 1,
    reasoningTokens: 0,
    cachedTokens: 0,
  });

  const event = (sessionId: string, project: string): SessionEvent => ({
    sessionId,
    source: "opencode",
    project,
    timestamp: new Date("2026-01-15T10:00:00.000Z"),
    role: "assistant",
  });

  it("prefixes matched sessions and leaves unmatched sessions untouched", () => {
    const entries = [
      entry("ses_hit", "my-project"),
      entry("ses_miss", "my-project"),
    ];
    const events = [
      event("ses_hit", "my-project"),
      event("ses_miss", "my-project"),
    ];

    applyEtaSessionLabels(entries, events, new Map([["ses_hit", "Fix login"]]));

    expect(entries[0].project).toBe(`${ETA_LABEL_PREFIX}Fix login`);
    expect(events[0].project).toBe(`${ETA_LABEL_PREFIX}Fix login`);
    expect(entries[1].project).toBe("my-project");
    expect(events[1].project).toBe("my-project");
  });

  it("ignores entries without a session id", () => {
    const entries = [entry(undefined, "my-project")];
    applyEtaSessionLabels(entries, [], new Map([["ses_hit", "Fix login"]]));
    expect(entries[0].project).toBe("my-project");
  });
});
