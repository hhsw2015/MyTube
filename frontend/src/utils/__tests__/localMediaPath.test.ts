import { describe, expect, it } from 'vitest';
import { withApiKey } from '../localMediaPath';

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
