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
import { fetchNodeProfile, getCachedNodeProfile, outsideMessagesOn } from './node-profile';
import { failUnsent, syncOutsideMail, OutsideMailError, type OutsideMailContext, type SyncOutcome } from './outside-mail';

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

/**
 * Whether the community the phone is set to takes messages from other communities, by the profile this phone keeps, read from
 * the community when it keeps none yet (a new phone's first minute, a restore from 12 words).
 */
export async function outsideMessagesHere(nodeUrl: string): Promise<boolean> {
    return outsideMessagesOn((await profileHere(nodeUrl))?.features);
}

/** The community's profile as this phone keeps it, read from the community when it keeps none; null when neither can be had. */
async function profileHere(nodeUrl: string) {
    return (await getCachedNodeProfile(nodeUrl).catch(() => null)) ?? (await fetchNodeProfile(nodeUrl).catch(() => null));
}

/**
 * How long one round may take in the app before it is given up: every request in it is aborted (React Native's fetch never
 * gives up by itself), and the next caller starts a new round. Well over a healthy round: a page, its confirm, and a receipt
 * to each sender, each forwarded by my server to theirs (up to 10 s each).
 */
export const OUTSIDE_ROUND_MS = 45_000;
/** How long a send from the chat waits for my server before the line is left `sending`, to go at the next round. */
export const OUTSIDE_SEND_MS = 20_000;
/** The background task's own budget for this step (services/background-task.ts), as the notices step has its 8 s. */
export const OUTSIDE_BACKGROUND_MS = 8_000;
/** What iOS gives the background task (~30 s), less a margin for the task's own end. */
const BACKGROUND_WINDOW_MS = 28_000;
/** Less than this left: the step is skipped, and its mail waits for the next wake or the app. */
const BACKGROUND_MIN_MS = 2_000;

/**
 * The background step's budget, `elapsedMs` into the task (after the sync's 20 s fail-fast and the notices' 8 s at worst):
 * its own budget, or what is left of iOS's window when that is less, or 0 (skip) when too little is left.
 */
export function backgroundMailBudget(elapsedMs: number): number {
    const left = BACKGROUND_WINDOW_MS - elapsedMs;
    return left < BACKGROUND_MIN_MS ? 0 : Math.min(OUTSIDE_BACKGROUND_MS, left);
}

let running: Promise<SyncOutcome | null> | null = null;

/**
 * One round, never two at once; null when nothing was asked (no community, no account, the switch off, unreachable) or the
 * round ran out of time. A round has a deadline, `budgetMs`: at it, every request still out is aborted, the round answers
 * null and is let go, so one stalled request never stops the rounds after it (the chat's poll, the Chat tab, the background
 * task). A caller that finds a round running shares it, but waits no longer than its own budget.
 */
export function syncOutsideMailNow(budgetMs: number = OUTSIDE_ROUND_MS): Promise<SyncOutcome | null> {
    if (running) return atMost(running, budgetMs);
    const round = roundWithDeadline(budgetMs);
    running = round;
    void round.finally(() => { if (running === round) running = null; });
    return round;
}

function roundWithDeadline(deadlineMs: number): Promise<SyncOutcome | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
            controller.abort();
            console.warn('[OutsideMail] This round ran out of time; the next one starts afresh.');
            resolve(null);
        }, deadlineMs);
    });
    const work = (async (): Promise<SyncOutcome | null> => {
        try {
            const ctx = await outsideContext();
            if (!ctx) return null;
            const profile = await profileHere(ctx.nodeUrl);
            if (!outsideMessagesOn(profile?.features)) {
                // Read, and off: my server would refuse my waiting lines (403), and no round will run to send them. They fail
                // now, saying why, rather than say "Sending…" for good. Not read at all: nothing is known, nothing changes.
                if (profile && await failUnsent(ctx, t("This community doesn't take messages from other communities.")) > 0) {
                    DeviceEventEmitter.emit(OUTSIDE_CHATS_UPDATED);
                }
                return null;
            }
            const out = await syncOutsideMail({ ...ctx, signal: controller.signal });
            if (out.written || out.requests || out.ticks) DeviceEventEmitter.emit(OUTSIDE_CHATS_UPDATED);
            return out;
        } catch (e) {
            if (!controller.signal.aborted) console.warn('[OutsideMail] This round did not finish:', (e as Error)?.message ?? e);
            return null;
        }
    })();
    return Promise.race([work, timedOut]).finally(() => clearTimeout(timer));
}

/** `p`, or null once `ms` pass first. */
function atMost<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([p, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); })]).finally(() => clearTimeout(timer));
}

/**
 * What to tell the member when a send or an answer didn't go: the server's own words, else ours. `kept` false: no line was
 * kept (outside-mail.ts sendFromBox), so nothing will be tried again, and the words wait in the box.
 */
export function outsideErrorWords(e: unknown, kept = true): string {
    if (e instanceof OutsideMailError && e.message && !/^HTTP \d+$/.test(e.message)) return e.message;
    return kept
        ? t("That didn't go through. It will be tried again when you're back online.")
        : t("That didn't go through. Your message is still there to send again.");
}
