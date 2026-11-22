/**
 * Node URI resolution hook for pictures and banners on the phone.
 *
 * Resolves a picture's address to draw: one of the node's own (`/api/…`, as a shop's banner comes)
 * on the phone's community once its anchor is known; any other as it is (e.g. data URLs or absolute URLs).
 * Null for none, and while it is being read.
 */
import { useEffect, useState } from 'react';
import { anchorUrl } from './node-post';
import { photoOnCommunity } from './photo-address';

/** The address of the community in use, read once something is drawn from it (`wanted`): null until then, and with none. */
export function useCommunityAddress(wanted: boolean): string | null {
    const [anchor, setAnchor] = useState<string | null>(null);
    useEffect(() => {
        if (!wanted) return;
        let live = true;
        void anchorUrl().then((a) => { if (live) setAnchor(a); }).catch(() => {});
        return () => { live = false; };
    }, [wanted]);
    return anchor;
}

export function useNodeUri(url: string | null | undefined): string | null {
    const relative = typeof url === 'string' && url.startsWith('/');
    const anchor = useCommunityAddress(relative);
    if (!url) return null;
    if (!relative) return url;
    return anchor ? photoOnCommunity(anchor, url) : null;
}
