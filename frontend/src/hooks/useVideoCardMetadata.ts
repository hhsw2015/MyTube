import { useMemo } from 'react';
import { Video } from '../types';
import { isNewVideo } from '../utils/videoCardUtils';
import { useCloudStorageUrl } from './useCloudStorageUrl';
import { useSettings } from './useSettings';
import { useThumbnailCandidates } from './useThumbnailCandidates';
import { encodeLocalMediaPath, isHttpUrl, resolveProxyMediaUrl, withApiKey } from '../utils/localMediaPath';

interface UseVideoCardMetadataProps {
    video: Video;
}

/**
 * Hook to manage video card metadata: thumbnails, URLs, new video detection
 */
export const useVideoCardMetadata = ({ video }: UseVideoCardMetadataProps) => {
    // Cover URLs, best first: cloud signed URL (cloud videos only), then the
    // local /images-small mirror and its fallbacks.
    const { src: thumbnailSrc, candidates: thumbnailCandidates } =
        useThumbnailCandidates(video);

    // Use cloud storage hook for video URL
    const isAudioOnly = video.mediaType === 'audio';
    const mediaType = isAudioOnly ? 'audio' : 'video';
    const videoUrl = useCloudStorageUrl(video.videoPath, mediaType);

    // The copied / external-player URL for a torrent or mount video points at an
    // auth-gated proxy; embed the API key (admins receive it) so the link is
    // actually playable when opened outside the authenticated browser session.
    const { data: settings } = useSettings();
    const apiKey = settings?.apiKeyEnabled ? settings?.apiKey : undefined;

    // Get video URL with fallback logic
    const getVideoUrl = async (): Promise<string> => {
        // If we have a cloud storage URL, use it directly
        // useCloudStorageUrl returns a RELATIVE path for local /videos files; an
        // external player / copied link needs it absolute + with the API key.
        // Cloud/signed URLs are already absolute (http) — pass them through.
        if (videoUrl) {
            return isHttpUrl(videoUrl)
                ? videoUrl
                : withApiKey(`${window.location.origin}${videoUrl}`, apiKey);
        }

        // Torrent (stream proxy) and mount videos resolve to same-origin API
        // endpoints keyed by video id. The backend exposes these as signedUrl on
        // the detail endpoint, but list/card payloads omit it — so build the path
        // from the id (mirrors the backend's signedUrl mapping). Without this the
        // raw "torrent:<hash>/<file>" (or "mount:") scheme was handed out verbatim
        // as a bogus, unplayable URL (e.g. copy-link / external player).
        const proxied = resolveProxyMediaUrl(video, window.location.origin, apiKey);
        if (proxied) {
            return proxied;
        }

        // If cloud storage path but URL not loaded yet, wait for it
        if (video.videoPath?.startsWith('cloud:')) {
            // Try to get the signed URL directly
            const { getFileUrl } = await import('../utils/cloudStorage');
            const cloudUrl = await getFileUrl(video.videoPath, mediaType);
            if (cloudUrl) {
                return cloudUrl;
            }
            // If still not available, return empty string
            return '';
        }

        // Otherwise, construct URL from videoPath
        if (video.videoPath) {
            if (isHttpUrl(video.videoPath)) return video.videoPath;
            const videoPath = video.videoPath.startsWith('/') ? video.videoPath : `/${video.videoPath}`;
            // Local files are auth-gated too; embed the API key so copy-link /
            // external-player URLs work outside the browser (no-op when disabled).
            return withApiKey(`${window.location.origin}${encodeLocalMediaPath(videoPath)}`, apiKey);
        }
        return video.sourceUrl || '';
    };

    // Check if video is new (memoized)
    const isNew = useMemo(() => isNewVideo(video), [video.viewCount, video.addedAt, video.id]); // eslint-disable-line react-hooks/exhaustive-deps

    return {
        thumbnailSrc,
        thumbnailCandidates,
        thumbnailSrcSet: undefined,
        thumbnailSizes: undefined,
        // Audio-only cards have no video frames, so feeding this URL into the
        // hover-preview <video> would fade the cover to a black, silent player.
        // Withhold the preview URL for audio; getVideoUrl still resolves it for
        // actual playback.
        videoUrl: isAudioOnly ? undefined : videoUrl,
        getVideoUrl,
        isNew
    };
};
