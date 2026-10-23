import fs from "fs-extra";
import path from "path";
import { spawn } from "child_process";
import { logger } from "./logger";

// mp4-family containers carry a `moov` index that downloaded files (torrent
// pieces, yt-dlp merges) frequently place at the END of the file. Browsers
// tolerate that (they Range-fetch the tail), but external players
// (IINA/VLC/mpv) often buffer the WHOLE file before playback -> "stuck
// loading". `-c copy -movflags +faststart` moves the index to the front; it is
// lossless and fast (no re-encode). mkv/webm stream fine and are skipped.
const FASTSTART_EXTS = new Set([".mp4", ".mov", ".m4v"]);

// How much of the file head to scan for an existing `moov` atom. A faststart
// file has moov right after `ftyp`; a few MB is plenty and avoids reading GBs.
const HEAD_SCAN_BYTES = 3 * 1024 * 1024;

/**
 * True when the file already has its `moov` atom near the front (already
 * faststart). Reads only the head of the file, never the whole thing.
 */
async function isAlreadyFaststart(absPath: string): Promise<boolean> {
  const fd = await fs.open(absPath, "r");
  try {
    const fileSize = (await fs.fstat(fd)).size;
    const size = Math.min(HEAD_SCAN_BYTES, fileSize);
    const buf = Buffer.alloc(size);
    await fs.read(fd, buf, 0, size, 0);
    return buf.includes(Buffer.from("moov"));
  } finally {
    await fs.close(fd);
  }
}

/**
 * Remux an mp4-family file in place to faststart (moov atom at the front) so it
 * streams instantly in external players and seeks fast.
 *
 * - No-op for non-mp4 containers (webm/mkv) and files already faststart.
 * - Lossless: `-c copy -map 0` preserves every stream, no re-encode.
 * - Best-effort: on any failure (ffmpeg missing, odd streams, bad path) the
 *   original file is left untouched and a warning is logged. NEVER throws, so a
 *   caller can await it in a download's success path without risking the
 *   download itself.
 *
 * @param absPath Absolute path to the finished media file.
 */
export async function ensureFaststartMp4(absPath: string): Promise<void> {
  const ext = path.extname(absPath).toLowerCase();
  if (!FASTSTART_EXTS.has(ext)) {
    return;
  }
  try {
    if (await isAlreadyFaststart(absPath)) {
      return;
    }
  } catch {
    // Couldn't read the head (missing/locked): let the remux attempt surface it.
  }

  const tmpPath = `${absPath}.faststart${ext}`;
  try {
    await new Promise<void>((resolve, reject) => {
      const ff = spawn(
        "ffmpeg",
        ["-y", "-i", absPath, "-map", "0", "-c", "copy", "-movflags", "+faststart", tmpPath],
        { stdio: "ignore" }
      );
      ff.on("error", reject); // ffmpeg not installed / not spawnable
      ff.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))
      );
    });
    await fs.move(tmpPath, absPath, { overwrite: true });
    logger.info(`[faststart] remuxed to faststart: ${absPath}`);
  } catch (error) {
    await fs.remove(tmpPath).catch(() => undefined);
    logger.warn(
      `[faststart] skipped (${
        error instanceof Error ? error.message : String(error)
      }): ${absPath}`
    );
  }
}
