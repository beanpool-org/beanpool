/**
 * group-chat-lines — sending, editing and reading a group chat's sealed lines on the phone (group chats slice 3).
 *
 * Send: the epoch comes from the keyring's pre-seal rules (utils/group-chat-keys.ts prepareToSeal), the words are sealed
 * and signed as me under the message's own key, and the line goes to POST /api/groups/:id/chat/message with
 * `metadata: { epoch, replyToId?, mentions? }`: the mentions found on this phone in the words it is about to seal (core
 * detectMentions, design §9), since the node can no longer read them. A 409 saying the epoch moved or went stale is
 * answered once: the keyring syncs, rotates if it must, and the line is sealed again.
 *
 * Edit: sealed under the LINE's own epoch, never the current one (epochs-over-time design §3, Marty's pick 1): an edit
 * has its line's audience. Without that epoch's key on this phone the edit is refused here.
 *
 * Read: every sealed line the node served is opened under its epoch's key, opened lazily (only the epochs of lines being
 * shown; provenance §10 pick 2), and named by the line-display rule (utils/group-line-display.ts). Lines from before this
 * member's membership are hidden unopened.
 *
 * Old node (§14.3): a chat answer with no `encryption` is a node from before locked chats. The phone then sends and reads
 * as it always did, and never shows the chat as locked: no false success. But once this phone has held a key of the group
 * (GroupKeyring.seenLocked), the chat stays locked here whatever the node says later: nothing readable is ever sent to
 * it again, and the screen says why in the phone's own words, never the node's (review of #1788, finding 4; director's
 * decision b).
 */
import type { BeanPoolIdentity } from './identity';
import { signedPost } from './node-post';
import { detectMentions, sealLine, openLine, type GroupEpochProgress } from './group-chat-crypto';
import { groupKeyring, GroupKeysRequestError, type GroupKeyring, type GroupKeyStore } from './group-chat-keys';
import {
    groupLineView, isSealedGroupLine, GROUP_LINE_UNVERIFIED_NAME, GROUP_LINE_UNVERIFIED_TEXT,
    type DisplayRosterRow, type GroupLineView, type ServedGroupLine,
} from './group-line-display';
import { isTombstone, normaliseThreadMessage, type ChatKind, type ChatMessage } from './chat-actions';
import { decodeEventChatText } from './events';

/** The chat's lock as GET /api/groups/:id/chat says it (§14.3). Absent on a node from before locked chats. */
export interface GroupChatEncryption {
    current: number | null;
    stale: boolean;
    fromEpoch: number | null;
}

/** True if this node locks group chats: its chat answer carries `encryption`. */
export function chatIsLocked(answer: any): answer is { encryption: GroupChatEncryption } {
    return !!answer && typeof answer === 'object' && !!answer.encryption && typeof answer.encryption === 'object';
}

/** The notice an old node's chat keeps (the phone never calls such a chat locked). */
export const GROUP_CHAT_OLD_NODE_NOTICE = "This community's node is older and can read this group's chat. It will be locked once the node is updated.";
/** A locked chat's notice (design §8), in the phone's own words. */
export const GROUP_CHAT_LOCKED_NOTICE = "End-to-end encrypted: only this group's members can read it. The node sees who wrote, when, and who was mentioned.";
/**
 * A chat this phone has held a key of, which the node now says isn't locked: what the phone does, not what it waits for
 * (confirmation of #1788, finding 4). Every line still goes sealed when the keys come; nothing goes readable.
 */
export const GROUP_CHAT_LOCK_LOST_TEXT = "This node now says this chat isn't locked. This phone has held its keys, so it still locks every message, and sends nothing it can't lock.";
/** A node that refuses this phone the group's keys and its chat (a removed member): it said nothing about locking. */
export const GROUP_CHAT_NOT_MEMBER_TEXT = 'Only members of this group can open its chat';
/**
 * A conversation this phone knows as a direct message, asked to act as a group's chat (to post, edit, join or rotate its
 * keys): refused, so a known DM never gets a group's keys here and never becomes a held group (confirmation 2 of #1788,
 * finding 2).
 */
