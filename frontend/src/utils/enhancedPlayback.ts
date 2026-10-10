import { encodeLocalMediaPath, isHttpUrl, withApiKey } from './localMediaPath';

export type EnhanceTier = 'speed' | 'quality' | 'max' | 'photo';
export type EnhancePlayer = 'iina' | 'senplayer';

interface VideoLike {
    sourceUrl?: string;
    videoPath?: string | null;
    signedUrl?: string;
}

/**
 * Resolve the URL to hand to the local ytplay enhance pipeline.
 *
 * Preference order:
 *  1. A web `sourceUrl` (YouTube/Bilibili/etc) — ytplay re-extracts the full
 *     source and enhances it (best quality, no MyTube auth needed).
 *  2. Otherwise the MyTube media URL (local upload / torrent stream / cloud),
 *     made absolute so the external ytplay process can fetch it. This path
 *     needs the media to be reachable without a session cookie (e.g. login
 *     disabled, or a token embedded in the URL).
 *
 * Returns null when no usable URL exists.
 */
export const resolveHandoffUrl = (
    video: VideoLike,
    origin: string,
    apiKey?: string | null
): string | null => {
    if (video.sourceUrl && isHttpUrl(video.sourceUrl)) {
        // Web source (YouTube/Bilibili/etc): ytplay re-extracts it, no MyTube
        // auth involved — never attach the key here.
        return video.sourceUrl;
    }

    const toAbsolute = (pathOrUrl: string): string =>
        isHttpUrl(pathOrUrl)
            ? pathOrUrl
            : `${origin.replace(/\/$/, '')}${
                  pathOrUrl.startsWith('/') ? '' : '/'
              }${pathOrUrl}`;

    // signedUrl is MyTube's resolved media path (torrent proxy, cloud, mount).
    // It's behind auth, and the external player can't send a header, so embed
    // the API key as a query param when available.
    if (video.signedUrl) {
        return withApiKey(toAbsolute(video.signedUrl), apiKey);
    }
    if (video.videoPath && isHttpUrl(video.videoPath)) {
        return video.videoPath;
    }
    // Local file served at /videos/...; encode special filename characters.
    // Also same-origin + auth-gated, so attach the key.
    if (
        video.videoPath &&
        !video.videoPath.startsWith('cloud:') &&
        !video.videoPath.startsWith('mount:') &&
        !video.videoPath.startsWith('torrent:')
    ) {
        return withApiKey(toAbsolute(encodeLocalMediaPath(video.videoPath)), apiKey);
    }
    return null;
};

/**
 * Build the `ytplay://` URL that the local scheme handler turns into a
 * `streamlink-ytplay` invocation. Contract agreed with the streamlink side:
 *   ytplay://play?url=<enc>&quality=best&enhance=<tier>&player=<player>
 */
export const buildYtplayUrl = (opts: {
    handoffUrl: string;
    tier: EnhanceTier;
    player: EnhancePlayer;
    quality?: string;
}): string => {
    const quality = opts.quality && opts.quality.length > 0 ? opts.quality : 'best';
    const params = new URLSearchParams({
        url: opts.handoffUrl,
        quality,
        enhance: opts.tier,
        player: opts.player,
    });
    return `ytplay://play?${params.toString()}`;
};
