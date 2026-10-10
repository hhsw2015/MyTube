import { describe, expect, it, vi } from "vitest";

// parseTotalBytes is pure, but importing offline.ts pulls in storageService
// (native better-sqlite3) and the logger. Mock both so the unit stays isolated.
vi.mock("../../storageService", () => ({}));
vi.mock("../../../utils/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { parseTotalBytes } from "../offline";

describe("parseTotalBytes", () => {
  it("reads the total from Content-Range when appending (206)", () => {
    expect(
      parseTotalBytes({ "content-range": "bytes 500-999/1000" }, true)
    ).toBe(1000);
  });

  it("reads the total from Content-Length on a fresh download (200)", () => {
    expect(parseTotalBytes({ "content-length": "2048" }, false)).toBe(2048);
  });

  it("returns 0 when appending but no Content-Range is present", () => {
    expect(parseTotalBytes({}, true)).toBe(0);
  });

  it("returns 0 for a missing/invalid Content-Length", () => {
    expect(parseTotalBytes({}, false)).toBe(0);
    expect(parseTotalBytes({ "content-length": "nope" }, false)).toBe(0);
  });

  it("ignores Content-Length when appending (uses the range total only)", () => {
    expect(
      parseTotalBytes(
        { "content-length": "500", "content-range": "bytes 500-999/1000" },
        true
      )
    ).toBe(1000);
  });
});