export const GROUP_KEYS_FOR_DM_TEXT = "This phone knows this conversation as a direct message, not a group's chat. Nothing was sent.";

/** The group chat's notice: the phone's own words for what it decided, never the node's text. */
export function groupChatNotice(state: { nodeSaysLocked: boolean; seenLocked: boolean }): string {
    if (state.nodeSaysLocked) return GROUP_CHAT_LOCKED_NOTICE;
    return state.seenLocked ? GROUP_CHAT_LOCK_LOST_TEXT : GROUP_CHAT_OLD_NODE_NOTICE;
}

const UPDATE_REFUSALS = new Set(['epoch_stale', 'epoch_not_current', 'epoch_needed']);

export interface SendGroupLineInput {
    groupId: string;
    text: string;
    /** The client's own UUID v4: the id the line is sealed under and stored as. */
    clientId: string;
    replyToId?: string | null;
    /** The newest line this phone had from the node when this one was written (sealed in it). */
    after?: string | null;
    /** Roster members with their callsigns, for the @mentions this phone declares. */
    mentionCandidates?: { pubkey: string; callsign: string | null | undefined }[];
    progress?: GroupEpochProgress;
}

/** Seal and send one line. Resolves with the node's answer; throws the node's refusal or GroupChatKeyError's sentence. */
export async function sendSealedGroupLine(nodeUrl: string, identity: BeanPoolIdentity, store: GroupKeyStore, input: SendGroupLineInput): Promise<any> {
    const ring = groupKeyring(nodeUrl, identity, input.groupId, store);
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
        const res = await signedPost(nodeUrl, `/api/groups/${encodeURIComponent(input.groupId)}/chat/message`,
            { ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata, clientId: messageId }, identity);
        const body = await res.json().catch(() => ({}));
        if (res.ok) return body;
        if (attempt === 0 && res.status === 409 && UPDATE_REFUSALS.has(body?.code)) continue;
        throw new GroupKeysRequestError(body?.error || `The node answered ${res.status}.`, res.status, body);
    }
}

/** Refused before anything is sent: this phone doesn't hold the key the line was sealed under. */
export const GROUP_EDIT_NO_KEY_TEXT = "This message's key isn't on this phone, so it can't be edited here.";

/** Edit one of my lines: re-sealed under ITS epoch (part 'edit', after its own id, still answering what it answered). */
export async function editSealedGroupLine(
    nodeUrl: string, identity: BeanPoolIdentity, store: GroupKeyStore,
    input: { groupId: string; messageId: string; metadata: any; text: string },
): Promise<any> {
    const ring = groupKeyring(nodeUrl, identity, input.groupId, store);
    const epoch = input.metadata?.epoch;
    if (typeof epoch !== 'number') throw new Error(GROUP_EDIT_NO_KEY_TEXT);
    let key = await ring.keyFor(epoch);
    if (!key) { await ring.sync().catch(() => null); key = await ring.keyFor(epoch); }
    if (!key) throw new Error(GROUP_EDIT_NO_KEY_TEXT);
    const replyToId = typeof input.metadata?.replyToId === 'string' ? input.metadata.replyToId : null;
    const sealed = sealLine(input.text, {
        myEdPrivHex: identity.privateKey, groupKey: key, groupId: input.groupId, epoch, messageId: input.messageId,
        part: 'edit', after: input.messageId, replyToId,
    });
    const res = await signedPost(nodeUrl, '/api/messages/edit',
        { messageId: input.messageId, authorPubkey: identity.publicKey, ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata: { epoch } }, identity);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new GroupKeysRequestError(body?.error || 'Failed to edit message.', res.status, body);
    return body;
}

export interface OpenedGroupThread {
    /** Each sealed line's view, by message id (system lines and tombstones are not in it). */
    views: Map<string, GroupLineView>;
    /** "Waiting for the group's next key": this member's keys begin with an epoch nobody has made yet. */
    waitingForNextKey: boolean;
}

