import { useMemo } from 'react';
import { Video } from '../types';
import { isNewVideo } from '../utils/videoCardUtils';
import { useCloudStorageUrl } from './useCloudStorageUrl';
import { useThumbnailCandidates } from './useThumbnailCandidates';
import { encodeLocalMediaPath, isHttpUrl } from '../utils/localMediaPath';

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

    // Get video URL with fallback logic
    const getVideoUrl = async (): Promise<string> => {
        // If we have a cloud storage URL, use it directly
        if (videoUrl) {
            return videoUrl;
        }

        // Torrent (stream proxy) and mount videos resolve to same-origin API
        // endpoints keyed by video id. The backend exposes these as signedUrl on
        // the detail endpoint, but list/card payloads omit it — so build the path
        // from the id (mirrors the backend's signedUrl mapping). Without this the
        // raw "torrent:<hash>/<file>" (or "mount:") scheme was handed out verbatim
        // as a bogus, unplayable URL (e.g. copy-link / external player).
        if (video.videoPath?.startsWith('torrent:')) {
            return `${window.location.origin}/api/torrent-stream/${video.id}`;
        }
        if (video.videoPath?.startsWith('mount:')) {
            return `${window.location.origin}/api/mount-video/${video.id}`;
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
            return `${window.location.origin}${encodeLocalMediaPath(videoPath)}`;
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
