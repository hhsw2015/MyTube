import { describe, expect, it } from 'vitest';
import { buildYtplayUrl, resolveHandoffUrl } from '../enhancedPlayback';

describe('resolveHandoffUrl', () => {
    const origin = 'https://mytube.example';

    it('prefers a web sourceUrl (re-extracted at full quality)', () => {
        expect(
            resolveHandoffUrl(
                { sourceUrl: 'https://www.youtube.com/watch?v=abc', videoPath: '/videos/x.mp4' },
                origin
            )
        ).toBe('https://www.youtube.com/watch?v=abc');
    });

    it('falls back to an absolute signedUrl for torrent/cloud entries', () => {
        expect(
            resolveHandoffUrl(
                { sourceUrl: 'magnet:?xt=urn:btih:abc', videoPath: 'torrent:abc/0', signedUrl: '/api/torrent-stream/v1' },
                origin
            )
        ).toBe('https://mytube.example/api/torrent-stream/v1');
    });

    it('makes a local videoPath absolute and encodes it', () => {
        expect(
            resolveHandoffUrl({ videoPath: '/videos/Show/Ep #3.mp4' }, origin)
        ).toBe('https://mytube.example/videos/Show/Ep%20%233.mp4');
    });

    it('passes through an already-absolute media URL', () => {
        expect(
            resolveHandoffUrl({ videoPath: 'http://cdn.example/v.mp4' }, origin)
        ).toBe('http://cdn.example/v.mp4');
    });

    it('returns null when there is nothing playable', () => {
        expect(resolveHandoffUrl({ videoPath: 'cloud:thing' }, origin)).toBeNull();
        expect(resolveHandoffUrl({}, origin)).toBeNull();
    });
});

describe('buildYtplayUrl', () => {
    it('builds the agreed ytplay:// contract with url-encoded target', () => {
        const url = buildYtplayUrl({
            handoffUrl: 'https://www.youtube.com/watch?v=abc&t=1',
            tier: 'quality',
            player: 'iina',
        });
        expect(url).toContain('ytplay://play?');
        expect(url).toContain('enhance=quality');
        expect(url).toContain('player=iina');
        expect(url).toContain('quality=best');
        // The target URL (including its own & and =) must be encoded.
        expect(url).toContain(
            `url=${encodeURIComponent('https://www.youtube.com/watch?v=abc&t=1')}`
        );
    });

    it('honors an explicit quality', () => {
        const url = buildYtplayUrl({
            handoffUrl: 'https://x/y',
            tier: 'max',
            player: 'senplayer',
            quality: '1080p',
        });
        expect(url).toContain('quality=1080p');
        expect(url).toContain('enhance=max');
        expect(url).toContain('player=senplayer');
    });
});
