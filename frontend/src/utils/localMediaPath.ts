/** HTTP(S) schemes are case-insensitive; signed URLs should be left untouched. */
export const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

/** Encode a filesystem-backed web path before using it as a browser URL. */
export const encodeLocalMediaPath = (path: string): string =>
    path.split('/').map(encodeURIComponent).join('/');

/**
 * Append the MyTube API key as a query param to a same-origin media URL so an
 * external player or the native <video> element — which open a plain URL and
 * cannot set an `x-api-key` header — can authenticate against an allowApiKey
 * media route. No-op when no key is given.
 *
 * SECURITY: embeds the admin API key in the URL. Fine for opening in your own
 * player, but do NOT share the resulting link publicly — anyone holding it can
 * call the API. Only use for same-origin `/api` media URLs.
 */
export const withApiKey = (url: string, apiKey?: string | null): string => {
    if (!apiKey) {
        return url;
    }
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}apiKey=${encodeURIComponent(apiKey)}`;
};
