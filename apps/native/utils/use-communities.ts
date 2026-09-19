import { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useIdentity } from '../app/IdentityContext';
import { getSavedNodes, removeSavedNode, addSavedNode, isGuestNode } from './nodes';
import { getLastSyncTime } from '../services/pillar-sync';
import { communityName, realName } from './community-name';

// The communities this phone knows, for the BeanPool sheet: which one is in use, whether each answers and
// whether the member belongs to it, and switching between them. It used to live in the header's own modal;
// the bean now opens the BeanPool sheet, which is the one place this shows.

export type CommunityStatus = 'checking' | 'online' | 'guest' | 'offline';

export interface CommunityRow {
    url: string;
    name: string;
    status: CommunityStatus;
}

const PING_MS = 4000;

async function getJson(url: string): Promise<any | null> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), PING_MS);
    try {
        const r = await fetch(url, { signal: controller.signal });
        return r.ok ? await r.json() : null;
    } catch {
        return null;
    } finally {
        clearTimeout(t);
    }
}

export function useCommunities() {
    const { identity } = useIdentity();
    const me = identity?.publicKey;
    /** undefined while loading; null when the phone has no community. */
    const [active, setActive] = useState<string | null | undefined>(undefined);
    const [rows, setRows] = useState<CommunityRow[]>([]);
    const [lastSync, setLastSync] = useState<number | null>(null);
    const [switching, setSwitching] = useState(false);

    useEffect(() => {
        let alive = true;
        const patch = (url: string, p: Partial<CommunityRow>) => {
            if (alive) setRows(prev => prev.map(r => (r.url === url ? { ...r, ...p } : r)));
        };
        (async () => {
            const [nodes, anchor, synced] = await Promise.all([
                getSavedNodes().catch(() => []),
                AsyncStorage.getItem('beanpool_anchor_url').catch(() => null),
                getLastSyncTime().catch(() => null),
            ]);
            const list = nodes.map(n => ({ url: n.url, alias: n.alias }));
            if (anchor && !list.some(n => n.url === anchor)) list.unshift({ url: anchor, alias: undefined });
            if (!alive) return;
            setActive(anchor || null);
            setLastSync(synced);
            setRows(list.map(n => ({ url: n.url, name: communityName(n), status: 'checking' })));

            list.forEach(async n => {
                const health = await getJson(`${n.url}/api/community/health`);
                if (!health) { patch(n.url, { status: 'offline' }); return; }
                const nodeName = realName(health.nodeName) ?? realName(health.name);
                patch(n.url, { name: communityName({ ...n, nodeName }) });
                // Keep the saved copy of the node's name current, so the next open (and an offline one) shows it.
                if (nodeName && nodeName !== n.alias) {
                    addSavedNode(n.url, nodeName, health.currency?.type, health.currency?.value).catch(() => {});
                }
                let member: boolean;
                if (!me) member = false;
                else {
                    const m = await getJson(`${n.url}/api/community/membership/${me}`);
                    member = m ? !!m.isMember : !(await isGuestNode(n.url).catch(() => false));
                }
                patch(n.url, { status: member ? 'online' : 'guest' });
            });
        })();
        return () => { alive = false; };
    }, [me]);

    const switchTo = useCallback(async (url: string) => {
        if (url === active || switching) return;
        setSwitching(true);
        try {
            const { closeDB, initDB } = await import('./db');
            await closeDB();
            await AsyncStorage.setItem('beanpool_anchor_url', url);
            await initDB();
            // Back to the bottom of the stack, then bounce the whole app through Welcome for the new community.
            if (router.canDismiss()) router.dismissAll();
            router.replace('/welcome');
        } catch (e: any) {
            setSwitching(false);
            Alert.alert("Couldn't switch community", e?.message || 'Please try again.');
        }
    }, [active, switching]);

    const remove = useCallback((row: CommunityRow) => {
        Alert.alert('Remove community?', `Remove ${row.name} from your saved list?`, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Remove', style: 'destructive', onPress: async () => {
                    await removeSavedNode(row.url).catch(() => {});
                    setRows(prev => prev.filter(r => r.url !== row.url));
                },
            },
        ]);
    }, []);

    const current = rows.find(r => r.url === active) ?? null;
    return { active, current, rows, lastSync, switching, switchTo, remove };
}
