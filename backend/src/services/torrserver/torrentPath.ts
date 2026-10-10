/**
 * The `torrent:` videoPath scheme: `torrent:<infohash>/<fileId>`.
 *
 * Sits alongside the existing `cloud:` and `mount:` schemes. A torrent video is
 * never a local file — it is streamed live from TorrServer through the backend
 * proxy, so every subsystem that assumes `videoPath` resolves to a file under
 * VIDEOS_DIR must skip it (see isTorrentVideoPath).
 */

export const TORRENT_PATH_PREFIX = "torrent:";

export const isTorrentVideoPath = (
  videoPath: string | null | undefined
): boolean =>
  typeof videoPath === "string" && videoPath.startsWith(TORRENT_PATH_PREFIX);

export const buildTorrentVideoPath = (hash: string, fileId: number): string =>
  `${TORRENT_PATH_PREFIX}${hash}/${fileId}`;

export interface ParsedTorrentPath {
  hash: string;
  fileId: number;
}

/** Parse `torrent:<hash>/<fileId>`. Returns null for any other shape. */
export const parseTorrentVideoPath = (
  videoPath: string | null | undefined
): ParsedTorrentPath | null => {
  if (!isTorrentVideoPath(videoPath)) {
    return null;
  }
  const body = (videoPath as string).slice(TORRENT_PATH_PREFIX.length);
  const slash = body.lastIndexOf("/");
  if (slash <= 0 || slash === body.length - 1) {
    return null;
  }
  const hash = body.slice(0, slash);
  const fileId = Number(body.slice(slash + 1));
  if (!hash || !Number.isInteger(fileId) || fileId < 0) {
    return null;
  }
  return { hash, fileId };
};
