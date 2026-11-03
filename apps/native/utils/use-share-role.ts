/**
 * This phone's member's role here, for the lines under the Share buttons (share-says): asked only where it changes what
 * is said (a community where only admins invite, or a private preview). A role, null (the node said none), or
 * undefined (not asked, not heard yet, or no answer and nothing remembered): shareSays says nothing for undefined
 * rather than guess that the member is no admin.
 *
 * Asked through the header's ten-minute cache. With no answer (offline) it falls back on the last role this node gave
 * for this key, kept on the phone (node-admin.ts readPersistedNodeRole), as People -> Invites does, so an owner or
 * admin offline still sees their buttons. It decides nothing the node does not re-check.
 */
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ShareSaysFeatures, ShareSaysRole } from '@beanpool/core';

export function useShareRole(features: ShareSaysFeatures | null | undefined): ShareSaysRole {
    const [role, setRole] = useState<ShareSaysRole>(undefined);
    const needsRole = features?.door === 'admins' || features?.privatePreview === true;

    useEffect(() => {
        if (!needsRole) return;
        let cancelled = false;
        (async () => {
            try {
                const anchor = await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null);
                if (!anchor) return;
                const { loadIdentity } = await import('./identity');
                const identity = await loadIdentity().catch(() => null);
                if (!identity) return;
                const { cachedNodeRoleHeard, persistNodeRole, readPersistedNodeRole } = await import('./node-admin');
                const heard = await cachedNodeRoleHeard(anchor, identity);
                if (heard) {
                    void persistNodeRole(anchor, identity.publicKey, heard.role);
                    if (!cancelled) setRole(heard.role);
                    return;
                }
                const last = await readPersistedNodeRole(anchor, identity.publicKey);
                if (!cancelled && last !== undefined) setRole(last);
            } catch {
                // Not known: no line, today's buttons.
            }
        })();
        return () => { cancelled = true; };
    }, [needsRole]);

    return role;
}
