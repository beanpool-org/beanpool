/**
 * Talk → Groups' rows from every other community this phone holds (slice S6, scratch/fable-design/DESIGN-no-switch-messaging-fable.md
 * §3, §6): each group the member is in there and each event whose chat they may read (the host, and the people Going it lets
 * in: that community's own list says which), with that community's name and its own unread count, opened in place
 * (components/GroupChatView.tsx, EventChatView.tsx `inPlace`). Each community is asked for its member's own list, signed for
 * its name (utils/db.ts fetchHeldYourGroups), as Talk asks the one in use: one read as Chat opens, at each change of the
 * notice counts and at the member's pull, never a poll. Enterprises there are not listed here.
 *
 * Which communities: those Chat reads (held-chats.ts heldCommunityList), less any a guest's mark names under any spelling
 * (it wouldn't open in place). One that doesn't answer keeps the rows it had; one the phone is now set to, no longer holds,
 * or another account's, has none at once, before any answer. One store per community (your-groups-store.ts), so a read, a
 * send or a mute in place shows on its own row and never on the same id in another.
 */
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { chatTimeMs, newestChatsFirst } from '@beanpool/core';
import { getDatabaseFilenameForNode, isGuestCopy } from './nodes';
import type { OtherCommunityNotice } from './use-notice-counts';
import { createYourGroupsStore, TALK_GROUPS, type YourGroupsStore } from './your-groups-store';
import type { YourChat } from './your-groups';

/** On every row made here, and on no other: a server's list is JSON, which can't write it (review of #3358, F3). */
export const HELD_GROUP: unique symbol = Symbol('held group');

/** A group's or an event's chat of another community this phone holds: its row, and where it opens. */
export interface HeldGroup extends YourChat {
    readonly [HELD_GROUP]: true;
    /** The row's key: never that of a group in the community in use, nor of the same id in another. */
    key: string;
    /** The community's address, as the saved list has it. */
    community: string;
    communityName: string;
    /** Its place in the list: its newest line, or a send from here not yet in it (your-groups-store.ts movedAt). */
    movedAt: number;
}

/** How long one community's list is waited for. */
export const HELD_GROUPS_ASK_MS = 10_000;

interface Place { file: string; url: string; name: string; store: YourGroupsStore; stop: () => void; left: Set<string> }

let owner: string | null = null;
let places: Place[] = [];
let rows: HeldGroup[] = [];
const listeners = new Set<() => void>();
/** Which communities there are, worked out one at a time: two asks at once would make each other's stores again. */
let listing: Promise<unknown> = Promise.resolve();

function emit(): void {
    const next = places.flatMap(({ file, url, name, store, left }) => (store.getState().items ?? [])
        .filter((item) => (item.kind === 'group' || item.kind === 'event') && !left.has(item.conversationId))
        .map((item): HeldGroup => ({ ...item, [HELD_GROUP]: true, key: `held-group:${file}:${item.conversationId}`, community: url, communityName: name, movedAt: store.movedAt(item) })));
    if (JSON.stringify(next) === JSON.stringify(rows)) return;
    rows = next;
    listeners.forEach((l) => l());
}

function placeOf(me: string, file: string, url: string, name: string): Place {
    /** Groups left in place (forget): no row of theirs until that community has answered without them. */
    const left = new Set<string>();
    const store = createYourGroupsStore(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), HELD_GROUPS_ASK_MS);
        try {
            const { fetchHeldYourGroups } = await import('./db');
            const items = await fetchHeldYourGroups(me, url, controller.signal);
            // Not answered: the rows it had stay (the store keeps its items on a failure).
            if (!items) throw new Error('not answered');
            for (const id of left) if (!items.some((i) => i.conversationId === id)) left.delete(id);
            return { items, totalUnread: 0 };
        } finally {
            clearTimeout(timer);
        }
    }, undefined, TALK_GROUPS);
    const off = store.subscribe(emit);
    return { file, url, name, store, stop: () => { off(); store.leaveDrawn(); }, left };
}

function drop(gone: Place[]): void {
    for (const place of gone) place.stop();
    places = places.filter((p) => !gone.includes(p));
}

/** What a group's chat in place tells its own row: never the row of the same id in the community in use, or in another. */
export interface HeldGroupRow {
    markRead(conversationId: string): void;
    noteSent(conversationId: string): void;
    setMute: YourGroupsStore['setMute'];
}

