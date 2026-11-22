/**
 * Node URI resolution hook for a shop's picture and banner on the phone.
 *
 * Resolves a picture's address to draw: one of the node's own (`/api/…`, as a shop's banner comes)
 * on the phone's community once its anchor is known; any other as it is (e.g. data URLs or absolute URLs).
 * Null for none, and while it is being read.
 *
 * The community is the one in use as the page opens, so only a page that reads its shop then may use it (the shops' pages alone:
 * photo-address-class.test.ts). Never a picture a list or a card holds: that takes the address it came with (utils/photo-address.ts).
 */
import { useEffect, useState } from 'react';
import { anchorUrl } from './node-post';
import { photoOnCommunity } from './photo-address';

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
    return anchor ? photoOnCommunity(anchor, url) : null;
}
