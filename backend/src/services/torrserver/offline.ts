import axios from "axios";
import fs from "fs-extra";
import { VIDEOS_DIR } from "../../config/paths";
import * as storageService from "../storageService";
import {
  createWriteStreamSafe,
  resolveSafePathInDirectories,
  sanitizePathSegment,
} from "../../utils/security";
import { logger } from "../../utils/logger";
import { buildStreamUrl, getAuthHeader, removeTorrent } from "./client";
import { parseTorrentVideoPath } from "./torrentPath";

// Mode B — "download for offline". Streams the selected TorrServer file to
// VIDEOS_DIR (which lives on persistent JuiceFS), converts the library row to an
// ordinary local video, and drops the torrent from TorrServer.
//
// Resumable across VM recycles: the partial file (`<name>.part`) and a small
// JSON sidecar (`<name>.part.json`, carrying the torrent hash/fileId) both live
// on persistent storage. A failed/interrupted download KEEPS them, so
// `resumeInterruptedDownloads()` (run at startup) re-requests the remaining
// bytes via an HTTP Range request and appends. Only an explicit cancel deletes
// them. Progress is tracked in-memory for the download-list UI.

export interface OfflineDownloadProgress {
  videoId: string;
  title: string;
  finalName: string;
  downloadedBytes: number;
  totalBytes: number; // 0 when unknown
  status: "downloading" | "finalizing";
  startedAt: number;
}

interface ActiveDownload extends OfflineDownloadProgress {
  controller: AbortController;
  canceled: boolean;
}

// Durable resume marker written next to the `.part` file.
interface DownloadSidecar {
  videoId: string;
  hash: string;
  fileId: number;
  finalName: string;
  videoFilename?: string;
}

const active = new Map<string, ActiveDownload>();

export function isOfflineDownloadInProgress(videoId: string): boolean {
  return active.has(videoId);
}

/** Snapshot of in-progress offline downloads for the download-list endpoint. */
export function listOfflineDownloads(): OfflineDownloadProgress[] {
  return [...active.values()].map(
    ({ controller: _c, canceled: _k, ...pub }) => pub
  );
}

/** Abort an in-progress offline download; the partial file is discarded. */
export function cancelOfflineDownload(videoId: string): boolean {
  const entry = active.get(videoId);
  if (!entry) {
    return false;
  }
  entry.canceled = true;
  entry.controller.abort();
  return true;
}

/** Pick a safe on-disk filename for the downloaded torrent file. */
const resolveLocalFilename = (
  videoId: string,
  videoFilename?: string
): string => {
  const sanitized = sanitizePathSegment(videoFilename ?? "");
  return sanitized.length > 0 ? sanitized : `${videoId}.mp4`;
};

const sidecarName = (finalName: string): string => `${finalName}.part.json`;

async function writeSidecar(sidecar: DownloadSidecar): Promise<void> {
  const p = resolveSafePathInDirectories(sidecarName(sidecar.finalName), [
    VIDEOS_DIR,
  ]);
  await fs.writeJson(p, sidecar);
}

