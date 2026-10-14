/**
 * group-chat-lines — sending, editing and reading a group chat's sealed lines in the web app (group chats slice 4). The
 * phone's twin is apps/native/utils/group-chat-lines.ts (#1788): same routes, same metadata, same words.
 *
 * Send: the epoch comes from the keyring's pre-seal rules (group-chat-keys.ts prepareToSeal), the words are sealed and
 * signed as me under the message's own key, and the line goes to POST /api/groups/:id/chat/message with
 * `metadata: { epoch, replyToId?, mentions? }`: the mentions found here in the words about to be sealed (core
 * detectMentions, design §9), since the node can no longer read them. A 409 saying the epoch moved or went stale is
 * answered once: the keyring syncs, rotates if it must, and the line is sealed again.
 *
 * Edit: sealed under the LINE's own epoch, never the current one (epochs-over-time design §3, Marty's pick 1). Without
 * that epoch's key in this browser the edit is refused here.
 *
 * Read: every sealed line the node served is opened under its epoch's key (only the epochs of the lines loaded;
 * provenance §5.3, §10), and named by the line-display rule (group-line-display.ts). In a locked chat a line that isn't
 * sealed is nobody's ("Unverified"), never the author column's name and never mine (review of #1788, finding 3).
 *
 * Whether to seal at all (groupChatSendPlan): a chat answer that carries `encryption` is locked, and this browser
 * remembers it for good (the sticky lock, director's decision b). A chat answer with no `encryption` is a node from
 * before locked chats (§14.3): readable words go to it only from a browser that has never seen the group locked, read
 * from its store; a store that can't be read refuses, and a chat answer that can't be read refuses too (a never-held
 * browser sends readable words only when the chat answer says unlocked).
 */
import { isCollapsedRun, removedLineRuns, type RemovedLineKind } from '@beanpool/core';
import { detectMentions, sealLine, openLine, type GroupEpochProgress } from './group-chat-crypto';
import {
    groupKeyring, GroupKeysRequestError, GroupChatKeyError, GROUP_CHAT_NOT_MEMBER_TEXT,
    type GroupKeyring, type GroupKeysTransport, type GroupLockStore,
} from './group-chat-keys';
import {
    groupLineView, isSealedGroupLine, GROUP_LINE_UNVERIFIED_NAME, GROUP_LINE_UNVERIFIED_TEXT,
    type DisplayRosterRow, type GroupLineView, type ServedGroupLine,
} from './group-line-display';

export { GROUP_CHAT_NOT_MEMBER_TEXT };

/** The chat's lock as GET /api/groups/:id/chat says it (§14.3). Absent on a node from before locked chats. */
export interface GroupChatEncryption {
    current: number | null;
    stale: boolean;
    fromEpoch: number | null;
}

/** True if this node locks group chats: its chat answer carries `encryption`. */
export function chatIsLocked(answer: unknown): answer is { encryption: GroupChatEncryption } {
    const a = answer as { encryption?: unknown } | null;
    return !!a && typeof a === 'object' && !!a.encryption && typeof a.encryption === 'object';
}

/** The notice an old node's chat keeps (the web never calls such a chat locked). */
export const GROUP_CHAT_OLD_NODE_NOTICE = "This community's node is older and can read this group's chat. It will be locked once the node is updated.";
/** A locked chat's notice (design §8), in the app's own words. */
export const GROUP_CHAT_LOCKED_NOTICE = "End-to-end encrypted: only this group's members can read it. The node sees who wrote, when, and who was mentioned.";
/**
 * A chat this browser has seen locked, which the node now says isn't: what the browser does, not what it waits for
 * (confirmation of #1788, finding 4). Every line still goes sealed when the keys come; nothing goes readable.
 */
export const GROUP_CHAT_LOCK_LOST_TEXT = "This node now says this chat isn't locked. This browser has held its keys, so it still locks every message, and sends nothing it can't lock.";
/** A chat answer that didn't come: nothing readable goes on a guess. */
export const GROUP_CHAT_UNREAD_TEXT = "This browser couldn't check whether this chat is locked just now. Nothing was sent; try again in a moment.";
/** Photos in a group chat come with slice 5; the node refuses them until then. */
export const GROUP_CHAT_NO_PHOTOS_TEXT = 'Photos can only be sent in direct messages';
/** Beside "Unverified" for a line a locked chat holds unsealed (review of #1788, finding 3). */
export const GROUP_LINE_UNSEALED_DETAILS = "It isn't sealed, so nothing shows who wrote it.";

/** The sentence for a chat answer that didn't come: a 403 or 404 is "only members"; anything else, "couldn't check". */
function unansweredText(chatError: unknown): string {
    const status = (chatError as { status?: number })?.status;
    return status === 403 || status === 404 ? GROUP_CHAT_NOT_MEMBER_TEXT : GROUP_CHAT_UNREAD_TEXT;
}