export const heldGroups = {
    getState: (): HeldGroup[] => rows,
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    },
    /** `community`'s rows, as last answered. */
    rowsOf(community: string): HeldGroup[] {
        const file = getDatabaseFilenameForNode(community);
        return rows.filter((r) => getDatabaseFilenameForNode(r.community) === file);
    },
    /** `community`'s own list, for a chat of it in place: the list there is at each call (a chat keeps this while it is open). */
    at(community: string): HeldGroupRow {
        const file = getDatabaseFilenameForNode(community);
        const list = () => places.find((p) => p.file === file)?.store;
        return {
            markRead: (id) => {
                const row = list()?.getState().items?.find((i) => i.conversationId === id);
                list()?.markRead(id);
                // An event's lines leave that community's number too, now: the "· Switch" line never counts what was read here.
                const lines = row?.kind === 'event' ? row.unreadCount : 0;
                if (lines > 0) void import('./notice-counts').then((m) => m.noteReadInPlace(AsyncStorage, community, lines)).catch(() => {});
            },
            noteSent: (id) => list()?.noteSent(id),
            setMute: (id, mute) => list()?.setMute(id, mute),
        };
    },
    /** The member left the group there: its row goes now, and stays gone until that community has answered without it. */
    forget(community: string, conversationId: string): void {
        const place = places.find((p) => p.file === getDatabaseFilenameForNode(community));
        if (!place) return;
        place.left.add(conversationId);
        emit();
        void place.store.refresh();
    },
    /** Ask each held community for `me`'s list there. Rows of one no longer held, or of another account, go before any answer. */
    async refresh(me: string): Promise<void> {
        const held = listing.then(() => heldNow(me));
        listing = held.catch(() => {});
        await Promise.all((await held).map((p) => p.store.refresh()));
    },
};

/** The communities `me`'s rows come from now, each with its store: the ones already here keep theirs, and their rows. */
async function heldNow(me: string): Promise<Place[]> {
    if (owner !== me) {
        drop([...places]);
        owner = me;
        emit();
    }
    const held: Place[] = [];
    // Loaded as Chat asks: a chat's screen imports this for its own row alone.
    const { heldCommunityList } = await import('./held-chats');
    for (const { url, name } of await heldCommunityList()) {
        if (await isGuestCopy(url).catch(() => true)) continue;
        const file = getDatabaseFilenameForNode(url);
        const kept = places.find((p) => p.file === file);
        // A new name is drawn on the list there is: its rows and the member's sends in it stay.
        if (kept) kept.name = name;
        held.push(kept && kept.url === url ? kept : placeOf(me, file, url, name));
    }
    drop(places.filter((p) => !held.includes(p)));
    places = held;
    emit();
    return held;
}

const NONE: HeldGroup[] = [];
/** The held communities' group rows, as they stand: `myPubkey`'s only, so another account never sees the last one's, not even for a frame. */
export function useHeldGroups(myPubkey?: string | null): HeldGroup[] {
    const all = useSyncExternalStore(heldGroups.subscribe, heldGroups.getState);
    return myPubkey && owner === myPubkey ? all : NONE;
}

/**
 * Talk → Groups' one list, one rule over every row, the community in use's and the held ones alike: newest first, the
 * member's own line included (each row's place as its store has it: `movedAt` of its own, `ownMovedAt` for one in use).
 */
export function groupsListed(own: readonly YourChat[], held: readonly HeldGroup[], ownMovedAt: (item: YourChat) => number = (item) => chatTimeMs(item.lastActivityAt)): Array<YourChat | HeldGroup> {
    return newestChatsFirst<YourChat | HeldGroup>([...own, ...held], (item) => (isHeldGroup(item) ? item.movedAt : ownMovedAt(item)));
}

export function isHeldGroup(item: YourChat | HeldGroup): item is HeldGroup {
    return (item as HeldGroup)[HELD_GROUP] === true;
}

/** The chat screen's params for a held row opened in place: its id, its community by address, and the names shown on the way in. */
export function heldGroupParams(item: HeldGroup): Record<string, string> {
    return { id: item.conversationId, community: item.community, communityName: item.communityName, [item.kind === 'event' ? 'event' : 'group']: '1', name: item.name };
}

/**
 * Chat's "{n} new messages in {community} · Switch" lines once events have rows of their own here (DESIGN §3: "the '· Switch'
 * row goes once a community's chats are in the list"): a community's number less the unread lines its events' rows show, and
 * no line when nothing else waits. Never below the lines a push told of there (`alerts`): an event's chat tells nobody, so
 * those are never an event's, whatever came between that community's last count and its last list.
 */
export function noticesBesideEvents(notices: readonly OtherCommunityNotice[], held: readonly HeldGroup[]): OtherCommunityNotice[] {
    return notices.flatMap((n) => {
        const file = getDatabaseFilenameForNode(n.url);
        const onRows = held.reduce((sum, r) => sum + (r.kind === 'event' && getDatabaseFilenameForNode(r.community) === file ? Math.max(0, r.unreadCount || 0) : 0), 0);
        const count = Math.max(n.count - onRows, Math.min(n.alerts ?? n.count, n.count));
        return count > 0 ? [count === n.count ? n : { ...n, count }] : [];
    });
}
