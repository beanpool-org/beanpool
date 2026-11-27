/**
 * Whether the community in use answers, for People → Invites: it greys "Make them a voucher" ("Needs a connection…",
 * utils/invite-names.ts voucherBoxWhy) and turns Generate into "Generate Offline Ticket" when it says no.
 *
 * Marty, 28 Nov 2026 (phone 1.4.8): the box stayed greyed while the bean menu said "Connected", until the app was restarted.
 * The screen asked its community once, when Invites was first shown, with 2 s to answer, and never again: one slow answer
 * (the phone just woke, the radio waking) said "offline" for the whole visit. The app keeps no shared connection state to
 * read instead (the header's ping is its own, and the bean menu asks afresh each time it opens), so this asks the way the
 * header does, and more patiently than once:
 *  - each ask has 8 s (ONLINE_TIMEOUT_MS), as the header's health ping and the membership probe have;
 *  - a failed ask is tried again twice, after 1 s and then 3 s (ONLINE_RETRY_MS), before it says offline;
 *  - any answer says online at once;
 *  - it asks again each time the screen is shown (Invites opened, the tab focused) and each time the app comes back to the
 *    front; while it says offline and stays shown, again every 30 s (ONLINE_AGAIN_MS, the header's cadence);
 *  - it starts as online, as the screen always did: the box is never greyed before anything was heard.
 * Only the latest round writes: a round still out when the screen was left, or a newer round began, says nothing. Nothing is
 * asked while the screen isn't shown or the app is in the background.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';

/** Each ask's time to answer: the header's health ping (components/GlobalHeader.tsx) and NodeStatusContext's probe. */
export const ONLINE_TIMEOUT_MS = 8000;
/** The waits before the second and the third try of a round. */
export const ONLINE_RETRY_MS: readonly number[] = [1000, 3000];
/** While it says offline and the screen is shown, a new round this often (the header's ping cadence). */
export const ONLINE_AGAIN_MS = 30_000;

/** React Native's AppState, or nothing where a test double has none: then the app reads as always in front. */
function appState(): { currentState?: string; addEventListener?: (type: 'change', cb: (state: string) => void) => { remove(): void } } | null {
    try { return AppState ?? null; } catch { return null; }
}
/** 'unknown' is what an app still starting up reads before it knows; it is not the background. */
const appInFront = () => {
    const state = appState()?.currentState;
    return state === undefined || state === 'active' || state === 'unknown';
};

/** One ask: whether the community at `url` answers its health within the time. */
export async function healthAnswers(url: string, timeoutMs: number = ONLINE_TIMEOUT_MS): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${url}/api/community/health`, { method: 'GET', signal: controller.signal });
        return res.ok;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One round: the community in use asked, and asked again after each of `retries` while it doesn't answer. True at the first
 * answer; false when every try failed, or the phone has no community; null when `gone()` turned true on the way (the screen
 * was left, or a newer round began): then nothing is to be written.
 */
export async function askCommunityOnline(o: {
    ask: (url: string) => Promise<boolean>;
    anchor: () => Promise<string | null>;
    gone: () => boolean;
    retries?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
}): Promise<boolean | null> {
    const retries = o.retries ?? ONLINE_RETRY_MS;
    const sleep = o.sleep ?? wait;
    const url = await o.anchor().catch(() => null);
    if (o.gone()) return null;
    if (!url) return false;
    for (let i = 0; ; i++) {
        const answered = await o.ask(url);
        if (o.gone()) return null;
        if (answered) return true;
        if (i >= retries.length) return false;
        await sleep(retries[i]);
        if (o.gone()) return null;
    }
}

/**
 * True while the community in use answers (see the top of this file). `shown`: the caller's view is the one that needs it
 * (People: Invites). The tab's own focus is read here, and the app's place in front.
 */
export function useCommunityOnline(shown: boolean): boolean {
    const [online, setOnline] = useState(true);
    const turn = useRef(0);
    const live = useRef(false);
    const again = useRef<ReturnType<typeof setTimeout> | null>(null);

    const stop = useCallback(() => {
        turn.current += 1;
        if (again.current) { clearTimeout(again.current); again.current = null; }
    }, []);

    const check = useCallback(async () => {
        stop();
        const mine = turn.current;
        const answer = await askCommunityOnline({
            ask: (url) => healthAnswers(url),
            anchor: () => AsyncStorage.getItem('beanpool_anchor_url'),
            gone: () => !live.current || mine !== turn.current,
        });
        if (answer === null) return;
        setOnline(answer);
        if (!answer) again.current = setTimeout(() => { again.current = null; if (live.current && appInFront()) void check(); }, ONLINE_AGAIN_MS);
    }, [stop]);

    // Shown and focused: a round now. Left (another tab, another view, the screen unmounted): every round stops.
    useFocusEffect(useCallback(() => {
        if (!shown) return undefined;
        live.current = true;
        if (appInFront()) void check();
        return () => { live.current = false; stop(); };
    }, [shown, check, stop]));

    // Back in front: a round now. To the background: the round out stops, and the 30 s ask with it.
    useEffect(() => {
        const sub = appState()?.addEventListener?.('change', (next) => {
            if (next === 'active') { if (live.current) void check(); }
            else stop();
        });
        return () => sub?.remove();
    }, [check, stop]);

    return online;
}