/**
 * The group chat's notice: the app's own words for what it decided, never the node's text. A chat answer that didn't
 * come (`chatError`) says so, never that the node is older or says unlocked (review of #1816, finding 7).
 */
export function groupChatNotice(state: { nodeSaysLocked: boolean; seenLocked: boolean; chatError?: unknown }): string {
    if (state.nodeSaysLocked) return GROUP_CHAT_LOCKED_NOTICE;
    if (state.chatError !== undefined && state.chatError !== null) return unansweredText(state.chatError);
    return state.seenLocked ? GROUP_CHAT_LOCK_LOST_TEXT : GROUP_CHAT_OLD_NODE_NOTICE;
}

/** What a send into a group conversation does: seal it, send it readable (an old node, never locked here), or refuse. */
export type GroupSendPlan = { kind: 'seal' } | { kind: 'readable' } | { kind: 'refuse'; sentence: string };

/**
 * The plan for a send or an edit in a group conversation, from the chat answer just read (`chat`; `chatError` when it
 * didn't come) and this browser's lock store. Never 'readable' unless the chat answer says unlocked AND this browser
 * has never seen the group locked, by a store that read.
 */
export async function groupChatSendPlan(ring: GroupKeyring, chat: unknown, chatError?: unknown): Promise<GroupSendPlan> {
    if (chatError !== undefined && chatError !== null) return { kind: 'refuse', sentence: unansweredText(chatError) };
    if (chatIsLocked(chat)) {
        await ring.noteLocked();
        return { kind: 'seal' };
    }
    if (!chat || typeof chat !== 'object') return { kind: 'refuse', sentence: GROUP_CHAT_UNREAD_TEXT };
    // The node says unlocked. Held here (or the store can't say): sealed when the keys still come, else refused.
    if (await ring.seenLocked()) return { kind: 'seal' };
    return { kind: 'readable' };
}

/**
 * The sentence for a held group the node refuses keys to: "Only members…" unless the chat answer just read is an
 * unlocked 200 (then the lock-lost sentence). The node can always deny a member the chat; nothing readable goes either way.
 */
export function heldGroupRefusal(chat: unknown, chatError?: unknown): string {
    if (!chatError && chat && typeof chat === 'object' && !chatIsLocked(chat)) return GROUP_CHAT_LOCK_LOST_TEXT;
    return GROUP_CHAT_NOT_MEMBER_TEXT;
}

const UPDATE_REFUSALS = new Set(['epoch_stale', 'epoch_not_current', 'epoch_needed']);

export interface SendGroupLineInput {
    groupId: string;
    text: string;
    /** The client's own UUID v4: the id the line is sealed under and stored as. */
    clientId: string;
    replyToId?: string | null;
    /** The newest line this browser had from the node when this one was written (sealed in it). */
    after?: string | null;
    /** Roster members with their callsigns, for the @mentions this browser declares. */
    mentionCandidates?: { pubkey: string; callsign: string | null | undefined }[];
    progress?: GroupEpochProgress;
}

interface Me { publicKey: string; privateKey: string }

/** Seal and send one line. Resolves with the node's answer; throws the node's refusal or GroupChatKeyError's sentence. */
export async function sendSealedGroupLine(net: GroupKeysTransport, identity: Me, store: GroupLockStore, input: SendGroupLineInput): Promise<any> {
    const ring = groupKeyring(net, identity, input.groupId, store);
    const messageId = input.clientId.toLowerCase();
    const mentions = detectMentions(input.text, (input.mentionCandidates ?? []).filter((c) => c.pubkey !== identity.publicKey));
    for (let attempt = 0; ; attempt++) {
        const { epoch, key } = await ring.prepareToSeal(input.progress);
        const sealed = sealLine(input.text, {
            myEdPrivHex: identity.privateKey, groupKey: key, groupId: input.groupId, epoch, messageId,
            after: input.after ?? null, replyToId: input.replyToId ?? null,
        });
        const metadata: Record<string, unknown> = { epoch };
        if (input.replyToId) metadata.replyToId = input.replyToId;
        if (mentions.length) metadata.mentions = mentions;
        const res = await net.post(`/api/groups/${encodeURIComponent(input.groupId)}/chat/message`,
            { ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata, clientId: messageId });
        const body = await res.json().catch(() => ({}));
        if (res.ok) return body;
        if (attempt === 0 && res.status === 409 && UPDATE_REFUSALS.has(body?.code)) continue;
        throw new GroupKeysRequestError(body?.error || `The node answered ${res.status}.`, res.status, body);
    }
}

/** Refused before anything is sent: this browser doesn't hold the key the line was sealed under. */
export const GROUP_EDIT_NO_KEY_TEXT = "This message's key isn't in this browser, so it can't be edited here.";

