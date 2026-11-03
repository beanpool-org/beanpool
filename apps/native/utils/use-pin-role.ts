import { useEffect, useState } from 'react';
import type { PinRole } from './pins';

/**
 * The signed-in member's role on this community as the node said it (utils/node-admin.ts `cachedNodeRole`, kept in memory
 * ten minutes), asked only when `ask` is true (pins are on here) and `memberKey` (the signed-in key, from the screen) is
 * known. It decides only what the "···" offers; the node checks every pin and unpin. Null until heard and for any failure,
 * so a plain member never sees an option that is not theirs.
 *
 * node-admin.ts pulls in the phone-unlock modules, node-post.ts the signing library and identity.ts the key store, so all
 * three load only when a role is wanted: a screen that draws a poll card or an event on a community with pins off never
 * loads them.
 */
export function usePinRole(ask: boolean, memberKey: string | null | undefined): PinRole {
    const [role, setRole] = useState<PinRole>(null);
    useEffect(() => {
        if (!ask || !memberKey) { setRole(null); return; }
        let cancelled = false;
        void (async () => {
            const [{ anchorUrl }, { cachedNodeRole }, { loadIdentity }] = await Promise.all([import('./node-post'), import('./node-admin'), import('./identity')]);
            const url = await anchorUrl();
            const identity = await loadIdentity();
            if (!url || !identity || identity.publicKey !== memberKey) return;
            const mine = await cachedNodeRole(url, identity);
            if (!cancelled) setRole(mine.role);
        })().catch(() => {});
        return () => { cancelled = true; };
    }, [ask, memberKey]);
    return role;
}