/**
 * Open what the node served: sync the keys when a line names an epoch this phone doesn't have yet (or the node's current
 * is past the highest held), open the epochs of the lines shown, and view each line by the display rule.
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
        const e = (typeof l.metadata === 'string' ? (() => { try { return JSON.parse(l.metadata); } catch { return {}; } })() : l.metadata)?.epoch;
        if (typeof e === 'number' && from !== null && e >= from) epochs.add(e);
    }
    const missing = [...epochs].some((e) => !ring.holdsWrap(e)) || (enc.current !== null && enc.current > await ring.highestEpoch());
    if (missing || !ring.state) await ring.sync().catch(() => null);
    for (const e of [...epochs].sort((a, b) => b - a)) await ring.keyFor(e).catch(() => null);
    const views = new Map<string, GroupLineView>();
    const memo = ring.memo;
    for (const l of lines) {
        const v = groupLineView(l, {
            groupId: ring.groupId, fromEpoch: from, keyFor: (e) => ring.openedKey(e), open: openLine, memo, roster, nodeNameOf,
            signerSeen: (id) => ring.signerSeen(id), successions: ring.successions,
        });
        if (v.signer && !l.editedAt) ring.rememberSigner(l.id, v.signer);
        views.set(l.id, v);
    }
    // A chat with no epoch yet is not waiting: the first member to write makes epoch 1.
    const waitingForNextKey = from !== null && enc.current !== null && from > enc.current;
    return { views, waitingForNextKey };
}

/** Beside "Unverified" for a line a locked chat holds unsealed (review of #1788, finding 3). */
export const GROUP_LINE_UNSEALED_DETAILS = "It isn't sealed, so nothing shows who wrote it.";

/**
 * The node's lines as the chat draws them (GroupChatView). In a locked chat: a sealed line by the display rule (its words
 * and the name of the key that signed it; hidden from before this member's membership), a node system line and a
 * tombstone as they are, and anything else as nobody's: "Unverified", never the author column's name and never mine.
 * An honest locked chat holds no other line (the day-zero wipe tombstoned the old ones and the node refuses readable
 * lines), so such a line is the node's own words. In an unlocked chat (an old node, never locked on this phone) every
 * line is drawn as it always was.
 */
export function groupChatShownLines(
    raw: readonly any[], opts: { locked: boolean; thread: OpenedGroupThread | null; me: string | undefined; kind: ChatKind },
): ChatMessage[] {
    const { locked, thread, me, kind } = opts;
    return raw.flatMap((m): ChatMessage[] => {
        if (!locked) return [normaliseThreadMessage(m, decodeEventChatText, me, kind)];
        if (!isSealedGroupLine(m)) {
            const plain = normaliseThreadMessage(m, decodeEventChatText, me, kind);
            if (plain.type === 'system' || plain.senderId === 'SYSTEM' || isTombstone(plain)) return [plain];
            return [{
                ...normaliseThreadMessage(m, () => GROUP_LINE_UNVERIFIED_TEXT, me, kind),
                text: GROUP_LINE_UNVERIFIED_TEXT, senderId: '', outgoing: false, authorName: GROUP_LINE_UNVERIFIED_NAME,
                integrityNote: GROUP_LINE_UNSEALED_DETAILS, unattributed: true,
            }];
        }
        const v = thread?.views.get(String(m.id));
        // Not opened yet: nobody's, no words, for the moment it takes.
        if (!v) return [{ ...normaliseThreadMessage(m, () => '…', me, kind), senderId: '', outgoing: false, authorName: null, unattributed: true }];
        // From before this member's membership: never shown (design §3).
        if (v.hidden) return [];
        const base = normaliseThreadMessage(m, () => v.text, me, kind);
        // The key that opened the line is its author: never the node's author column (line-display design §4).
        const senderId = v.signer ?? '';
        return [{
            ...base,
            senderId,
            outgoing: !!me && senderId === me,
            authorName: v.name ? (v.nameHint ? `${v.name} · ${v.nameHint}` : v.name) : null,
            integrityNote: v.details,
            unattributed: v.unverified || v.waitingKey,
        }];
    });
}
