import crypto from "crypto";
import path from "path";
import * as storageService from "../storageService";
import type { Video } from "../storageService/types";
import { logger } from "../../utils/logger";
import {
  addMagnet,
  getTorrent,
  keepTorrentActive,
  type TorrServerFile,
  type TorrServerTorrent,
} from "./client";
import { buildTorrentVideoPath } from "./torrentPath";

// A fresh magnet needs time to resolve its file list from the swarm; TorrServer
// returns an empty list until metadata arrives. Poll getTorrent until files
// appear (or timeout) so the first add succeeds instead of erroring.
const TORRENT_METADATA_TIMEOUT_MS = 60000;
const TORRENT_METADATA_POLL_MS = 2000;

async function waitForTorrentFiles(hash: string): Promise<TorrServerTorrent> {
  // Env-overridable so tests don't actually wait.
  const timeoutMs = Number(
    process.env.TORR_META_TIMEOUT_MS ?? TORRENT_METADATA_TIMEOUT_MS
  );
  const pollMs = Number(process.env.TORR_META_POLL_MS ?? TORRENT_METADATA_POLL_MS);
  const deadline = Date.now() + timeoutMs;
  // Trigger the metadata fetch — a passive getTorrent never resolves because
  // TorrServer closes an unread torrent by timeout.
  await keepTorrentActive(hash);
  let torrent = await getTorrent(hash);
  while (torrent.files.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    await keepTorrentActive(hash); // keep it active each poll so info resolves
    torrent = await getTorrent(hash);
  }
  return torrent;
}

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mkv",
  ".webm",
  ".avi",
  ".mov",
  ".m4v",
  ".flv",
  ".3gp",
  ".ts",
  ".wmv",
]);

const isMagnetLink = (value: string): boolean =>
  /^magnet:\?/i.test(value.trim());

const isVideoFile = (file: TorrServerFile): boolean =>
  VIDEO_EXTENSIONS.has(path.extname(file.path).toLowerCase());

/**
 * Pick the file to add when the caller does not choose. Prefer the largest
 * video-extension file; fall back to the largest file overall.
 */
const pickPlayableFile = (files: TorrServerFile[]): TorrServerFile | null => {
  if (files.length === 0) {
    return null;
  }
  const videos = files.filter(isVideoFile);
  const pool = videos.length > 0 ? videos : files;
  return pool.reduce((largest, file) =>
    file.length > largest.length ? file : largest
  );
};

/** Build a stream-mode library row for one file of a torrent. */
const buildTorrentVideo = (
  hash: string,
  torrentName: string,
  file: TorrServerFile,
  sourceUrl: string
): Video => {
  const fileName = path.basename(file.path) || torrentName;
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    // For a multi-file torrent the per-file name is more useful than the
    // torrent name (which becomes the collection title instead).
    title: fileName,
    author: "Torrent",
    date: now.toISOString().slice(0, 10),
    source: "torrent",
    sourceUrl,
    sourceVideoId: `${hash}/${file.id}`,
    videoPath: buildTorrentVideoPath(hash, file.id),
    videoFilename: fileName,
    createdAt: now.toISOString(),
    fileSize: String(file.length),
    mediaType: "video",
    // duration/width/height are not in torrent metadata; left unset until the
    // file is probed or played (design §5).
  };
};

export interface InspectMagnetResult {
  hash: string;
  name: string;
  files: TorrServerFile[];
}

/**
 * Add the magnet to TorrServer and return its file list for the picker UI
 * (video files only). Creates no library rows.
 */
export async function inspectMagnet(
  magnet: string
): Promise<InspectMagnetResult> {
  const link = magnet.trim();
  if (!isMagnetLink(link)) {
    throw new Error("Not a valid magnet link");
  }
  const hash = await addMagnet(link);
  const torrent = await waitForTorrentFiles(hash);
  const videoFiles = torrent.files.filter(isVideoFile);
  const files = videoFiles.length > 0 ? videoFiles : torrent.files;
  // Largest first so the picker can pre-select sensibly.
  files.sort((a, b) => b.length - a.length);
  return { hash, name: torrent.name, files };
}

export interface AddMagnetResult {
  video: Video;
  created: boolean;
}

/**
 * Add a magnet and create a stream-mode library entry for its largest playable
 * file. Idempotent on the magnet URL. This is the quick single-file path.
 */
export async function addMagnetToLibrary(
  magnet: string
): Promise<AddMagnetResult> {
  const link = magnet.trim();
  if (!isMagnetLink(link)) {
    throw new Error("Not a valid magnet link");
  }

  const existing = storageService.getVideoBySourceUrl(link);
  if (existing) {
    return { video: existing, created: false };
  }

  const hash = await addMagnet(link);
  const torrent = await waitForTorrentFiles(hash);
  const file = pickPlayableFile(torrent.files);
  if (!file) {
    throw new Error("Torrent contains no files");
  }

  const video = buildTorrentVideo(hash, torrent.name, file, link);
  storageService.saveVideo(video, { statisticsReason: "manual" });
  logger.info(
    `[TorrServer] Added magnet to library: "${video.title}" (${hash}/${file.id})`
  );
  return { video, created: true };
}

export interface AddMagnetFilesResult {
  videos: Video[];
  created: number;
  collectionId: string | null;
}

/**
 * Add specific files of a multi-file torrent (season pack / picker). One library
 * row per selected file; when more than one is added they are grouped into a
 * collection named after the torrent. Idempotent per file.
 */
export async function addMagnetFilesToLibrary(
  magnet: string,
  fileIds: number[]
): Promise<AddMagnetFilesResult> {
  const link = magnet.trim();
  if (!isMagnetLink(link)) {
    throw new Error("Not a valid magnet link");
  }
  const wanted = Array.from(new Set(fileIds)).filter((id) =>
    Number.isInteger(id)
  );
  if (wanted.length === 0) {
    throw new Error("No files selected");
  }

  const hash = await addMagnet(link);
  const torrent = await waitForTorrentFiles(hash);
  const selected = torrent.files.filter((file) => wanted.includes(file.id));
  if (selected.length === 0) {
    throw new Error("None of the selected files exist in the torrent");
  }

  const multi = selected.length > 1;
  const videos: Video[] = [];
  let created = 0;

  for (const file of selected) {
    // Per-file sourceUrl keeps dedup working for a multi-file torrent whose
    // files all share one magnet. A single selection keeps the bare magnet so
    // it stays consistent with the quick add path.
    const sourceUrl = multi ? `${link}#file=${file.id}` : link;
    const existing = storageService.getVideoBySourceUrl(sourceUrl);
    if (existing) {
      videos.push(existing);
      continue;
    }
    const video = buildTorrentVideo(hash, torrent.name, file, sourceUrl);
    storageService.saveVideo(video, { statisticsReason: "manual" });
    videos.push(video);
    created += 1;
  }

  let collectionId: string | null = null;
  if (videos.length > 1) {
    const title = torrent.name || "Torrent";
    const existingCollection = storageService.getCollectionByName(title);
    const collection =
      existingCollection ??
      storageService.saveCollection({
        id: crypto.randomUUID(),
        name: title,
        title,
        videos: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    collectionId = collection.id;
    for (const video of videos) {
      storageService.addVideoToCollection(collection.id, video.id);
    }
  }

  logger.info(
    `[TorrServer] Added ${created} file(s) from magnet to library (${hash})`
  );
  return { videos, created, collectionId };
}
