import axios from "axios";
import fs from "fs-extra";
import { VIDEOS_DIR } from "../../config/paths";
import { ensureFaststartMp4 } from "../../utils/faststart";
import * as storageService from "../storageService";
import type { Video } from "../storageService/types";
import {
  createWriteStreamSafe,
  resolveSafePathInDirectories,
  sanitizePathSegment,
} from "../../utils/security";
import { formatBytes } from "../../utils/downloadUtils";
import { logger } from "../../utils/logger";
import { buildStreamUrl, getAuthHeader, removeTorrent } from "./client";
import { parseTorrentVideoPath } from "./torrentPath";

// Mode B — "download for offline", now a first-class downloadManager task so it
// shows the SAME progress / stop / delete / history as a yt-dlp download (no
// separate torrent list). The task fn streams the TorrServer file to VIDEOS_DIR
// (persistent JuiceFS), reports progress via storageService.updateActiveDownload
// (the manager created the active row), and on completion converts the library
// row from a `torrent:` stream entry into an ordinary local `/videos` file.
//
// Resumable across restarts / VM recycles: the partial `.part` file + a JSON
// sidecar (hash/fileId) persist; a failure KEEPS them so
// resumeInterruptedDownloads() re-enqueues and continues via an HTTP Range
// request. An explicit cancel discards them.

interface DownloadSidecar {
  videoId: string;
  hash: string;
  fileId: number;
  finalName: string;
  videoFilename?: string;
}

const resolveLocalFilename = (
  videoId: string,
  videoFilename?: string
): string => {
  const sanitized = sanitizePathSegment(videoFilename ?? "");
  return sanitized.length > 0 ? sanitized : `${videoId}.mp4`;
};

const sidecarName = (finalName: string): string => `${finalName}.part.json`;

async function writeSidecar(sidecar: DownloadSidecar): Promise<void> {
  await fs.writeJson(
    resolveSafePathInDirectories(sidecarName(sidecar.finalName), [VIDEOS_DIR]),
    sidecar
  );
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
 * Total file size from an upstream response: the `/total` suffix of Content-Range
 * on a 206 resume, else Content-Length on a fresh 200. 0 when not advertised.
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

/**
 * downloadManager task fn: download the torrent's file to disk with live
 * progress, cancellation, and resume. Resolves `{ success, video }` on
 * completion; throws on failure (KEEP the partial for resume) or on cancel
 * (DISCARD the partial, keep the still-streamable library row).
 */
export async function downloadTorrentTask(
  videoId: string,
  registerCancel: (cancel: () => void) => void
): Promise<{ success: boolean; video: Video | undefined }> {
  const video = storageService.getVideoById(videoId);
  if (!video) {
    throw new Error("Video not found");
  }
  const parsed = parseTorrentVideoPath(video.videoPath);
  if (!parsed) {
    // Already converted to a local file by a previous run — nothing to do.
    return { success: true, video };
  }

  const finalName = resolveLocalFilename(videoId, video.videoFilename);
  const partName = `${finalName}.part`;
  const partPath = resolveSafePathInDirectories(partName, [VIDEOS_DIR]);
  const controller = new AbortController();
  let canceled = false;
  registerCancel(() => {
    canceled = true;
    controller.abort();
  });

  try {
    await writeSidecar({
      videoId,
      hash: parsed.hash,
      fileId: parsed.fileId,
      finalName,
      videoFilename: video.videoFilename,
    });

    let startByte = 0;
    try {
      startByte = (await fs.stat(partPath)).size;
    } catch {
      startByte = 0;
    }

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

    const appending = response.status === 206 && startByte > 0;
    if (!appending) {
      startByte = 0;
    }
    const totalBytes = parseTotalBytes(
      response.headers as Record<string, unknown>,
      appending
    );
    let downloaded = startByte;
    let lastTick = 0;

    await new Promise<void>((resolve, reject) => {
      const writeStream = createWriteStreamSafe(partName, VIDEOS_DIR, {
        flags: appending ? "a" : "w",
      });
      const upstream = response.data as NodeJS.ReadableStream;
      upstream.on("data", (chunk: Buffer) => {
        downloaded += chunk.length;
        const now = Date.now();
        if (now - lastTick >= 1000) {
          lastTick = now;
          storageService.updateActiveDownload(videoId, {
            progress:
              totalBytes > 0 ? Math.min(100, (downloaded / totalBytes) * 100) : 0,
            downloadedSize: formatBytes(downloaded),
            totalSize: totalBytes > 0 ? formatBytes(totalBytes) : "?",
          });
        }
      });
      upstream.on("error", reject);
      writeStream.on("error", reject);
      writeStream.on("finish", () => resolve());
      upstream.pipe(writeStream);
    });

    const finalPath = resolveSafePathInDirectories(finalName, [VIDEOS_DIR]);
    await fs.move(partPath, finalPath, { overwrite: true });
    // Make the finished file stream instantly in external players (IINA/VLC).
    await ensureFaststartMp4(finalPath);
    storageService.updateVideo(videoId, {
      videoPath: `/videos/${finalName}`,
      videoFilename: finalName,
    });
    await removeArtifacts(finalName, { partToo: false });
    await removeTorrent(parsed.hash);
    logger.info(
      `[TorrServer] Offline download complete for video ${videoId} -> /videos/${finalName}`
    );
    return { success: true, video: storageService.getVideoById(videoId) };
  } catch (error) {
    if (canceled) {
      // Explicit cancel: discard the partial so a retry starts clean. The
      // library row stays a streamable `torrent:` entry.
      await removeArtifacts(finalName, { partToo: true });
      logger.info(`[TorrServer] Offline download canceled for video ${videoId}`);
      throw new Error("Download cancelled");
    }
    // Interruption/failure: KEEP the partial + sidecar so resume continues.
    logger.error(
      `[TorrServer] Offline download failed for video ${videoId} (will resume)`,
      error instanceof Error ? error : new Error(String(error))
    );
    throw error;
  }
}

/**
 * Re-enqueue offline downloads interrupted by a restart / VM recycle onto the
 * downloadManager. Best-effort; runs at startup.
 */
export async function resumeInterruptedDownloads(): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(VIDEOS_DIR);
  } catch {
    return;
  }
  const downloadManager = (await import("../downloadManager")).default;
  for (const name of entries.filter((f) => f.endsWith(".part.json"))) {
    try {
      const sidecar: DownloadSidecar = await fs.readJson(
        resolveSafePathInDirectories(name, [VIDEOS_DIR])
      );
      const video = storageService.getVideoById(sidecar.videoId);
      if (!video || !parseTorrentVideoPath(video.videoPath)) {
        await removeArtifacts(sidecar.finalName, { partToo: true });
        continue;
      }
      if (storageService.getActiveDownload(sidecar.videoId)) {
        continue; // already running
      }
      logger.info(
        `[TorrServer] Resuming interrupted offline download for video ${sidecar.videoId}`
      );
      void downloadManager
        .addDownload(
          (rc) => downloadTorrentTask(sidecar.videoId, rc),
          sidecar.videoId,
          video.title,
          video.sourceUrl,
          "torrent"
        )
        .catch(() => {
          // errors are logged inside the task; sidecar kept for next retry
        });
    } catch {
      // malformed sidecar: ignore
    }
  }
}
