/**
 * group-chat-lines — sending, editing and reading a group chat's sealed lines on the phone (group chats slice 3).
 *
 * Send: the epoch comes from the keyring's pre-seal rules (utils/group-chat-keys.ts prepareToSeal), the words are sealed
 * and signed as me under the message's own key, and the line goes to POST /api/groups/:id/chat/message with
 * `metadata: { epoch, replyToId?, mentions? }`: the mentions found on this phone in the words it is about to seal (core
 * detectMentions, design §9), since the node can no longer read them. A 409 saying the epoch moved or went stale is
 * answered once: the keyring syncs, rotates if it must, and the line is sealed again.
 *
 * Photo (DESIGN-group-chat-photos-fable.md §2.2, §2.3): a photo line is its caption, sealed as part 'body', and the JPEG data
 * URI, sealed as part 'attachment', under the line's one message key; the 409 re-seal seals both again. The node keeps the
 * photo where a DM's is, and it is opened only once its words have, under the key that opened them.
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
import { signedGet, signedPost } from './node-post';
import { detectMentions, groupMessageKey, sealLine, openLine, type GroupEpochProgress } from './group-chat-crypto';
import { toBase64 } from '@beanpool/core';
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
export const GROUP_CHAT_LOCKED_NOTICE = "End-to-end encrypted: only this group's members can read it. The node sees who wrote, when, mentions, what each line answers, and reactions.";
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
    /** The line's words; a photo line's caption, which may be empty. */
    text: string;
    /**
     * A photo line's photo: the JPEG as a data URI (DESIGN-group-chat-photos-fable.md §2.2). Sealed as part 'attachment' under
     * the same message key, epoch and reply as the words, on every attempt, and sent beside them as type 'image'.
     */
    photo?: string;
    /** The client's own UUID v4: the id the line is sealed under and stored as. */
    clientId: string;
    replyToId?: string | null;
    /** The newest line this phone had from the node when this one was written (sealed in it). */
    after?: string | null;
    /** Roster members with their callsigns, for the @mentions this phone declares. */
    mentionCandidates?: { pubkey: string; callsign: string | null | undefined }[];
    progress?: GroupEpochProgress;
}

/**
 * Seal and send one line. Resolves with the node's answer; throws the node's refusal or GroupChatKeyError's sentence. Signed
 * and routed under the keyring's id (the group's, lower-case), however the caller spelled it: members open a line under
 * that id (#1841 review, finding 3).
 */
export async function sendSealedGroupLine(nodeUrl: string, identity: BeanPoolIdentity, store: GroupKeyStore, input: SendGroupLineInput): Promise<any> {
    const ring = groupKeyring(nodeUrl, identity, input.groupId, store);
    const messageId = input.clientId.toLowerCase();
    const mentions = detectMentions(input.text, (input.mentionCandidates ?? []).filter((c) => c.pubkey !== identity.publicKey));
    for (let attempt = 0; ; attempt++) {
        const { epoch, key } = await ring.prepareToSeal(input.progress);
        const binding = { myEdPrivHex: identity.privateKey, groupKey: key, groupId: ring.groupId, epoch, messageId, replyToId: input.replyToId ?? null };
        const sealed = sealLine(input.text, { ...binding, after: input.after ?? null });
        // A photo goes with its words or not at all: sealed again with them on a re-seal, so both parts carry one epoch.
        const photo = input.photo === undefined ? null : sealLine(input.photo, { ...binding, part: 'attachment', after: null });
        const metadata: Record<string, unknown> = { epoch };
        if (input.replyToId) metadata.replyToId = input.replyToId;
        if (mentions.length) metadata.mentions = mentions;
        const line: Record<string, unknown> = { ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata, clientId: messageId };
        if (photo) Object.assign(line, { type: 'image', attachment: { data: photo.ciphertext, nonce: photo.nonce, mime: 'image/jpeg' } });
        const res = await signedPost(nodeUrl, `/api/groups/${encodeURIComponent(ring.groupId)}/chat/message`, line, identity);
        const body = await res.json().catch(() => ({}));
        if (res.ok) return body;
        if (attempt === 0 && res.status === 409 && UPDATE_REFUSALS.has(body?.code)) continue;
        throw new GroupKeysRequestError(body?.error || `The node answered ${res.status}.`, res.status, body);
    }
}

/** Refused before anything is sent: this phone doesn't hold the key the line was sealed under. */
export const GROUP_EDIT_NO_KEY_TEXT = "This message's key isn't on this phone, so it can't be edited here.";
/** The node answers the chat, but its edit route says it no longer has this line (confirmation 2 of #1788, J2). */
export const GROUP_EDIT_LINE_GONE_TEXT = 'This message is no longer in this chat.';

/**
 * Edit one of my lines: re-sealed under ITS epoch (part 'edit', after its own id, still answering what it answered), and
 * signed under the keyring's id, as sendSealedGroupLine signs.
 */
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
        myEdPrivHex: identity.privateKey, groupKey: key, groupId: ring.groupId, epoch, messageId: input.messageId,
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

