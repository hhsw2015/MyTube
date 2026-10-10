import { beforeEach, describe, expect, it, vi } from "vitest";

const getSettings = vi.fn();

vi.mock("../../storageService", () => ({
  getSettings: () => getSettings(),
}));

vi.mock("../../../utils/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { buildStreamUrl, isTorrServerEnabled } from "../client";

describe("torrserver client", () => {
  beforeEach(() => {
    getSettings.mockReset();
  });

  describe("buildStreamUrl", () => {
    it("builds a stream URL with link + index + play and a trailing-slash-stripped base", () => {
      getSettings.mockReturnValue({
        torrServerEnabled: true,
        torrServerBaseUrl: "http://torrserver:8090/",
      });
      expect(buildStreamUrl("deadbeef", 6, "Sintel.mp4")).toBe(
        "http://torrserver:8090/stream/Sintel.mp4?link=deadbeef&index=6&play"
      );
    });

    it("falls back to a cosmetic filename when none is given", () => {
      getSettings.mockReturnValue({
        torrServerEnabled: true,
        torrServerBaseUrl: "http://torrserver:8090",
      });
      expect(buildStreamUrl("abc", 0)).toBe(
        "http://torrserver:8090/stream/file?link=abc&index=0&play"
      );
    });

    it("throws when TorrServer is not configured", () => {
      getSettings.mockReturnValue({ torrServerEnabled: false });
      expect(() => buildStreamUrl("abc", 0)).toThrow(/not enabled/i);
    });

    it("throws on a non-http base URL", () => {
      getSettings.mockReturnValue({
        torrServerEnabled: true,
        torrServerBaseUrl: "ftp://torrserver:8090",
      });
      expect(() => buildStreamUrl("abc", 0)).toThrow(/Invalid TorrServer base URL/);
    });
  });

  describe("isTorrServerEnabled", () => {
    it("is false without a base URL", () => {
      getSettings.mockReturnValue({ torrServerEnabled: true, torrServerBaseUrl: "" });
      expect(isTorrServerEnabled()).toBe(false);
    });

    it("is true when enabled with a base URL", () => {
      getSettings.mockReturnValue({
        torrServerEnabled: true,
        torrServerBaseUrl: "http://torrserver:8090",
      });
      expect(isTorrServerEnabled()).toBe(true);
    });
  });
});
