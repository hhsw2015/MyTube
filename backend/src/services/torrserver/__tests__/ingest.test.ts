import { beforeEach, describe, expect, it, vi } from "vitest";

const getVideoBySourceUrl = vi.fn();
const saveVideo = vi.fn();
const getCollectionByName = vi.fn();
const saveCollection = vi.fn();
const addVideoToCollection = vi.fn();
const addMagnet = vi.fn();
const getTorrent = vi.fn();

vi.mock("../../storageService", () => ({
  getVideoBySourceUrl: (...args: unknown[]) => getVideoBySourceUrl(...args),
  saveVideo: (...args: unknown[]) => saveVideo(...args),
  getCollectionByName: (...args: unknown[]) => getCollectionByName(...args),
  saveCollection: (...args: unknown[]) => saveCollection(...args),
  addVideoToCollection: (...args: unknown[]) => addVideoToCollection(...args),
}));

vi.mock("../client", () => ({
  addMagnet: (...args: unknown[]) => addMagnet(...args),
  getTorrent: (...args: unknown[]) => getTorrent(...args),
  keepTorrentActive: vi.fn(),
}));

vi.mock("../../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  addMagnetFilesToLibrary,
  addMagnetToLibrary,
  inspectMagnet,
} from "../ingest";

const MAGNET = "magnet:?xt=urn:btih:deadbeef";

// Don't actually poll for torrent metadata in tests.
process.env.TORR_META_TIMEOUT_MS = "0";

describe("addMagnetToLibrary", () => {
  beforeEach(() => {
    getVideoBySourceUrl.mockReset();
    saveVideo.mockReset();
    getCollectionByName.mockReset();
    saveCollection.mockReset();
    addVideoToCollection.mockReset();
    addMagnet.mockReset();
    getTorrent.mockReset();
  });

  it("rejects a non-magnet link without touching TorrServer", async () => {
    await expect(addMagnetToLibrary("https://example.com/x")).rejects.toThrow(
      /valid magnet/i
    );
    expect(addMagnet).not.toHaveBeenCalled();
  });

  it("is idempotent: returns the existing video and skips TorrServer", async () => {
    const existing = { id: "v1", title: "old" };
    getVideoBySourceUrl.mockReturnValue(existing);

    const result = await addMagnetToLibrary(MAGNET);

    expect(result).toEqual({ video: existing, created: false });
    expect(addMagnet).not.toHaveBeenCalled();
    expect(saveVideo).not.toHaveBeenCalled();
  });

  it("picks the largest video file and creates a torrent: library row", async () => {
    getVideoBySourceUrl.mockReturnValue(undefined);
    addMagnet.mockResolvedValue("deadbeef");
    getTorrent.mockResolvedValue({
      hash: "deadbeef",
      name: "Sintel",
      files: [
        { id: 2, path: "Sintel/readme.txt", length: 100 },
        { id: 6, path: "Sintel/Sintel.mp4", length: 5_000_000 },
        { id: 7, path: "Sintel/sample.mkv", length: 1_000 },
      ],
    });

    const result = await addMagnetToLibrary(MAGNET);

    expect(result.created).toBe(true);
    expect(result.video.source).toBe("torrent");
    expect(result.video.sourceUrl).toBe(MAGNET);
    expect(result.video.videoPath).toBe("torrent:deadbeef/6");
    expect(result.video.sourceVideoId).toBe("deadbeef/6");
    expect(result.video.fileSize).toBe("5000000");
    expect(result.video.mediaType).toBe("video");
    expect(saveVideo).toHaveBeenCalledTimes(1);
  });

  it("throws when the torrent has no files", async () => {
    getVideoBySourceUrl.mockReturnValue(undefined);
    addMagnet.mockResolvedValue("deadbeef");
    getTorrent.mockResolvedValue({ hash: "deadbeef", name: "empty", files: [] });

    await expect(addMagnetToLibrary(MAGNET)).rejects.toThrow(/no files/i);
    expect(saveVideo).not.toHaveBeenCalled();
  });
});

describe("inspectMagnet", () => {
  beforeEach(() => {
    addMagnet.mockReset();
    getTorrent.mockReset();
  });

  it("returns video files sorted largest-first, no rows created", async () => {
    addMagnet.mockResolvedValue("deadbeef");
    getTorrent.mockResolvedValue({
      hash: "deadbeef",
      name: "Pack",
      files: [
        { id: 0, path: "ep1.mp4", length: 10 },
        { id: 1, path: "notes.txt", length: 999 },
        { id: 2, path: "ep2.mp4", length: 50 },
      ],
    });

    const result = await inspectMagnet(MAGNET);

    expect(result.hash).toBe("deadbeef");
    expect(result.files.map((f) => f.id)).toEqual([2, 0]); // video files, largest first
    expect(saveVideo).not.toHaveBeenCalled();
  });

  it("rejects a non-magnet link", async () => {
    await expect(inspectMagnet("http://x")).rejects.toThrow(/valid magnet/i);
  });
});

describe("addMagnetFilesToLibrary", () => {
  beforeEach(() => {
    getVideoBySourceUrl.mockReset();
    saveVideo.mockReset();
    getCollectionByName.mockReset();
    saveCollection.mockReset();
    addVideoToCollection.mockReset();
    addMagnet.mockReset();
    getTorrent.mockReset();
  });

  const twoEpisodeTorrent = {
    hash: "deadbeef",
    name: "Show S01",
    files: [
      { id: 0, path: "Show/S01E01.mkv", length: 100 },
      { id: 1, path: "Show/S01E02.mkv", length: 200 },
      { id: 2, path: "Show/extra.txt", length: 5 },
    ],
  };

  it("adds multiple files and groups them into a collection", async () => {
    getVideoBySourceUrl.mockReturnValue(undefined);
    addMagnet.mockResolvedValue("deadbeef");
    getTorrent.mockResolvedValue(twoEpisodeTorrent);
    getCollectionByName.mockReturnValue(undefined);
    saveCollection.mockImplementation((c: { id: string }) => c);

    const result = await addMagnetFilesToLibrary(MAGNET, [0, 1]);

    expect(result.created).toBe(2);
    expect(result.collectionId).toBeTruthy();
    expect(saveVideo).toHaveBeenCalledTimes(2);
    expect(saveCollection).toHaveBeenCalledTimes(1);
    expect(addVideoToCollection).toHaveBeenCalledTimes(2);
    // Per-file sourceUrl for multi-file dedup.
    expect(result.videos[0].sourceUrl).toBe(`${MAGNET}#file=0`);
    expect(result.videos[0].videoPath).toBe("torrent:deadbeef/0");
  });

  it("adds a single selected file with the bare magnet and no collection", async () => {
    getVideoBySourceUrl.mockReturnValue(undefined);
    addMagnet.mockResolvedValue("deadbeef");
    getTorrent.mockResolvedValue(twoEpisodeTorrent);

    const result = await addMagnetFilesToLibrary(MAGNET, [1]);

    expect(result.created).toBe(1);
    expect(result.collectionId).toBeNull();
    expect(result.videos[0].sourceUrl).toBe(MAGNET);
    expect(saveCollection).not.toHaveBeenCalled();
  });

  it("throws when no files are selected", async () => {
    await expect(addMagnetFilesToLibrary(MAGNET, [])).rejects.toThrow(
      /no files selected/i
    );
  });
});
