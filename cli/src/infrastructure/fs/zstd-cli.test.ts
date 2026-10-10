import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeZstdFrames } from "./zstd";

vi.mock("node:zlib", () => ({ zstdDecompressSync: undefined }));
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

// One single-segment frame, containing one raw 'x' byte.
const frame = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 1, 9, 0, 0, 0x78]);

beforeEach(() => {
  vi.mocked(execFileSync).mockReset();
});

describe("Zstandard CLI fallback on older Node versions", () => {
  it("passes compressed bytes to zstd without a shell", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from("x"));
    expect(decodeZstdFrames(frame)).toBe("x");
    expect(execFileSync).toHaveBeenCalledWith("zstd", ["-d", "-q", "-c"], {
      input: frame,
      maxBuffer: 100 * 1024 * 1024,
      timeout: 30000,
      windowsHide: true,
    });
  });

  it("explains the missing runtime requirement", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });
    expect(() => decodeZstdFrames(frame)).toThrow("zstd CLI on PATH");
  });

  it("propagates decompression failures", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("bad checksum");
    });
    expect(() => decodeZstdFrames(frame)).toThrow("bad checksum");
  });
});