/** Edit one of my lines: re-sealed under ITS epoch (part 'edit', after its own id, still answering what it answered). */
export async function editSealedGroupLine(
    net: GroupKeysTransport, identity: Me, store: GroupLockStore,
    input: { groupId: string; messageId: string; metadata: unknown; text: string },
): Promise<any> {
    const ring = groupKeyring(net, identity, input.groupId, store);
    const meta = metadataOf(input.metadata);
    const epoch = meta.epoch;
    if (typeof epoch !== 'number') throw new GroupChatKeyError(GROUP_EDIT_NO_KEY_TEXT, 'no_key');
    let key = await ring.keyFor(epoch);
    if (!key) { await ring.sync([epoch]).catch(() => null); key = await ring.keyFor(epoch); }
    if (!key) throw new GroupChatKeyError(GROUP_EDIT_NO_KEY_TEXT, 'no_key');
    const replyToId = typeof meta.replyToId === 'string' ? meta.replyToId : null;
    const sealed = sealLine(input.text, {
        myEdPrivHex: identity.privateKey, groupKey: key, groupId: input.groupId, epoch, messageId: input.messageId,
        part: 'edit', after: input.messageId, replyToId,
    });
    const res = await net.post('/api/messages/edit',
        { messageId: input.messageId, authorPubkey: identity.publicKey, ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata: { epoch } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new GroupKeysRequestError(body?.error || 'Failed to edit message.', res.status, body);
    return body;
}

/** A line's metadata as an object, whether the node served it as JSON text or an object. */
export function metadataOf(metadata: unknown): Record<string, any> {
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) return metadata as Record<string, any>;
    if (typeof metadata !== 'string' || !metadata) return {};
    try {
        const m = JSON.parse(metadata);
        return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
    } catch {
        return {};
    }
}

export interface OpenedGroupThread {
    /** Each sealed line's view, by message id (system lines and tombstones are not in it). */
    views: Map<string, GroupLineView>;
    /** "Waiting for the group's next key": this member's keys begin with an epoch nobody has made yet. */
    waitingForNextKey: boolean;
}

/**
 * Open what the node served: sync the keys for the epochs of the lines loaded (and the node's current), open those
 * epochs, and view each line by the display rule.
 */
export async function openGroupThread(
    ring: GroupKeyring, answer: { messages?: ServedGroupLine[]; encryption: GroupChatEncryption },
    roster: readonly DisplayRosterRow[], nodeNameOf?: (pk: string) => string | null | undefined,
): Promise<OpenedGroupThread> {
    const enc = answer.encryption;
    const lines = (answer.messages ?? []).filter(isSealedGroupLine);
    const from = enc.fromEpoch;
    const epochs = new Set<number>();
    for (const l of lines) {
        const e = metadataOf(l.metadata).epoch;
        if (typeof e === 'number' && from !== null && e >= from) epochs.add(e);
    }
    const wanted = [...epochs].filter((e) => !ring.holdsWrap(e));
    if (enc.current !== null && !ring.holdsWrap(enc.current)) wanted.push(enc.current);
    if (wanted.length || !ring.state) await ring.sync(wanted).catch(() => null);
    for (const e of [...epochs].sort((a, b) => b - a)) await ring.keyFor(e).catch(() => null);
    const views = new Map<string, GroupLineView>();
    const memo = ring.memo;
    for (const l of lines) {
        // No earlier signer is handed in: the web keeps no verdict between loads and shows an edit's signer (§4 rule 3).
        views.set(l.id, groupLineView(l, {
            groupId: ring.groupId, fromEpoch: from, keyFor: (e) => ring.openedKey(e), open: openLine, memo, roster, nodeNameOf,
            successions: ring.successions,
        }));
    }
    // A chat with no epoch yet is not waiting: the first member to write makes epoch 1.
    const waitingForNextKey = from !== null && enc.current !== null && from > enc.current;
    return { views, waitingForNextKey };
}

/** How the web draws one line of a group conversation. */
export interface GroupLineShown {
    /** Not drawn at all: from before this member's membership (design §3). */
    hidden: boolean;
    /** A node system line (`text` null: the caller draws the node's words) or a tombstone (`text`: the app's own words). */
    nodeLine: boolean;
    text: string | null;
    /** The name slot; null for a node line, for my own line, or while a line waits. */
    name: string | null;
    nameHint: string | null;
    details: string | null;
    /** The key that opened it, or ''. */
    signer: string;
    mine: boolean;
    /** Nobody's: drawn in the middle with no actions (Unverified, waiting for a key, opening). */
    unattributed: boolean;
}

/** The words a group chat's tombstone shows: the app's own, by who removed it, never the node's marker (phone chat-actions). */
export const GROUP_LINE_DELETED_TEXT = 'This message was deleted';
export const GROUP_LINE_REMOVED_TEXT = 'Removed by a convenor';

/** A tombstone: an author's delete or a convenor's removal (the node's message-tombstone.ts). */
function isTombstoneRow(m: { type?: string | null; metadata?: unknown }): boolean {
    return m.type === 'removed' || metadataOf(m.metadata).removed === true;
}

/** Its words: the author's own delete (or an account deleted) or a convenor's removal, told apart by `removedBy`. */
export function groupTombstoneText(m: { authorPubkey?: string | null; metadata?: unknown }): string {
    const meta = metadataOf(m.metadata);
    if (meta.accountDeleted === true) return GROUP_LINE_DELETED_TEXT;
    const by = meta.removedBy;
    if (by && m.authorPubkey && by === m.authorPubkey) return GROUP_LINE_DELETED_TEXT;
    return by ? GROUP_LINE_REMOVED_TEXT : GROUP_LINE_DELETED_TEXT;
}

/** Which removal a drawn line is (a tombstone in the app's words), or null for every other line. */
export function groupRemovedKind(g: GroupLineShown | null | undefined): RemovedLineKind | null {
    if (!g?.nodeLine || g.text === null) return null;
    if (g.text === GROUP_LINE_REMOVED_TEXT) return 'convenor';
    return g.text === GROUP_LINE_DELETED_TEXT ? 'author' : null;
}

/** A run of two or more removed lines of one kind, drawn as one line by its first line (core removed-line-runs). */
export interface GroupRemovedRun {
    kind: RemovedLineKind;
    ids: string[];
}

/**
 * The runs among the lines as drawn, in order (hidden lines are not drawn, so they neither join nor break a run). Each
 * run's first id maps to the run; every other id in it maps to null (drawn by the first). A line in no run is absent.
 */
export function groupRemovedRuns(
    lines: readonly { id: string }[], shown: ReadonlyMap<string, GroupLineShown> | null,
): Map<string, GroupRemovedRun | null> {
    const runs = new Map<string, GroupRemovedRun | null>();
    if (!shown) return runs;
    const drawn = lines.filter((m) => !shown.get(m.id)?.hidden);
    for (const run of removedLineRuns(drawn, (m) => groupRemovedKind(shown.get(m.id)))) {
        if (!isCollapsedRun(run)) continue;
        const ids = run.lines.map((m) => m.id);
        runs.set(ids[0], { kind: run.kind, ids });
        for (const id of ids.slice(1)) runs.set(id, null);
    }
    return runs;
}

/**
 * One row of a group conversation as the web draws it. In a locked chat: a sealed line by the display rule (its words and
 * the name of the key that signed it; hidden from before this member's membership), a node system line and a tombstone
 * as they are, and anything else as nobody's: "Unverified", never the author column's name and never mine. An honest
 * locked chat holds no other line, so such a line is the node's own words. In an unlocked chat (an old node, never
 * locked here) `null`: the caller draws it as it always did.
 */
export function groupLineShown(
    m: ServedGroupLine & { systemType?: unknown },
    opts: { locked: boolean; thread: OpenedGroupThread | null; me: string | undefined },
): GroupLineShown | null {
    const { locked, thread, me } = opts;
    if (!locked) return null;
    if (isTombstoneRow(m)) {
        return { hidden: false, nodeLine: true, text: groupTombstoneText(m), name: null, nameHint: null, details: null, signer: '', mine: false, unattributed: false };
    }
    if (!isSealedGroupLine(m)) {
        // A node system line: drawn as the node's (centred, no name); a text line carrying a systemType is not one.
        if (m.type === 'system' || m.authorPubkey === 'SYSTEM') {
            return { hidden: false, nodeLine: true, text: null, name: null, nameHint: null, details: null, signer: '', mine: false, unattributed: false };
        }
        return {
            hidden: false, nodeLine: false, text: GROUP_LINE_UNVERIFIED_TEXT, name: GROUP_LINE_UNVERIFIED_NAME, nameHint: null,
            details: GROUP_LINE_UNSEALED_DETAILS, signer: '', mine: false, unattributed: true,
        };
    }
    const v = thread?.views.get(String(m.id));
    // Not opened yet: nobody's, no words, for the moment it takes.
    if (!v) return { hidden: false, nodeLine: false, text: '…', name: null, nameHint: null, details: null, signer: '', mine: false, unattributed: true };
    if (v.hidden) return { hidden: true, nodeLine: false, text: null, name: null, nameHint: null, details: null, signer: '', mine: false, unattributed: false };
    // The key that opened the line is its author: never the node's author column (line-display design §4).
    const signer = v.signer ?? '';
    return {
        hidden: false, nodeLine: false, text: v.text, name: v.name, nameHint: v.nameHint, details: v.details, signer,
        mine: !!me && signer === me, unattributed: v.unverified || v.waitingKey,
    };
}
