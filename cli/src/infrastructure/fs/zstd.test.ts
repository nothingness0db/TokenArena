import { describe, expect, it } from "vitest";
import { decodeZstdFrames } from "./zstd";

// A standards-compliant Zstandard frame with one raw block; no compressor needed.
function rawZstd(text: string): Buffer {
  const body = Buffer.from(text);
  const header = Buffer.from([
    0x28,
    0xb5,
    0x2f,
    0xfd,
    0x20,
    body.length,
    0,
    0,
    0,
  ]);
  header.writeUIntLE((body.length << 3) | 1, 6, 3);
  return Buffer.concat([header, body]);
}

describe("decodeZstdFrames", () => {
  it("decodes every appended frame and ignores a torn final frame", () => {
    const first = rawZstd("header\n");
    const second = rawZstd("events\n");
    const partial = rawZstd("unfinished\n").subarray(0, 12);
    expect(
      decodeZstdFrames(Buffer.concat([first, second, partial]), (frame) =>
        frame.subarray(9),
      ),
    ).toBe("header\nevents\n");
  });

  it("handles a checksum, RLE block and multi-block frame", () => {
    const checksumFrame = Buffer.concat([rawZstd("a"), Buffer.alloc(4)]);
    checksumFrame[4] |= 4;
    expect(decodeZstdFrames(checksumFrame, () => Buffer.from("a"))).toBe("a");
    const rle = rawZstd("x");
    rle.writeUIntLE((1 << 3) | 3, 6, 3);
    expect(decodeZstdFrames(rle, () => Buffer.from("x"))).toBe("x");
    const multiBlock = rawZstd("x");
    multiBlock[6] &= ~1;
    const secondBlock = rawZstd("y").subarray(6);
    expect(
      decodeZstdFrames(Buffer.concat([multiBlock, secondBlock]), () =>
        Buffer.from("xy"),
      ),
    ).toBe("xy");
  });

  it("returns only complete frames for every possible truncated suffix", () => {
    const prefix = rawZstd("first");
    const next = rawZstd("next");
    for (let i = 0; i < next.length; i++) {
      expect(
        decodeZstdFrames(Buffer.concat([prefix, next.subarray(0, i)]), () =>
          Buffer.from("first"),
        ),
      ).toBe("first");
    }
    const checksum = Buffer.concat([next, Buffer.alloc(4)]);
    checksum[4] |= 4;
    expect(
      decodeZstdFrames(checksum.subarray(0, -1), () => Buffer.from("next")),
    ).toBe("");
  });

  it("rejects complete corrupt headers and blocks", () => {
    expect(() => decodeZstdFrames(Buffer.alloc(4))).toThrow(
      "Invalid Zstandard frame",
    );
    const badHeader = rawZstd("x");
    badHeader[4] |= 8;
    expect(() => decodeZstdFrames(badHeader)).toThrow("frame header");
    const badBlock = rawZstd("x");
    badBlock[6] |= 6;
    expect(() => decodeZstdFrames(badBlock)).toThrow("block type");
  });
});
