import { describe, expect, it } from 'vitest';
import { resolveProxyMediaUrl, withApiKey } from '../localMediaPath';

describe('withApiKey', () => {
    it('appends apiKey with ? when the URL has no query string', () => {
        expect(withApiKey('https://x/api/torrent-stream/v1', 'abc')).toBe(
            'https://x/api/torrent-stream/v1?apiKey=abc'
        );
    });

    it('appends apiKey with & when the URL already has a query string', () => {
        expect(withApiKey('https://x/api/torrent-stream/v1?foo=1', 'abc')).toBe(
            'https://x/api/torrent-stream/v1?foo=1&apiKey=abc'
        );
    });

    it('url-encodes the key', () => {
        const key = 'a/b c';
        expect(withApiKey('https://x/m', key)).toBe(
            `https://x/m?apiKey=${encodeURIComponent(key)}`
        );
    });

    it('is a no-op without a key', () => {
        expect(withApiKey('https://x/m')).toBe('https://x/m');
        expect(withApiKey('https://x/m', '')).toBe('https://x/m');
        expect(withApiKey('https://x/m', null)).toBe('https://x/m');
    });
});

describe('resolveProxyMediaUrl', () => {
    const origin = 'https://media.example';

    it('resolves a torrent video to the stream proxy keyed by id, with the key', () => {
        expect(
            resolveProxyMediaUrl({ id: 'v1', videoPath: 'torrent:deadbeef/5' }, origin, 'k')
        ).toBe('https://media.example/api/torrent-stream/v1?apiKey=k');
    });

    it('resolves a mount video to the mount-video proxy keyed by id', () => {
        expect(
            resolveProxyMediaUrl({ id: 'm1', videoPath: 'mount:Movies/a.mkv' }, origin, 'k')
        ).toBe('https://media.example/api/mount-video/m1?apiKey=k');
    });

    it('omits the key when none is provided', () => {
        expect(
            resolveProxyMediaUrl({ id: 'v1', videoPath: 'torrent:deadbeef/5' }, origin)
        ).toBe('https://media.example/api/torrent-stream/v1');
    });

    it('returns null for non-torrent/mount schemes so callers fall back', () => {
        expect(resolveProxyMediaUrl({ id: 'v1', videoPath: 'videos/x.mp4' }, origin, 'k')).toBeNull();
        expect(resolveProxyMediaUrl({ id: 'v1', videoPath: 'cloud:x.mp4' }, origin, 'k')).toBeNull();
        expect(resolveProxyMediaUrl({ id: 'v1' }, origin, 'k')).toBeNull();
    });
});