/**
 * Where this phone keeps a group's photos once opened, by message id (utils/db.ts groupPhotoCache: the OS cache folder, one
 * folder per group, so a group this phone is no longer in can be cleared at once). Nothing here touches the device.
 */
export interface GroupPhotoCache {
    /** What an <Image> draws for a photo this phone opened before, or null. */
    get(groupId: string, messageId: string): Promise<string | null>;
    /** Keep an opened photo (its JPEG data URI) and answer what an <Image> draws for it. */
    put(groupId: string, messageId: string, dataUri: string): Promise<string>;
}

const PHOTO_DATA_URI = /^data:image\/[a-z0-9.+-]+;base64,/i;

/**
 * A photo line's photo, opened (DESIGN-group-chat-photos-fable.md §2.3): what an <Image> draws, or null for "Image
 * unavailable". Only as part of its message, bound to what opened its words: a line hidden, waiting for its key or
 * unverified shows no photo and asks the node for nothing. Then the cache by message id (the words opened in THIS chat
 * first, so a kept copy never shows under a line the node moved), else GET /api/messages/:id/attachment, opened as part
 * 'attachment' under the line's epoch key, its group, its signer, its id and its reply: a photo the node swapped from
 * another line, another chat or another sender opens as nothing.
 */
export async function getDecryptedGroupAttachment(
    nodeUrl: string, identity: BeanPoolIdentity, store: GroupKeyStore,
    input: { groupId: string; line: ServedGroupLine; view: GroupLineView }, cache: GroupPhotoCache,
): Promise<string | null> {
    const { line, view } = input;
    if (line.type !== 'image' || view.hidden || view.waitingKey || view.unverified || !view.signer || view.epoch === null) return null;
    const ring = groupKeyring(nodeUrl, identity, input.groupId, store);
    const messageId = String(line.id);
    try {
        const kept = await cache.get(ring.groupId, messageId);
        if (kept) return kept;
        const key = ring.openedKey(view.epoch) ?? await ring.keyFor(view.epoch);
        if (!key) return null;
        const res = await signedGet(nodeUrl, `/api/messages/${encodeURIComponent(messageId)}/attachment`, identity);
        if (!res.ok) return null;
        const { data, nonce } = await res.json();
        const meta = typeof line.metadata === 'string' ? JSON.parse(line.metadata) : line.metadata;
        const replyToId = typeof meta?.replyToId === 'string' && meta.replyToId ? meta.replyToId : null;
        const photo = openLine({ ciphertext: data, nonce }, {
            groupId: ring.groupId, epoch: view.epoch, senderPubHex: view.signer, messageId, part: 'attachment', replyToId,
        }, key, ring.memo).text;
        if (!PHOTO_DATA_URI.test(photo)) return null;
        return await cache.put(ring.groupId, messageId, photo);
    } catch {
        return null;
    }
}

/** Refused before anything is sent: the line being reported didn't open here, so this phone has no key of its own to hand over. */
export const GROUP_REPORT_NO_KEY_TEXT = "This message's key isn't on this phone, so it can't be reported from here.";

/**
 * Report one line of a locked chat to the community's moderators, with its key (DESIGN-group-chat-photos-fable.md §5 S6;
 * the encryption design §13): that message's own key (groupMessageKey, through the crypto door) under the epoch that opened
 * it here, which opens its words and its photo and nothing else in the chat. Only a line this phone opened and named
 * (`view.signer`): a hidden, waiting or unverified line has no key here to give. Signed and routed under the keyring's id,
 * as a send is. Resolves with the node's answer (`duplicate` for a report already on file); throws its refusal.
 */
export async function reportSealedGroupLine(
    nodeUrl: string, identity: BeanPoolIdentity, store: GroupKeyStore,
    input: { groupId: string; messageId: string; view: GroupLineView | null | undefined; reason: string },
): Promise<any> {
    const view = input.view;
    if (!view || view.hidden || view.waitingKey || view.unverified || !view.signer || view.epoch === null) throw new Error(GROUP_REPORT_NO_KEY_TEXT);
    const ring = groupKeyring(nodeUrl, identity, input.groupId, store);
    const key = ring.openedKey(view.epoch) ?? await ring.keyFor(view.epoch).catch(() => undefined);
    if (!key) throw new Error(GROUP_REPORT_NO_KEY_TEXT);
    const messageId = input.messageId.toLowerCase();
    const res = await signedPost(nodeUrl, `/api/groups/${encodeURIComponent(ring.groupId)}/chat/report`,
        { messageId, reason: input.reason, disclosure: { epoch: view.epoch, mk: toBase64(groupMessageKey(key, messageId)) } }, identity);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new GroupKeysRequestError(body?.message || body?.error || `The node answered ${res.status}.`, res.status, body);
    return body;
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
