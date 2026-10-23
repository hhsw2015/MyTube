import axios from "axios";
import * as storageService from "../storageService";
import { logger } from "../../utils/logger";

/**
 * Thin typed client for an external TorrServer instance
 * (https://github.com/YouROK/TorrServer).
 *
 * The configured base URL is a trusted, admin-set value that is almost always a
 * private/LAN host (e.g. http://torrserver:8090). It therefore deliberately
 * does NOT go through `validateUrl` (the SSRF guard), which would reject private
 * IPs — exactly analogous to how the OpenList/Alist cloud base URL is trusted.
 * The guard is only ever applied to untrusted user-supplied URLs elsewhere.
 */

export interface TorrServerFile {
  id: number;
  path: string;
  length: number;
}

export interface TorrServerTorrent {
  hash: string;
  name: string;
  files: TorrServerFile[];
}

interface TorrServerConfig {
  baseUrl: string;
  authHeader: Record<string, string>;
}

const REQUEST_TIMEOUT_MS = 20000;

/**
 * Resolve the configured TorrServer base URL + optional auth. Throws when
 * TorrServer is disabled or misconfigured so callers fail fast with a clear
 * message rather than firing a request at an empty host.
 */
function getConfig(): TorrServerConfig {
  const settings = storageService.getSettings();

  if (!settings.torrServerEnabled || !settings.torrServerBaseUrl) {
    throw new Error("TorrServer is not enabled or no base URL is configured");
  }

  let baseUrl: string;
  try {
    const parsed = new URL(String(settings.torrServerBaseUrl));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("protocol must be http or https");
    }
    // Normalize: drop any trailing slash so `${baseUrl}/stream/...` is clean.
    baseUrl = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
  } catch (error) {
    throw new Error(
      `Invalid TorrServer base URL: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  // torrServerAuth is stored as "user:pass"; TorrServer accepts HTTP Basic.
  const authHeader: Record<string, string> =
    typeof settings.torrServerAuth === "string" &&
    settings.torrServerAuth.length > 0
      ? {
          Authorization: `Basic ${Buffer.from(settings.torrServerAuth).toString(
            "base64"
          )}`,
        }
      : {};

  return { baseUrl, authHeader };
}

export function isTorrServerEnabled(): boolean {
  const settings = storageService.getSettings();
  return Boolean(settings.torrServerEnabled && settings.torrServerBaseUrl);
}

/**
 * Build the HTTP Basic auth header from the configured credential, for callers
 * that stream directly from TorrServer (the proxy and the offline downloader).
 * Returns an empty object when no auth is configured.
 */
export function getAuthHeader(): Record<string, string> {
  const settings = storageService.getSettings();
  if (
    typeof settings.torrServerAuth === "string" &&
    settings.torrServerAuth.length > 0
  ) {
    return {
      Authorization: `Basic ${Buffer.from(settings.torrServerAuth).toString(
        "base64"
      )}`,
    };
  }
  return {};
}

/**
 * Add a magnet/torrent link. `save_to_db:true` is required — without it
 * TorrServer drops the torrent on restart and the library entry's stream dies.
 */
export async function addMagnet(
  link: string,
  title?: string
): Promise<string> {
  const { baseUrl, authHeader } = getConfig();
  // Re-assert the aggressive bandwidth settings on every add (TorrServer resets
  // them on each sandbox recycle). Fire-and-forget.
  void applyStreamingSettings();
  const response = await axios.post(
    `${baseUrl}/torrents`,
    { action: "add", link, title: title ?? "", save_to_db: true },
    { headers: authHeader, timeout: REQUEST_TIMEOUT_MS }
  );
  const hash = response.data?.hash;
  if (typeof hash !== "string" || hash.length === 0) {
    throw new Error("TorrServer did not return a torrent hash");
  }
  return hash;
}

/**
 * Aggressive streaming/bandwidth settings pushed to TorrServer. We re-apply them
 * on startup and on every add (idempotent) so a fresh/redeployed TorrServer gets
 * them without manual steps. Big RAM cache + high read-ahead + many connections
 * + a large public tracker list + IPv6 = max download bandwidth and smooth
 * playback. NOTE: TorrServer's `set` REPLACES the whole BTSets object, so any
 * non-default field we want kept must be listed here — otherwise it reverts to
 * its zero value on the next apply (that is why EnableIPv6 is explicit).
 */
// A curated set of reliable public trackers applied immediately (DefaultTrackers
// is static, unlike TrackersListURL which TorrServer fetches asynchronously).
// On a cold boot this gives every torrent good trackers right away, which helps
// metadata resolution in a peer-starved environment where every extra reachable
// peer counts.
const DEFAULT_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.tracker.cl:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://open.stealth.si:80/announce",
  "udp://explodie.org:6969/announce",
  "udp://tracker.0x7c0.com:6969/announce",
  "http://tracker.openbittorrent.com:80/announce",
].join("\n");

const STREAMING_SETTINGS = {
  CacheSize: 1073741824, // 1 GB RAM cache (TorrServer default is 64 MB)
  ReaderReadAHead: 95, // keep downloading far ahead of the playhead
  PreloadCache: 20,
  ConnectionsLimit: 1000, // more peers -> more bandwidth
  DownloadRateLimit: 0, // unlimited
  UploadRateLimit: 0,
  RetrackersMode: 1, // append the tracker list to every torrent
  TrackersListURL:
    "https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt",
  DefaultTrackers: DEFAULT_TRACKERS,
  TorrentDisconnectTimeout: 120,
  UseDisk: false,
  EnableIPv6: true, // connect IPv6-only peers (the host has an IPv6 address)
} as const;
// Kept in sync with sprite-deploy/deploy-mytube.sh, which pushes the same set at
// deploy time so a standalone TorrServer is tuned before MyTube connects.

/**
 * Push the aggressive settings to TorrServer. Best-effort: returns false (never
 * throws) when TorrServer is unreachable or disabled.
 */
export async function applyStreamingSettings(): Promise<boolean> {
  if (!isTorrServerEnabled()) {
    return false;
  }
  try {
    const { baseUrl, authHeader } = getConfig();
    await axios.post(
      `${baseUrl}/settings`,
      { action: "set", sets: STREAMING_SETTINGS },
      { headers: authHeader, timeout: REQUEST_TIMEOUT_MS }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep retrying applyStreamingSettings in the background until it lands (or give
 * up after ~1 min). Fire-and-forget from server startup — TorrServer may not be
 * up yet when MyTube boots.
 */
export function scheduleStreamingSettings(): void {
  void (async () => {
    for (let i = 0; i < 20; i += 1) {
      if (await applyStreamingSettings()) {
        logger.info("[TorrServer] streaming/bandwidth settings applied");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  })();
}

/** Fetch torrent metadata (name + the list of files it contains). */
export async function getTorrent(hash: string): Promise<TorrServerTorrent> {
  const { baseUrl, authHeader } = getConfig();
  const response = await axios.post(
    `${baseUrl}/torrents`,
    { action: "get", hash },
    { headers: authHeader, timeout: REQUEST_TIMEOUT_MS }
  );
  const data = response.data ?? {};
  const fileStats = Array.isArray(data.file_stats) ? data.file_stats : [];
  const files: TorrServerFile[] = fileStats
    .map((file: Record<string, unknown>) => ({
      id: Number(file.id),
      path: String(file.path ?? ""),
      length: Number(file.length ?? 0),
    }))
    .filter((file: TorrServerFile) => Number.isFinite(file.id));
  return { hash, name: String(data.name ?? hash), files };
}

/**
 * Build the playback URL for a single file. The `<name>` path segment is
 * cosmetic — TorrServer selects the file purely from the `link` + `index` query
 * params (verified against server/web/api/stream.go + route.go). We still pass a
 * filename carrying the right extension so players infer the MIME type.
 */
export function buildStreamUrl(
  hash: string,
  fileId: number,
  name?: string
): string {
  const { baseUrl } = getConfig();
  const fname = encodeURIComponent(name && name.length > 0 ? name : "file");
  return `${baseUrl}/stream/${fname}?link=${encodeURIComponent(
    hash
  )}&index=${fileId}&play`;
}

export interface TorrServerActiveTorrent {
  hash: string;
  name: string;
  title: string;
  torrentSize: number;
  downloadSpeed: number;
  preloadedBytes: number;
  activePeers: number;
  totalPeers: number;
  connectedSeeders: number;
}

/** List all torrents currently in TorrServer (the added magnets). */
export async function listTorrents(): Promise<
  Array<{ hash: string; name: string; title: string }>
> {
  const { baseUrl, authHeader } = getConfig();
  const response = await axios.post(
    `${baseUrl}/torrents`,
    { action: "list" },
    { headers: authHeader, timeout: REQUEST_TIMEOUT_MS }
  );
  const list = Array.isArray(response.data) ? response.data : [];
  return list
    .map((t: Record<string, unknown>) => ({
      hash: String(t.hash ?? ""),
      name: String(t.name ?? t.title ?? ""),
      title: String(t.title ?? t.name ?? ""),
    }))
    .filter((t: { hash: string }) => t.hash.length > 0);
}

/**
 * Live stat for one torrent (speed/size/peers). Only meaningful while the
 * torrent has an active reader; an idle torrent reports zeros. Best-effort.
 */
export async function getTorrentStat(
  hash: string
): Promise<Omit<TorrServerActiveTorrent, "name" | "title">> {
  const { baseUrl, authHeader } = getConfig();
  const response = await axios.post(
    `${baseUrl}/torrents`,
    { action: "get", hash },
    { headers: authHeader, timeout: REQUEST_TIMEOUT_MS }
  );
  const d = response.data ?? {};
  return {
    hash,
    torrentSize: Number(d.torrent_size ?? 0),
    downloadSpeed: Number(d.download_speed ?? 0),
    preloadedBytes: Number(d.preloaded_bytes ?? 0),
    activePeers: Number(d.active_peers ?? 0),
    totalPeers: Number(d.total_peers ?? 0),
    connectedSeeders: Number(d.connected_seeders ?? 0),
  };
}

/** Remove a torrent from TorrServer (used when the MyTube video is deleted). */
export async function removeTorrent(hash: string): Promise<void> {
  try {
    const { baseUrl, authHeader } = getConfig();
    await axios.post(
      `${baseUrl}/torrents`,
      { action: "rem", hash },
      { headers: authHeader, timeout: REQUEST_TIMEOUT_MS }
    );
  } catch (error) {
    // Best-effort cleanup: a failed remove must not block video deletion.
    logger.warn(
      `[TorrServer] Failed to remove torrent ${hash}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Poke the stream endpoint so TorrServer actively fetches the torrent's
 * metadata. Without an active reader TorrServer closes a fresh torrent "by
 * timeout" before its file list resolves, so `getTorrent` alone never returns
 * files. Call this while polling. Best-effort; errors are ignored.
 */
export async function keepTorrentActive(hash: string): Promise<void> {
  try {
    const { baseUrl, authHeader } = getConfig();
    await axios.get(
      `${baseUrl}/stream?link=${encodeURIComponent(hash)}&stat`,
      { headers: authHeader, timeout: 8000, validateStatus: () => true }
    );
  } catch {
    // best-effort trigger
  }
}

/** Liveness probe for the Settings UI health check. */
export async function checkHealth(): Promise<boolean> {
  try {
    const { baseUrl, authHeader } = getConfig();
    await axios.get(`${baseUrl}/echo`, {
      headers: authHeader,
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}
