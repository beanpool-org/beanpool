/**
 * Chats with people in other communities, as the screens and the syncs reach them (slice X3): the context for the community
 * the phone is set to (utils/outside-mail.ts), one round at a time, and the event screens listen to. Where the community
 * does not take messages from other communities (its node says nothing, or the owner's switch is off), nothing is asked.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter } from 'react-native';
import { t } from '@beanpool/core';
import { loadIdentity } from './identity';
import { isUserBlocked } from './blocklist';
import { getCachedNodeProfile, outsideMessagesOn } from './node-profile';
import { syncOutsideMail, OutsideMailError, type OutsideMailContext, type SyncOutcome } from './outside-mail';

/** Emitted after a round that changed anything here: a line in, a state moved, a chat made. */
export const OUTSIDE_CHATS_UPDATED = 'outside_chats_updated';

/** The context for the community the phone is set to, or null with no community or no account. */
export async function outsideContext(): Promise<OutsideMailContext | null> {
    const anchor = await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null);
    if (!anchor) return null;
    const identity = await loadIdentity().catch(() => null);
    if (!identity?.privateKey) return null;
    const { outsideStore } = await import('./db');
    return { nodeUrl: anchor.replace(/\/+$/, ''), identity, store: outsideStore(anchor), isBlocked: isUserBlocked };
}

/** Whether the community the phone is set to takes messages from other communities, by the profile this phone keeps. */
export async function outsideMessagesHere(nodeUrl: string): Promise<boolean> {
    const profile = await getCachedNodeProfile(nodeUrl).catch(() => null);
    return outsideMessagesOn(profile?.features);
}

let running: Promise<SyncOutcome | null> | null = null;

/** One round, never two at once; null when nothing was asked (no community, no account, the switch off, unreachable). */
export function syncOutsideMailNow(): Promise<SyncOutcome | null> {
    if (running) return running;
    running = (async () => {
        try {
            const ctx = await outsideContext();
            if (!ctx || !(await outsideMessagesHere(ctx.nodeUrl))) return null;
            const out = await syncOutsideMail(ctx);
            if (out.written || out.requests || out.ticks) DeviceEventEmitter.emit(OUTSIDE_CHATS_UPDATED);
            return out;
        } catch (e) {
            console.warn('[OutsideMail] This round did not finish:', (e as Error)?.message ?? e);
            return null;
        } finally {
            running = null;
        }
    })();
    return running;
}

/** What to tell the member when a send or an answer didn't go: the server's own words, else ours. */
export function outsideErrorWords(e: unknown): string {
    if (e instanceof OutsideMailError && e.message && !/^HTTP \d+$/.test(e.message)) return e.message;
    return t("That didn't go through. It will be tried again when you're back online.");
}
