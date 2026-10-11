import { execFileSync } from "node:child_process";
import * as zlib from "node:zlib";

/**
 * Decode concatenated Zstandard frames independently. Node's one-shot API only
 * returns the first frame; DSH appends a separate frame for each event batch.
 * Ignore an incomplete last frame while the application is writing the log.
 */
export function decodeZstdFrames(
  data: Buffer,
  decode: (frame: Buffer) => Buffer = decodeFrame,
): string {
  const result: Buffer[] = [];
  let offset = 0;
  const requireBytes = (length: number) => offset + length <= data.length;

  while (offset < data.length) {
    const start = offset;
    if (!requireBytes(4)) break;
    if (data.readUInt32LE(offset) !== 0xfd2fb528)
      throw new Error(`Invalid Zstandard frame at byte ${offset}`);
    offset += 4;
    if (!requireBytes(1)) break;
    const descriptor = data[offset++];
    if (descriptor & 0x18) throw new Error("Invalid Zstandard frame header");
    const singleSegment = Boolean(descriptor & 0x20);
    const sizeFlag = descriptor >>> 6;
    const dictionaryFlag = descriptor & 3;
    const headerSize =
      (singleSegment ? 0 : 1) +
      (dictionaryFlag === 3 ? 4 : dictionaryFlag) +
      (sizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << sizeFlag);
    if (!requireBytes(headerSize)) break;
    offset += headerSize;
    let complete = false;
    while (requireBytes(3)) {
      const block = data.readUIntLE(offset, 3);
      offset += 3;
      const type = (block >>> 1) & 3;
      if (type === 3) throw new Error("Invalid Zstandard block type");
      const size = type === 1 ? 1 : block >>> 3;
      if (!requireBytes(size)) break;
      offset += size;
      if (block & 1) {
        complete = true;
        break;
      }
    }
    if (!complete) break;
    if (descriptor & 4) {
      if (!requireBytes(4)) break;
      offset += 4;
    }
    result.push(decode(data.subarray(start, offset)));
  }
  return Buffer.concat(result).toString("utf-8");
}

function decodeFrame(frame: Buffer): Buffer {
  // Keep Node 20 compatibility without importing an unavailable named export.
  if (typeof zlib.zstdDecompressSync === "function") {
    return zlib.zstdDecompressSync(frame);
  }
  try {
    return execFileSync("zstd", ["-d", "-q", "-c"], {
      input: frame,
      maxBuffer: 100 * 1024 * 1024,
      timeout: 30000,
      windowsHide: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "DeepSeek Harness compressed logs require Node 22.15+ / 23.8+ with Zstandard support, or the zstd CLI on PATH.",
      );
    }
    throw error;
  }
}