async function removeArtifacts(
  finalName: string,
  options: { partToo: boolean }
): Promise<void> {
  const names = options.partToo
    ? [sidecarName(finalName), `${finalName}.part`]
    : [sidecarName(finalName)];
  for (const name of names) {
    try {
      await fs.remove(resolveSafePathInDirectories(name, [VIDEOS_DIR]));
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Derive the total file size from an upstream response. On a 206 append the
 * total is the `bytes a-b/total` suffix of Content-Range; on a fresh 200 it is
 * Content-Length. Returns 0 when the server does not advertise a size.
 */
export function parseTotalBytes(
  headers: Record<string, unknown>,
  appending: boolean
): number {
  if (appending) {
    const range = headers["content-range"];
    if (typeof range === "string") {
      const total = Number(range.split("/")[1]);
      if (Number.isFinite(total) && total > 0) {
        return total;
      }
    }
    return 0;
  }
  const len = Number(headers["content-length"]);
  return Number.isFinite(len) && len > 0 ? len : 0;
}

export async function downloadTorrentToLibrary(videoId: string): Promise<void> {
  if (active.has(videoId)) {
    return;
  }
  const video = storageService.getVideoById(videoId);
  if (!video) {
    throw new Error("Video not found");
  }
  const parsed = parseTorrentVideoPath(video.videoPath);
  if (!parsed) {
    throw new Error("Video is not a torrent stream entry");
  }

  const finalName = resolveLocalFilename(videoId, video.videoFilename);
  const partName = `${finalName}.part`;
  const partPath = resolveSafePathInDirectories(partName, [VIDEOS_DIR]);

  const controller = new AbortController();
  const entry: ActiveDownload = {
    videoId,
    title: video.title || finalName,
    finalName,
    downloadedBytes: 0,
    totalBytes: 0,
    status: "downloading",
    startedAt: Date.now(),
    controller,
    canceled: false,
  };
  active.set(videoId, entry);

  try {
    await writeSidecar({
      videoId,
      hash: parsed.hash,
      fileId: parsed.fileId,
      finalName,
      videoFilename: video.videoFilename,
    });

    // Resume from however many bytes already landed on disk.
    let startByte = 0;
    try {
      startByte = (await fs.stat(partPath)).size;
    } catch {
      startByte = 0;
    }
    entry.downloadedBytes = startByte;

    const url = buildStreamUrl(parsed.hash, parsed.fileId, video.videoFilename);
    const response = await axios.get(url, {
      responseType: "stream",
      timeout: 0,
      signal: controller.signal,
      headers: {
        ...getAuthHeader(),
        ...(startByte > 0 ? { Range: `bytes=${startByte}-` } : {}),
      },
      validateStatus: (status) => status >= 200 && status < 300,
    });

    // 206 honours our Range (append); a 200 means the server ignored it, so
    // restart from scratch to avoid a corrupt file.
    const appending = response.status === 206 && startByte > 0;
    if (!appending) {
      startByte = 0;
      entry.downloadedBytes = 0;
    }
    entry.totalBytes = parseTotalBytes(
      response.headers as Record<string, unknown>,
      appending
    );

    await new Promise<void>((resolve, reject) => {
      const writeStream = createWriteStreamSafe(partName, VIDEOS_DIR, {
        flags: appending ? "a" : "w",
      });
      const upstream = response.data as NodeJS.ReadableStream;
      upstream.on("data", (chunk: Buffer) => {
        entry.downloadedBytes += chunk.length;
      });
      upstream.on("error", reject);
      writeStream.on("error", reject);
      writeStream.on("finish", () => resolve());
      upstream.pipe(writeStream);
    });

    entry.status = "finalizing";
    const finalPath = resolveSafePathInDirectories(finalName, [VIDEOS_DIR]);
    await fs.move(partPath, finalPath, { overwrite: true });

    // Convert to an ordinary local video; keep source="torrent" to record origin.
    storageService.updateVideo(videoId, {
      videoPath: `/videos/${finalName}`,
      videoFilename: finalName,
    });
    await removeArtifacts(finalName, { partToo: false });
    await removeTorrent(parsed.hash);
    logger.info(
      `[TorrServer] Offline download complete for video ${videoId} -> /videos/${finalName}`
    );
  } catch (error) {
    if (entry.canceled) {
      // Explicit cancel: discard partial + sidecar so a retry starts clean.
      await removeArtifacts(finalName, { partToo: true });
      logger.info(
        `[TorrServer] Offline download canceled for video ${videoId}`
      );
      return;
    }
    // Interruption/failure: KEEP the partial file + sidecar so the next startup
    // (or a manual retry) resumes from where it stopped.
    logger.error(
      `[TorrServer] Offline download failed for video ${videoId} (will resume)`,
      error instanceof Error ? error : new Error(String(error))
    );
    throw error;
  } finally {
    active.delete(videoId);
  }
}

/**
 * Resume any offline downloads interrupted by a restart/VM recycle. Scans
 * VIDEOS_DIR for resume sidecars and re-triggers each one. Best-effort: runs in
 * the background and tolerates TorrServer not yet being reachable (the download
 * errors, keeps its sidecar, and the next startup retries).
 */
export async function resumeInterruptedDownloads(): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(VIDEOS_DIR);
  } catch {
    return;
  }

  for (const name of entries.filter((f) => f.endsWith(".part.json"))) {
    try {
      const sidecar: DownloadSidecar = await fs.readJson(
        resolveSafePathInDirectories(name, [VIDEOS_DIR])
      );
      const video = storageService.getVideoById(sidecar.videoId);
      if (!video || !parseTorrentVideoPath(video.videoPath)) {
        // Video gone or already finalized: drop the stray marker.
        await removeArtifacts(sidecar.finalName, { partToo: true });
        continue;
      }
      logger.info(
        `[TorrServer] Resuming interrupted offline download for video ${sidecar.videoId}`
      );
      void downloadTorrentToLibrary(sidecar.videoId).catch(() => {
        // Errors are logged inside the service; sidecar is kept for next retry.
      });
    } catch {
      // Malformed sidecar: ignore (leave it for manual inspection).
    }
  }
}
