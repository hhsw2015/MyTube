import { Request, Response } from "express";
import axios from "axios";
import { ValidationError, NotFoundError } from "../errors/DownloadErrors";
import { isLoginRequired } from "../services/passwordService";
import * as storageService from "../services/storageService";
import * as torrserver from "../services/torrserver";
import { logger } from "../utils/logger";
import { getStringParam } from "../utils/paramUtils";
import { sendData } from "../utils/response";

const getVisibilityScopedRole = (
  req: Request
): storageService.VideoCallerRole | undefined => {
  if (!isLoginRequired()) {
    return undefined;
  }
  return req.user?.role as storageService.VideoCallerRole | undefined;
};

const assertTorrServerEnabled = (): void => {
  if (!torrserver.isTorrServerEnabled()) {
    throw new ValidationError(
      "TorrServer is not enabled. Configure it in Settings first.",
      "magnet"
    );
  }
};

/**
 * POST /api/torrent/inspect — add the magnet to TorrServer and return its file
 * list for the multi-file picker. Admin-gated. Creates no library rows.
 */
export const inspectMagnet = async (
  req: Request,
  res: Response
): Promise<void> => {
  const magnet = getStringParam(req.body?.magnet);
  if (!magnet) {
    throw new ValidationError("A magnet link is required", "magnet");
  }
  assertTorrServerEnabled();
  const result = await torrserver.inspectMagnet(magnet);
  sendData(res, result);
};

/**
 * POST /api/torrent/add — add a magnet to the library (stream mode).
 * Body: { magnet, fileIds?: number[] }. With fileIds, adds those specific files
 * (grouped into a collection when more than one); without, adds the largest
 * playable file. Admin-gated at the route level.
 */
export const addMagnet = async (
  req: Request,
  res: Response
): Promise<void> => {
  const magnet = getStringParam(req.body?.magnet);
  if (!magnet) {
    throw new ValidationError("A magnet link is required", "magnet");
  }
  assertTorrServerEnabled();

  const rawFileIds = req.body?.fileIds;
  if (Array.isArray(rawFileIds) && rawFileIds.length > 0) {
    const fileIds = rawFileIds
      .map((id: unknown) => Number(id))
      .filter((id) => Number.isInteger(id));
    const result = await torrserver.addMagnetFilesToLibrary(magnet, fileIds);
    res.status(result.created > 0 ? 201 : 200);
    sendData(res, result);
    return;
  }

  const result = await torrserver.addMagnetToLibrary(magnet);
  res.status(result.created ? 201 : 200);
  sendData(res, result.video);
};

/**
 * POST /api/torrent/:id/download — Mode B: download a stream-mode torrent video
 * to local storage for offline retention. Runs in the background; returns 202.
 * Admin-gated.
 */
export const downloadTorrent = async (
  req: Request,
  res: Response
): Promise<void> => {
  const id = getStringParam(req.params.id) ?? "";
  const video = storageService.getVideoById(id);
  if (!video) {
    throw new NotFoundError("Video", id);
  }
  if (!torrserver.parseTorrentVideoPath(video.videoPath)) {
    throw new ValidationError("Video is not a torrent stream entry", "id");
  }
  if (torrserver.isOfflineDownloadInProgress(id)) {
    res.status(202);
    sendData(res, { started: false, alreadyRunning: true });
    return;
  }

  // Fire-and-forget: the row flips to a local path when the download finishes.
  void torrserver.downloadTorrentToLibrary(id).catch(() => {
    // Errors are logged inside the service; nothing to do here.
  });
  res.status(202);
  sendData(res, { started: true });
};

/**
 * GET /api/torrent/health — liveness probe for the Settings UI. Admin-gated.
 */
export const health = async (_req: Request, res: Response): Promise<void> => {
  const ok = torrserver.isTorrServerEnabled()
    ? await torrserver.checkHealth()
    : false;
  sendData(res, { ok });
};

/**
 * GET /api/torrent-stream/:id — same-origin Range-forwarding proxy that pipes
 * TorrServer's stream to the browser. Same-origin is required so the native
 * <video> element's session cookie reaches MyTube's media auth (it cannot send
 * an Authorization header). Mirrors serveMountVideo, but the bytes come from an
 * upstream HTTP response rather than a local file.
 */
export const serveTorrentStream = async (
  req: Request,
  res: Response
): Promise<void> => {
  const id = getStringParam(req.params.id) ?? "";
  // Visibility scoping: visitors must not stream hidden torrent videos.
  const video = storageService.getVideoById(id, getVisibilityScopedRole(req));
  if (!video) {
    throw new NotFoundError("Video", id);
  }

  const parsed = torrserver.parseTorrentVideoPath(video.videoPath);
  if (!parsed) {
    throw new NotFoundError("Video", id);
  }

  const upstreamUrl = torrserver.buildStreamUrl(
    parsed.hash,
    parsed.fileId,
    video.videoFilename
  );

  // Playback is a long-lived response; the default socket timeout would kill
  // the stream mid-watch.
  req.socket.setTimeout(0);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Accept-Ranges, Content-Range, Content-Length"
  );

  try {
    const upstream = await axios.get(upstreamUrl, {
      responseType: "stream",
      // Forward the browser's Range so TorrServer returns 206 + the requested
      // byte range (random-access seek without downloading the head).
      headers: {
        ...torrserver.getAuthHeader(),
        ...(req.headers.range ? { Range: String(req.headers.range) } : {}),
      },
      // Pass through any status (206, 200, 416) rather than throwing on 4xx/5xx.
      validateStatus: () => true,
      timeout: 0,
    });

    res.status(upstream.status);
    for (const header of [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
    ]) {
      const value = upstream.headers[header];
      if (value !== undefined) {
        res.setHeader(header, value as string);
      }
    }

    // Tear down the upstream when the client disconnects so TorrServer stops
    // reading pieces for an abandoned seek.
    const upstreamStream = upstream.data as NodeJS.ReadableStream & {
      destroy?: () => void;
    };
    req.on("close", () => {
      upstreamStream.destroy?.();
    });

    upstreamStream.pipe(res);
  } catch (error) {
    logger.error(
      `[TorrServer] Stream proxy failed for video ${id}`,
      error instanceof Error ? error : new Error(String(error))
    );
    if (!res.headersSent) {
      res.status(502).send("Failed to reach TorrServer");
    } else {
      res.end();
    }
  }
};
