import { describe, expect, it } from "vitest";
import {
  buildTorrentVideoPath,
  isTorrentVideoPath,
  parseTorrentVideoPath,
} from "../torrentPath";

describe("torrentPath", () => {
  describe("isTorrentVideoPath", () => {
    it("matches the torrent: scheme only", () => {
      expect(isTorrentVideoPath("torrent:abc/0")).toBe(true);
      expect(isTorrentVideoPath("cloud:x")).toBe(false);
      expect(isTorrentVideoPath("mount:/x")).toBe(false);
      expect(isTorrentVideoPath("/videos/x.mp4")).toBe(false);
      expect(isTorrentVideoPath(null)).toBe(false);
      expect(isTorrentVideoPath(undefined)).toBe(false);
    });
  });

  describe("buildTorrentVideoPath", () => {
    it("builds torrent:<hash>/<fileId>", () => {
      expect(buildTorrentVideoPath("deadbeef", 6)).toBe("torrent:deadbeef/6");
    });
  });

  describe("parseTorrentVideoPath", () => {
    it("round-trips a built path", () => {
      const built = buildTorrentVideoPath("deadbeef", 6);
      expect(parseTorrentVideoPath(built)).toEqual({
        hash: "deadbeef",
        fileId: 6,
      });
    });

    it("keeps the full hash when it is the last slash that splits off the id", () => {
      // Hashes never contain a slash in practice, but guard the parser anyway.
      expect(parseTorrentVideoPath("torrent:aa/bb/3")).toEqual({
        hash: "aa/bb",
        fileId: 3,
      });
    });

    it("rejects malformed paths", () => {
      expect(parseTorrentVideoPath("torrent:")).toBeNull();
      expect(parseTorrentVideoPath("torrent:hashonly")).toBeNull();
      expect(parseTorrentVideoPath("torrent:hash/")).toBeNull();
      expect(parseTorrentVideoPath("torrent:/0")).toBeNull();
      expect(parseTorrentVideoPath("torrent:hash/notanumber")).toBeNull();
      expect(parseTorrentVideoPath("torrent:hash/-1")).toBeNull();
      expect(parseTorrentVideoPath("cloud:hash/0")).toBeNull();
      expect(parseTorrentVideoPath(null)).toBeNull();
    });
  });
});
