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
// VIDEOS_DIR, converts the library row to an ordinary local video, and drops
// the torrent from TorrServer. Runs in the background (torrents can be large);
// ponytail: an in-memory guard prevents a duplicate concurrent download of the
// same video, upgrade to the download queue if progress/cancel is needed.
const inProgress = new Set<string>();

export function isOfflineDownloadInProgress(videoId: string): boolean {
  return inProgress.has(videoId);
}

/** Pick a safe on-disk filename for the downloaded torrent file. */
const resolveLocalFilename = (videoId: string, videoFilename?: string): string => {
  const sanitized = sanitizePathSegment(videoFilename ?? "");
  return sanitized.length > 0 ? sanitized : `${videoId}.mp4`;
};

export async function downloadTorrentToLibrary(videoId: string): Promise<void> {
  if (inProgress.has(videoId)) {
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

  inProgress.add(videoId);
  const finalName = resolveLocalFilename(videoId, video.videoFilename);
  const partName = `${finalName}.part`;
  const url = buildStreamUrl(parsed.hash, parsed.fileId, video.videoFilename);

  try {
    const response = await axios.get(url, {
      responseType: "stream",
      timeout: 0,
      headers: getAuthHeader(),
      validateStatus: (status) => status >= 200 && status < 300,
    });

    await new Promise<void>((resolve, reject) => {
      const writeStream = createWriteStreamSafe(partName, VIDEOS_DIR);
      const upstream = response.data as NodeJS.ReadableStream;
      upstream.on("error", reject);
      writeStream.on("error", reject);
      writeStream.on("finish", () => resolve());
      upstream.pipe(writeStream);
    });

    const partPath = resolveSafePathInDirectories(partName, [VIDEOS_DIR]);
    const finalPath = resolveSafePathInDirectories(finalName, [VIDEOS_DIR]);
    await fs.move(partPath, finalPath, { overwrite: true });

    // Convert to an ordinary local video; keep source="torrent" to record origin.
    storageService.updateVideo(videoId, {
      videoPath: `/videos/${finalName}`,
      videoFilename: finalName,
    });
    await removeTorrent(parsed.hash);
    logger.info(
      `[TorrServer] Offline download complete for video ${videoId} -> /videos/${finalName}`
    );
  } catch (error) {
    // Remove the partial file so a retry starts clean.
    try {
      const partPath = resolveSafePathInDirectories(partName, [VIDEOS_DIR]);
      await fs.remove(partPath);
    } catch {
      // ignore cleanup failure
    }
    logger.error(
      `[TorrServer] Offline download failed for video ${videoId}`,
      error instanceof Error ? error : new Error(String(error))
    );
    throw error;
  } finally {
    inProgress.delete(videoId);
  }
}
