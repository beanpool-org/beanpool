import { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { t } from '@beanpool/core';
import { useIdentity } from '../app/IdentityContext';
import { getSavedNodes, removeSavedNode, addSavedNode, isGuestNode } from './nodes';
import { assertPlainNodeAddress } from './node-url';
import { getLastSyncTime } from '../services/pillar-sync';
import { communityName, realName } from './community-name';
import { fetchMembership } from './membership-probe';
import { communitySwitched } from './community-switch';

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

let moving = false;

/** Whether a {@link switchCommunity} is under way: a second one waits for nothing and starts nothing. */
export function communitySwitchUnderWay(): boolean {
    return moving;
}

/**
 * The phone moves to another community it keeps: a tap on the BeanPool sheet's row (`switchTo` below), and a tap on a
 * notice from that community (push-notice-switch.ts). The one switch for both. The community becomes the phone's (its own
 * database, the anchor, the update screen told), then back to the bottom of the stack and the whole app through Welcome
 * for it, where the root guard lands the member (member-landing.ts). `beforeWelcome` runs between the two, once the
 * community is the phone's: a tapped notice asks the root layout's recognition again there, so the guard reads this
 * community's answer, and asks for its screen. Throws, before anything moves, for an address that isn't plain.
 */
export async function switchCommunity(url: string, beforeWelcome?: () => Promise<void>): Promise<void> {
    moving = true;
    try {
        // Only a plain host[:port] becomes the phone's community (node-url.ts); refused before anything moves.
        assertPlainNodeAddress(url);
        const { closeDB, initDB } = await import('./db');
        await closeDB();
        await AsyncStorage.setItem('beanpool_anchor_url', url);
        await initDB();
        // The full-screen "Update required" was the community left's; the one now in use is asked at once, so
        // switching back to a community whose floor stops this app puts it up again (utils/community-switch.ts).
        communitySwitched();
        await beforeWelcome?.().catch((e) => console.warn('[Communities] Before the bounce through Welcome', e));
        // Back to the bottom of the stack, then bounce the whole app through Welcome for the new community.
        if (router.canDismiss()) router.dismissAll();
        router.replace('/welcome');
    } finally {
        moving = false;
    }
}

async function getJson(url: string | ((signal: AbortSignal) => Promise<Response>)): Promise<any | null> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), PING_MS);
    try {
        const r = typeof url === 'string' ? await fetch(url, { signal: controller.signal }) : await url(controller.signal);
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
                    // Signed by the key (membership-probe.ts): each community answers only its own key.
                    const m = await getJson((signal) => fetchMembership(n.url, identity ?? me, signal));
                    member = m ? !!m.isMember : !(await isGuestNode(n.url).catch(() => false));
                }
                patch(n.url, { status: member ? 'online' : 'guest' });
            });
        })();
        return () => { alive = false; };
    }, [me]);

    const switchTo = useCallback(async (url: string) => {
        if (url === active || switching || communitySwitchUnderWay()) return;
        setSwitching(true);
        try {
            await switchCommunity(url);
        } catch (e: any) {
            setSwitching(false);
            Alert.alert(t("Couldn't switch community"), e?.message || t('Please try again.'));
        }
    }, [active, switching]);

    const remove = useCallback((row: CommunityRow) => {
        Alert.alert(t('Remove community?'), t('Remove {name} from your saved list?', { name: row.name }), [
            { text: t('Cancel'), style: 'cancel' },
            {
                text: t('Remove'), style: 'destructive', onPress: async () => {
                    const takeOffList = async () => {
                        await removeSavedNode(row.url).catch(() => {});
                        setRows(prev => prev.filter(r => r.url !== row.url));
                    };
                    // The row of the community in use comes off the list, but the phone stays set to it and it comes
                    // back with the next read (nodes.ts getSavedNodes): its alerts stay.
                    if (row.url === active) return takeOffList();
                    const { forgetCommunityPush } = await import('./account-leaves-phone');
                    await forgetCommunityPush(identity, row.url, takeOffList);
                },
            },
        ]);
    }, [identity, active]);

    const current = rows.find(r => r.url === active) ?? null;
    return { active, current, rows, lastSync, switching, switchTo, remove };
}
