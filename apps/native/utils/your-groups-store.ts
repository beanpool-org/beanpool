/**
 * One copy of "Your groups" for the whole app (groups decisions 6, 7): Talk → Groups and Commons → Groups show the
 * same list, so they share it rather than each asking the node.
 *
 * Built for a slow or dropping connection:
 * - at most one GET /api/your-groups in flight; asks made meanwhile become ONE follow-up request, not a queue
 *   (Talk re-loads on every sync nudge, and those come in bursts);
 * - the last list stays on screen while a refresh runs, and stays when it fails;
 * - opening a chat clears its count at once (markRead), and an answer that left the node before that read cannot
 *   bring the count back;
 * - newest line first, the member's own included (core chat-list-order.ts; Marty, 16 Nov 2026): a line sent from this
 *   phone puts its chat at the top at once (noteSent), and keeps it there until an answer asked after the send shows a
 *   newer line in it, so an answer that left the node before the line got there cannot put the chat back.
 *
 * Pure apart from the injected fetcher, so it is unit tested.
 */

import { chatTimeMs, movedAtWithSend, newestChatsFirst, sentHere, sentHereSettled, t, type ChatSentHere } from '@beanpool/core';
import { markChatRead, setChatMute, type YourChat, type YourChatMute, type YourChatsResponse } from './your-groups';

export interface YourGroupsState {
    /** null until the first answer. */
    items: YourChat[] | null;
    /** The last refresh's failure, cleared by the next success. */
    error: string | null;
    loading: boolean;
}

/**
 * The lists Talk → Groups draws as one (the community in use's, and each other community's this phone holds, slice S6): where
 * each one's chats stand. A line sent in any of them takes the top of them all, whatever this phone's clock says.
 */
export const TALK_GROUPS = new Set<() => number[]>();

/** `drawnWith`: the lists this one is drawn among ({@link TALK_GROUPS}); left out, it is drawn alone. */
export function createYourGroupsStore(fetcher: () => Promise<YourChatsResponse>, now: () => number = Date.now, drawnWith?: Set<() => number[]>) {
    let state: YourGroupsState = { items: null, error: null, loading: false };
    const listeners = new Set<() => void>();
    let inflight: Promise<void> | null = null;
    let again = false;
    // conversationId → when it was read here. An answer from a request that started before then shows it as read.
    const readAt = new Map<string, number>();
    // conversationId → a line sent from here the node's list may not show yet: the chat stays at the top (applySends).
    const sends = new Map<string, ChatSentHere>();

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

    /** A chat's place in the list: its newest line (the node's lastActivityAt), or a send from here not yet in it. */
    const movedAt = (item: YourChat) => movedAtWithSend(chatTimeMs(item.lastActivityAt), sends.get(item.conversationId));
    const places = () => (state.items ?? []).map(movedAt);
    drawnWith?.add(places);

    /** The node's answer, asked at `startedAt`, with this phone's sends that it doesn't show yet: newest first. */
    const applySends = (items: YourChat[], startedAt: number): YourChat[] => {
        if (sends.size === 0) return items;
        for (const [conversationId, sent] of sends) {
            const item = items.find(i => i.conversationId === conversationId);
            // A chat the member is no longer in has no row to keep at the top.
            if (!item ? startedAt > sent.mark : sentHereSettled(sent, chatTimeMs(item.lastActivityAt), startedAt)) sends.delete(conversationId);
        }
        return newestChatsFirst(items, movedAt);
    };

    const runOnce = async () => {
        const startedAt = now();
        set({ loading: true });
        try {
            const res = await fetcher();
            const sent = sends.size;
            const items = applySends(applyReads(res.items, startedAt), startedAt);
            // A send settled moves its chat's place (movedAt), the rows the same or not.
            const same = state.items && sent === sends.size && JSON.stringify(state.items) === JSON.stringify(items);
            set({ items: same ? state.items : items, error: null, loading: false });
        } catch (e: any) {
            set({ error: e?.message || t('Could not load your groups.'), loading: false });
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
        /** Where a chat stands in the list: its newest line, or a send from here not yet in it. What a list drawn of several is ordered by. */
        movedAt,
        /** No longer drawn (a community the phone let go): its chats' places count no more. */
        leaveDrawn() { drawnWith?.delete(places); },
        /** Opening a chat reads it. Call again when the node confirms, so an answer already on its way is covered too. */
        markRead(conversationId: string) {
            readAt.set(conversationId, now());
            if (state.items) {
                const items = markChatRead(state.items, conversationId);
                if (items !== state.items) set({ items });
            }
        },
        /**
         * This member sent a line in a chat (the node took it, or it is on its way): the chat goes to the top at once, as
         * the line shows at once in the chat, whatever this phone's clock says against the node's.
         */
        noteSent(conversationId: string) {
            const items = state.items ?? [];
            const own = items.find(i => i.conversationId === conversationId);
            const listed = drawnWith ? [...drawnWith].flatMap((chats) => chats()) : places();
            sends.set(conversationId, sentHere(own ? chatTimeMs(own.lastActivityAt) : 0, listed, now(), now()));
            if (state.items) set({ items: newestChatsFirst(state.items, movedAt) });
        },
        /** This member muted or unmuted a chat: its row (and so the Groups total) shows it now, not at the next refresh. */
        setMute(conversationId: string, mute: YourChatMute | null) {
            if (!state.items) return;
            const items = setChatMute(state.items, conversationId, mute);
            if (items !== state.items) set({ items });
        },
        /**
         * Forget everything (another identity on this phone). Silent: it is called while a screen renders, and every
         * screen reading the store reads the fresh state on that render anyway.
         */
        reset() {
            readAt.clear();
            sends.clear();
            state = { items: null, error: null, loading: false };
        },
    };
}

export type YourGroupsStore = ReturnType<typeof createYourGroupsStore>;
