/**
 * One copy of "Your groups" for the whole app (groups decisions 6, 7): Talk → Groups and Commons → Groups show the
 * same list, so they share it rather than each asking the node.
 *
 * Built for a slow or dropping connection:
 * - at most one GET /api/your-groups in flight; asks made meanwhile become ONE follow-up request, not a queue
 *   (Talk re-loads on every sync nudge, and those come in bursts);
 * - the last list stays on screen while a refresh runs, and stays when it fails;
 * - opening a chat clears its count at once (markRead), and an answer that left the node before that read cannot
 *   bring the count back.
 *
 * Pure apart from the injected fetcher, so it is unit tested.
 */

import { markChatRead, type YourChat, type YourChatsResponse } from './your-groups';

export interface YourGroupsState {
    /** null until the first answer. */
    items: YourChat[] | null;
    /** The last refresh's failure, cleared by the next success. */
    error: string | null;
    loading: boolean;
}

export function createYourGroupsStore(fetcher: () => Promise<YourChatsResponse>, now: () => number = Date.now) {
    let state: YourGroupsState = { items: null, error: null, loading: false };
    const listeners = new Set<() => void>();
    let inflight: Promise<void> | null = null;
    let again = false;
    // conversationId → when it was read here. An answer from a request that started before then shows it as read.
    const readAt = new Map<string, number>();

    const set = (next: Partial<YourGroupsState>) => {
        state = { ...state, ...next };
        listeners.forEach(l => l());
    };

    const applyReads = (items: YourChat[], startedAt: number): YourChat[] => {
        let out = items;
        for (const [conversationId, at] of readAt) {
            if (startedAt < at) out = markChatRead(out, conversationId);
            else readAt.delete(conversationId);
        }
        return out;
    };

    const runOnce = async () => {
        const startedAt = now();
        set({ loading: true });
        try {
            const res = await fetcher();
            const items = applyReads(res.items, startedAt);
            const same = state.items && JSON.stringify(state.items) === JSON.stringify(items);
            set({ items: same ? state.items : items, error: null, loading: false });
        } catch (e: any) {
            set({ error: e?.message || 'Could not load your groups.', loading: false });
        }
    };

    function refresh(): Promise<void> {
        if (inflight) {
            again = true;
            return inflight;
        }
        inflight = (async () => {
            try {
                do {
                    again = false;
                    await runOnce();
                } while (again);
            } finally {
                inflight = null;
            }
        })();
        return inflight;
    }

    return {
        getState: () => state,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        refresh,
        /** Opening a chat reads it. Call again when the node confirms, so an answer already on its way is covered too. */
        markRead(conversationId: string) {
            readAt.set(conversationId, now());
            if (state.items) {
                const items = markChatRead(state.items, conversationId);
                if (items !== state.items) set({ items });
            }
        },
        /**
         * Forget everything (another identity on this phone). Silent: it is called while a screen renders, and every
         * screen reading the store reads the fresh state on that render anyway.
         */
        reset() {
            readAt.clear();
            state = { items: null, error: null, loading: false };
        },
    };
}

export type YourGroupsStore = ReturnType<typeof createYourGroupsStore>;
