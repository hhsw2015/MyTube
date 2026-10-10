# Design: TorrServer Integration — Magnet "Watch-While-Downloading" Source for MyTube

Status: Proposal / implementation spec
Author: design hand-off (for an implementing agent)
Scope: add BitTorrent **magnet / torrent** as a first-class media source that plays in
MyTube's existing player via **TorrServer** (edge-while-play streaming). No change to
MyTube's core download-then-play flows.

---

## 1. Motivation

MyTube is a polished self-hosted **library + player** built around a *download-then-play*
model (yt-dlp downloads the full file into `backend/uploads/videos/`, then the player
plays the local file). It has everything a media app needs *except* torrents: nice React
19 / MUI UI, collections, subscriptions, RSS, TMDB metadata, a full-featured native
`<video>` player, multi-user auth, an API, and built-in Cloudflare Tunnel.

[TorrServer](https://github.com/YouROK/TorrServer) is a single Go binary that does the one
thing MyTube lacks: it turns a **magnet link into an instantly-playable HTTP stream**
(sequential piece priority + RAM/disk cache → *watch while downloading*, with HTTP Range
seeking). It exposes:

- `POST /torrents` `{"action":"add","link":"magnet:…","title":"…","save_to_db":true}` → `{hash,…}`
- `POST /torrents` `{"action":"get","hash":"…"}` → `{name, file_stats:[{id,path,length}], …}`
- Stream URL: `http://<torrserver>/stream/<name>?link=<infohash>&index=<fileId>&play`
  (serves the original file bytes with `Accept-Ranges`; `video/mp4` etc.)
- `POST /settings` `{"action":"get"|"set","sets":{CacheSize,ReaderReadAHead,PreloadCache,ConnectionsLimit,…}}`

The two are highly complementary: **TorrServer fills MyTube's only content-source gap,
and MyTube gives TorrServer a real front-end.**

## 2. Goals / Non-goals

**Goals**
- Add a magnet/torrent video to the library and play it in the existing player with
  watch-while-downloading (no waiting for a full download).
- Reuse MyTube's existing player, library, collections, metadata, and auth unchanged.
- Keep TorrServer as an external service MyTube talks to over HTTP (not embedded).

**Non-goals**
- Rewriting MyTube's storage/player model.
- Building a torrent engine in Node (TorrServer owns that).
- Torrent *search/indexers* (out of scope; user pastes a magnet).

## 3. How MyTube works today (verified seams)

- **Video model** — `backend/src/db/schema.ts` `videos` table. Key fields:
  `id, title, author, date, source (text), sourceUrl, sourceVideoId, videoFilename,
  videoPath, thumbnailUrl/Path, duration, width, height, fileSize, mediaType ("video"|"audio")`.
  `source` is a free-text platform tag (youtube/bilibili/…); `sourceUrl` is indexed and
  used for dedup.
- **`videoPath` is already polymorphic** — `frontend/src/pages/VideoPlayer.tsx:200-204`:
  ```ts
  const videoUrl = useCloudStorageUrl(video?.videoPath, isAudio ? 'audio' : 'video', video?.signedUrl);
  const isVideoInCloud = video?.videoPath?.startsWith('cloud:') ?? false;
  ```
  Today `videoPath` is either a local path **or** a `cloud:` URI resolved (via
  `frontend/src/hooks/useCloudStorageUrl.ts`) to an external signed URL. **This is the
  integration seam** — a new `torrent:` scheme fits the exact same resolver pattern.
- **Player plays external cross-origin URLs already** — `frontend/src/utils/mediaOrigin.ts`
  sets `<video crossOrigin="anonymous">` for cross-origin absolute URLs (built for
  cloud-drive sources). The element is a **native HTML5 `<video>`**
  (`frontend/src/components/VideoPlayer/VideoControls/VideoElement.tsx`); there is **no
  hls.js / video.js** in `frontend/package.json`. ⇒ A TorrServer **MP4** stream URL plays
  with zero player changes; see §8 for the MKV/HLS caveat.
- **Downloader abstraction** — `backend/src/services/downloaders/BaseDownloader.ts:58`
  `abstract class BaseDownloader implements IDownloader` with
  `IDownloader { getVideoInfo(url), downloadVideo(url, options): Promise<Video>, search?, getLatestVideoUrl? }`.
  Implementations: `YtDlpDownloader`, `BilibiliDownloader`, `MissAVDownloader`. A torrent
  downloader slots into this interface.
- **SSRF guard** — `backend/src/utils/security.ts` `validateUrl()` is called on every
  download/thumbnail URL and only allows http/https (it rejects `magnet:` and typically
  private IPs). The magnet and the (often LAN) TorrServer host must therefore **bypass
  `validateUrl` and go through a configured, trusted TorrServer base URL setting** (see §6),
  exactly analogous to how the OpenList/Alist cloud base URL is a trusted configured value.
- **Settings pattern** — external backends (OpenList/Alist cloud storage) are configured in
  Settings and stored in the `settings` table; mirror this for TorrServer.

## 4. TorrServer deployment (companion service)

- Run TorrServer as a **4th service** alongside MyTube. There are **three** compose files and
  the wiring differs per file — do not ship one snippet:
  - `stacks/docker-compose.yml` (bridge, default) — add the service on `mytube-network`;
    backend reaches it at `http://torrserver:8090`:
    ```yaml
    torrserver:
      image: ghcr.io/yourok/torrserver:latest   # or a pinned MatriX build; arm64+amd64 available
      command: ["--port","8090","--path","/ts-data"]
      volumes: ["torrserver-data:/ts-data"]
      networks: [mytube-network]
      # no public port needed; the MyTube backend reaches it in-network
    ```
  - `stacks/docker-compose.host-network.yml` (**host networking**) — `networks:` and the
    `torrserver:8090` hostname **do not apply**; run TorrServer on the host and the backend
    reaches it at `http://localhost:8090` (or `127.0.0.1:8090`). Document this separately.
  - `stacks/docker-compose.single-container.yml` (one `mytube` image) — no second service to
    add to; either bundle TorrServer into the image/supervisor, or require the user to run it
    externally and set `torrServerBaseUrl` by hand. Decide and document.
- For remote playback, **do not expose TorrServer directly** (it has no public port). The
  browser reaches it only through MyTube's backend proxy (§6c), which in turn is published via
  MyTube's existing **Cloudflare Tunnel**. See §5/§6c for why direct browser→TorrServer
  playback does not work in these deployments.
- Recommended TorrServer settings (POST /settings) for smooth high-bitrate + fast start:
  `CacheSize ≈ 512MB–1GB (RAM), ReaderReadAHead 95, PreloadCache 5–8 (fast start),
  ConnectionsLimit 150–300, RetrackersMode 1`. **Note:** TorrServer serves the *original*
  file (no transcode) → quality = the torrent's quality.

## 5. Design — two modes

### Mode A — Stream (primary; true watch-while-downloading)
A torrent video stores a **TorrServer stream reference** in `videoPath` and is **not**
downloaded into MyTube's storage. The player streams it live **through the MyTube backend
proxy** (§6c) — see the transport decision below.

- `source = "torrent"`, `sourceUrl = <magnet>`,
  `videoPath = "torrent:<infohash>/<fileId>"` (new scheme, sits alongside the existing
  `cloud:` and `mount:` schemes — see §7).
- **Playback transport is the backend proxy (§6c), not direct.** The frontend resolves
  `torrent:` to a **same-origin** MyTube URL (e.g. `/api/torrent-stream/:hash/:index`); the
  backend builds the real TorrServer URL
  `http://<torrserver>/stream/<name>?link=<infohash>&index=<fileId>&play` server-side and pipes
  it. Direct browser→TorrServer is **not viable** in the proposed deployments (TorrServer has
  no public port; Cloudflare Tunnel is HTTPS so an `http://` LAN TorrServer is mixed-content
  blocked; and the frontend has no `torrServerBaseUrl`). Direct mode is LAN-only / advanced.
- When adding the torrent, use TorrServer `save_to_db:true` — otherwise TorrServer drops the
  torrent on restart and the library entry's stream dies.
- Metadata note: torrent metadata yields **title and fileSize only**. `duration`/`width`/
  `height` are **not** in torrent metadata; they stay null until the file is probed (ffprobe
  over the stream reads pieces) or the video is played. Don't promise duration at ingest.
- Pros: instant play, no local storage. Cons: playback depends on TorrServer + swarm;
  content isn't retained unless also downloaded, and an entry can go dead if seeders vanish
  (the library has no "unavailable" state today — see §8).

### Mode B — Download (optional; fits the existing model)
A `TorrentDownloader extends BaseDownloader` pulls the selected file to
`backend/uploads/videos/` via TorrServer (read the stream to disk) or a Node torrent lib,
then it becomes an ordinary local MyTube video. Pros: retained, offline, uniform. Cons:
wait for download, uses storage, loses "instant".

**Recommendation:** ship **Mode A first** (biggest payoff) **via the backend proxy** — it
reuses the existing `videoPath` polymorphism and native player, but through a same-origin proxy
URL rather than a cross-origin one, because direct playback does not work in the proposed
deployments (§6c). Add Mode B as a "Download for offline" action later.

## 6. Backend changes

### (a) TorrServer client service — `backend/src/services/torrserver/` (new)
Thin typed client: `addMagnet(magnet, title?) → {hash}`, `getTorrent(hash) → {name, files:[{id,path,length}]}`,
`buildStreamUrl(hash, fileId, name)`, `removeTorrent(hash)`, `get/setSettings()`. Base URL +
optional auth come from settings (below). **Do not route these through `validateUrl`** — use
the trusted configured base URL.

### (b) Add-magnet ingestion
Add an endpoint parallel to the existing URL-download flow (implementer: locate the current
"add download" route/controller — search `backend/src/routes` + `backend/src/controllers`
for the handler that dispatches to the downloaders / enqueues `downloads`). New flow:
1. Validate input is a `magnet:` URI (or `.torrent` URL/upload).
2. `torrserver.addMagnet(magnet)` → hash; `getTorrent(hash)` → files; pick the playable
   file(s) (largest video file, or let the user choose for multi-file torrents / seasons).
3. Create a `videos` row per playable file: `source:"torrent"`, `sourceUrl:magnet`,
   `sourceVideoId:"<hash>/<fileId>"`, `videoPath:"torrent:<hash>/<fileId>"`,
   `title/duration/size` from torrent metadata, optional TMDB scrape (reuse existing TMDB
   service) for poster/metadata, `mediaType` by extension.
4. Dedup on `sourceUrl`/`sourceVideoId` (indexes already exist in `schema.ts`).

Reuse the existing save path (`storageService` `saveVideo`/equivalent) — a torrent video is
just a `videos` row with a `torrent:` `videoPath`.

### (c) Playback transport — backend proxy (required path)
The backend proxy is the **primary and effectively required** transport (not merely
"recommended"): it hides the LAN/in-network TorrServer, inherits MyTube media auth, avoids
mixed-content under Cloudflare Tunnel, keeps playback same-origin (so live-translation capture
keeps working — it's blocked cross-origin per `mediaOrigin.ts`), and removes the need to expose
`torrServerBaseUrl` to the browser.

- Add a Range-forwarding endpoint, e.g. `GET /api/torrent-stream/:hash/:index`, that server-side
  builds the TorrServer `/stream/...` URL and pipes the response.
- **This is net-new code with no precedent in the repo** — cloud storage serves via *signed URLs
  the browser fetches directly* (`cloudStorageController`/`cloudRoutes` do no Range piping), so
  "mirror the cloud config" applies to *settings*, not to this proxy. Get the streaming details
  right: forward the client `Range` → upstream, propagate upstream `Content-Range` /
  `Accept-Ranges` / `Content-Type`, **relay the `206 Partial Content` status** (don't flatten to
  200), and **tear down the pipe on client abort** (`req.on('close')`) so TorrServer stops
  reading pieces for an abandoned seek.
- Call TorrServer with the trusted configured base URL, **bypassing `validateUrl`** (it's a
  private host). Gate the endpoint behind MyTube's existing media auth
  (`requireAuthenticatedMediaAccess`).
- **Auth is cookie/session, not bearer** — this is *the* reason the proxy must be same-origin.
  `mediaAuthMiddleware` authenticates via `req.user` (session **cookie**), `apiKeyAuthenticated`,
  or an RSS feed token; a native `<video src>` sends same-origin **cookies** automatically but
  **cannot** set an `Authorization: Bearer` header. A cross-origin proxy URL would drop the
  cookie and fail auth. Same-origin `/api/torrent-stream/...` carries the session cookie for free.
- **Disable the per-request response timeout on this route** (e.g. `res.setTimeout(0)` / long
  server timeout) — playback is a long-lived response; the default request timeout would kill
  streams mid-watch.
- **Direct mode (LAN-only, advanced, optional):** frontend plays the TorrServer URL directly.
  Needs the browser to reach TorrServer (no mixed-content; permissive CORS — TorrServer sends it
  for `/stream`) *and* the frontend to know `torrServerBaseUrl`. Does not work under the proposed
  Cloudflare-Tunnel / no-public-port deployments; ship only as an explicit advanced option.

### (d) Settings
Add to the settings schema + Settings UI (mirror the OpenList/Alist cloud config):
`torrServerEnabled`, `torrServerBaseUrl`, `torrServerAuth` (optional), `torrentPlaybackMode`
(`stream`|`download`), `torrentProxyThroughBackend` (bool). Store in the `settings` table.

## 7. Frontend changes

- **Resolver** — the `torrent:` scheme touches more than one file; scheme detection does **not**
  live in the hook:
  - Add `isTorrentPath` next to `isCloudStoragePath` / `isMountDirectoryPath` in
    `frontend/src/utils/cloudStorage.ts` (there are already **two** schemes there — `cloud:` and
    `mount:` — the design must account for both).
  - Handle `torrent:` in `frontend/src/hooks/useCloudStorageUrl.ts` so it resolves to the
    **same-origin backend proxy URL** (`/api/torrent-stream/<hash>/<index>`). In proxy mode this
    is a pure synchronous string build — no async signed-URL fetch like `cloud:` needs.
  - `VideoPlayer.tsx` funnels through the hook at line 200 (no change needed there), **but** the
    poster branch at `VideoPlayer.tsx:203` keys on `videoPath?.startsWith('cloud:')`
    (`isVideoInCloud`) — a torrent video is neither cloud nor local, so decide its poster path
    (TMDB poster URL is simplest) and update that branch.
  - **`<name>` is cosmetic (settled):** TorrServer registers both `GET /stream` and
    `GET /stream/*fname`, and the handler selects the file purely from the `link` + `index`
    **query params** — it never reads `fname` (verified in `server/web/api/stream.go` /
    `route.go`). So `videoPath` storing only `<hash>/<fileId>` is sufficient; the backend builds
    `/stream/<fname>?link=<hash>&index=<id>&play` with `<fname>` set to a stable filename carrying
    the correct extension (e.g. `video.mp4`) just so the player infers MIME/extension. No
    `getTorrent` round-trip needed at playback time.
  - The `<video>` element + `mediaOrigin.ts` already handle cross-origin, so **no
    player-component change needed for MP4**; same-origin proxy playback also keeps
    live-translation capture available.
- **Add-magnet UI** — add a magnet input next to the existing URL-download entry (the
  download page / add dialog). Accept `magnet:` and `.torrent`. For multi-file torrents,
  show the file list (from `getTorrent`) and let the user pick which file(s) to add.
- **Source badge** — add a `torrent` case wherever `source` is rendered (icon/label), and to
  any TS union/enum of source types (implementer: grep the frontend for the existing
  `source` type/union, e.g. `"youtube" | "bilibili" | …`, and add `"torrent"`).
- **Optional "Download for offline"** — a button on a torrent video triggering Mode B.

## 8. Caveats & decisions

- **Container/codec (important):** native `<video>` (no hls.js) plays **MP4/WebM** with
  browser-supported codecs. Many torrents are **MKV/HEVC/AV1** which browsers won't play
  directly. Options, in order of effort: (1) prefer/annotate MP4(H.264/AAC) torrents;
  (2) enable **TorrServer transcoding** (it can transcode via ffmpeg / serve HLS) and add
  **hls.js** to the frontend + branch in `VideoElement.tsx` for `.m3u8`; (3) a backend
  remux/transcode endpoint. Recommend shipping Mode A for MP4 first, then add HLS+hls.js for
  broad codec support. Document the limitation. **Note:** TorrServer transcoding is build/version
  dependent and CPU-heavy — it is not a turnkey toggle; validate it on the pinned image.
- **SSRF / trusted host:** the magnet and TorrServer base URL must bypass `validateUrl`
  (§3). Only the *configured* TorrServer base URL is trusted; never feed the magnet into the
  normal download path's `validateUrl`. The admin-set `torrServerBaseUrl` is itself an SSRF
  vector (admin could point it at an internal service) — acceptable since it's admin-only, but
  validate it parses as a well-formed `http(s)` origin before storing.
- **Repo-wide `videoPath = local file` assumptions (audit beyond the player — important):** many
  subsystems assume `videoPath` resolves to a file under `VIDEOS_DIR`. A `torrent:` entry has no
  local file and will misbehave unless each is taught to skip/special-case it. Verified hits:
  - **Media Integrity Check** — `backend/src/services/mediaIntegrityAuditService.ts` (~L436-439)
    sends any non-`cloud:`/`mount:` `videoPath` down the local branch and reports `file_missing`.
    Left unpatched it marks **every** torrent stream entry as broken. Must skip `torrent:`.
  - **Media-server export** — `backend/src/services/mediaServerExport/pathPlanner.ts` (~L64) +
    `syncService.ts` resolve `videoPath` against `VIDEOS_DIR` and `pathExistsSafeSync` it; torrent
    entries have no file → export skips/errors. Decide: exclude, or export only Mode-B downloads.
  - Also sweep: the **delete path** (don't `unlink` a nonexistent file; do call `removeTorrent`),
    **static media serving** (`server/staticRoutes.ts`), **RSS enclosure URLs** (should point at
    the same-origin proxy + feed-token auth), and **external clients** (Android / MCP / media-server
    consumers) that assume a downloadable file URL.
- **Library "unavailable" state:** a stream-mode entry depends on live seeders and can become
  unplayable later. The `videos` model has no ephemeral/unavailable state today; consider a UI
  affordance (badge or health check) so a dead torrent entry isn't indistinguishable from a
  broken local file.
- **Retention/cleanup:** stream-mode videos reference TorrServer; add a cleanup path that
  removes the TorrServer torrent when the MyTube video is deleted (`removeTorrent(hash)`),
  and decide cache/seeding policy.
- **Auth:** if MyTube login is enabled, prefer proxy mode (§6c) so torrent playback inherits
  MyTube's media auth instead of exposing TorrServer.
- **Legal:** same as any torrent client; MyTube's existing disclaimer covers user
  responsibility.

## 9. File-level integration points (verified)

| Concern | Location |
|---|---|
| Video data model | `backend/src/db/schema.ts` (`videos` table; add `torrent:` convention to `videoPath`, `source="torrent"`) |
| Downloader abstraction (Mode B) | `backend/src/services/downloaders/BaseDownloader.ts:58` + siblings |
| Add-download dispatch / route | `backend/src/routes` + `backend/src/controllers` (implementer: find the current add-download handler) |
| Save a video row | `backend/src/services/storageService` (`saveVideo`) |
| SSRF guard to bypass for TorrServer | `backend/src/utils/security.ts` `validateUrl()` |
| Playable-URL resolver | `frontend/src/hooks/useCloudStorageUrl.ts`; consumed at `frontend/src/pages/VideoPlayer.tsx:200` |
| Native player element | `frontend/src/components/VideoPlayer/VideoControls/VideoElement.tsx` |
| Cross-origin handling | `frontend/src/utils/mediaOrigin.ts` |
| Settings (mirror cloud config) | settings schema/service + Settings UI (OpenList/Alist config as template) |
| Media auth (cookie/session) | `backend/src/middleware/mediaAuthMiddleware.ts` (`requireAuthenticatedMediaAccess`); gate the proxy route here |
| Media Integrity Check (must skip `torrent:`) | `backend/src/services/mediaIntegrityAuditService.ts` (~L436) — else flags torrent entries `file_missing` |
| Media-server export (must skip/special-case) | `backend/src/services/mediaServerExport/pathPlanner.ts`, `syncService.ts` (`pathExistsSafeSync` on `VIDEOS_DIR`) |
| Deployment (three files) | `stacks/docker-compose.yml`, `docker-compose.host-network.yml`, `docker-compose.single-container.yml` (§4) |

## 10. Implementation plan (phased)

1. **TorrServer service + client** — compose service (all three compose files, §4);
   `torrserver/` client; settings fields + Settings UI; health check.
2. **Backend proxy endpoint** — Range-forwarding `GET /api/torrent-stream/:hash/:index`
   (206 passthrough, Range/Content-Range/Accept-Ranges, client-abort teardown), auth-gated,
   `validateUrl`-bypassed to the trusted base URL. (This is the required transport, so it comes
   before frontend playback — not a later add-on.)
3. **Mode A ingestion** — add-magnet endpoint → add to TorrServer (`save_to_db:true`) → create
   `videos` row(s) with `torrent:` `videoPath`; dedup; title/fileSize metadata (duration null).
4. **Frontend resolve + UI** — `isTorrentPath` in `cloudStorage.ts`; `torrent:`→same-origin
   proxy URL in the resolver hook; poster branch at `VideoPlayer.tsx:203`; add-magnet input;
   source badge; verify MP4 plays end-to-end.
5. **Codec breadth** — TorrServer transcode/HLS + hls.js branch in `VideoElement.tsx`.
6. **`videoPath` audit** — teach the file-assuming subsystems to skip `torrent:`: Media Integrity
   Check, media-server export, delete path, static serving, RSS enclosures, external clients (§8).
7. **Lifecycle** — delete-video → `removeTorrent`; cache/seeding policy; multi-file picker;
   "unavailable" state affordance; optional Mode B "download for offline".

## 11. Test plan

- Unit: TorrServer client (add/get/stream-url build), resolver scheme handling, SSRF-bypass
  boundary.
- Integration: add-magnet → `videos` row shape; proxy endpoint forwards Range (206 +
  `Content-Range`).
- E2E: paste a public-domain magnet (e.g. Sintel
  `magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10`) → appears in library →
  plays within seconds → seek works (random-access range).

## 12. Open questions

- Multi-file torrents / TV seasons: one `videos` row per episode (collection) vs. one with a
  file picker?
- Default mode (stream vs download) and whether to auto-offline popular items.
- Seeding/ratio policy and cache eviction defaults.
