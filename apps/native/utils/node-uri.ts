/**
 * Node URI resolution hook for pictures and banners on the phone.
 *
 * Resolves a picture's address to draw: one of the node's own (`/api/…`, as a shop's banner comes)
 * on the phone's community once its anchor is known; any other as it is (e.g. data URLs or absolute URLs).
 * Null for none, and while it is being read.
 */
import { useEffect, useState } from 'react';
import { anchorUrl } from './node-post';

export function useNodeUri(url: string | null | undefined): string | null {
    const relative = typeof url === 'string' && url.startsWith('/');
    const [anchor, setAnchor] = useState<string | null>(null);
    useEffect(() => {
        if (!relative) return;
        let live = true;
        void anchorUrl().then((a) => { if (live) setAnchor(a); }).catch(() => {});
        return () => { live = false; };
    }, [relative]);
    if (!url) return null;
    if (!relative) return url;
    return anchor ? `${anchor.replace(/\/+$/, '')}${url}` : null;
}
