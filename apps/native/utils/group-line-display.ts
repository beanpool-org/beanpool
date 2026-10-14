/**
 * group-line-display — what one sealed group-chat line shows on the phone: its words and whose name goes on it
 * (scratch/global-node/DESIGN-group-chat-line-display-fable.md §4 the rule, §6 the words; decided by Marty 11 Oct 2026).
 *
 * The key that opens a line is its author. A line opens only under the key that signed it (the sender's key is in its
 * associated data, their signature in its frame), so it is opened under `metadata.sender`, then under `author_pubkey`, and
 * the one that opens it is the signer S. The node's author column and callsign are never shown for a sealed line: they are
 * the node's word, kept for its own jobs. S is then named from what this phone can check: today's roster; a former key of
 * a roster member by a chain of succession statements each signed by its successor (core walkKeySuccession; a roster row
 * with no `formerKeys`, an old node's, has none); otherwise the node's name for S with "no longer in this group", or
 * "A former member". A line that opens under neither key has no words and no name: "Unverified".
 *
 * A line sealed under an epoch from before this member's membership is hidden unopened (§3 of the encryption design), and
 * one whose epoch key isn't on this phone yet says so. Pure: the caller hands in the opened keys and the opener.
 */
import type { FormerKey, GroupLineBinding, GroupLinePart, GroupLinePayload, GroupLineVerifyMemo, OpenedGroupLine } from './group-chat-crypto';
import { isGroupEncryptedNonce, servedChain, walkKeySuccession } from './group-chat-crypto';

/** Exact words (line-display design §6; core's own sentence for a line that doesn't verify). */
export const GROUP_LINE_UNVERIFIED_NAME = 'Unverified';
export const GROUP_LINE_UNVERIFIED_TEXT = "This message couldn't be verified.";
export const GROUP_LINE_UNVERIFIED_DETAILS = 'The signature inside this message matches nobody the node names as its sender.';
export const GROUP_LINE_FORMER_MEMBER = 'A former member';
export const GROUP_LINE_NOT_IN_GROUP = 'no longer in this group';
export const GROUP_LINE_WAITING_KEY_TEXT = 'Waiting for the key to this message.';

/** "Sent from an earlier key of Ana's, replaced 3 Oct 2026." */
export function earlierKeyDetails(name: string, at: string): string {
    return `Sent from an earlier key of ${name}'s, replaced ${shortDate(at)}.`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(iso: string): string {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return 'earlier';
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** A roster row as the phone holds it (GET /api/groups/:id/members), with the §5 node's `formerKeys` when served. */
export interface DisplayRosterRow {
    memberPubkey: string;
    callsign?: string | null;
    formerKeys?: FormerKey[] | null;
}

/** A group line as the node served it (GET …/chat), the fields this rule reads. */
export interface ServedGroupLine {
    id: string;
    authorPubkey: string;
    authorCallsign?: string | null;
    ciphertext: string;
    nonce: string;
    metadata?: any;
    editedAt?: string | null;
    type?: string;
}

export interface GroupLineView {
    /** Never shown: a line from before this member's membership (§3). */
    hidden: boolean;
    text: string;
    /** The name slot. */
    name: string | null;
    /** Beside the name, greyed: "no longer in this group". */
    nameHint: string | null;
    /** For the message details sheet. */
    details: string | null;
    unverified: boolean;
    /** The epoch key isn't on this phone yet: no words, no name. */
    waitingKey: boolean;
    /** The key that opened it (lower-case hex), or null. */
    signer: string | null;
    /** The line it was written after, as sealed in it. */
    after: string | null;
    epoch: number | null;
}

export interface GroupLineDisplayContext {
    groupId: string;
    /** This member's first epoch (GET …/chat encryption.fromEpoch); null hides every sealed line. */
    fromEpoch: number | null;
    /** The opened key for an epoch, or undefined (not on this phone, or not opened yet). */
    keyFor: (epoch: number) => Uint8Array | undefined;
    open: (payload: GroupLinePayload, ref: GroupLineBinding, key: Uint8Array, memo?: GroupLineVerifyMemo) => OpenedGroupLine;
    memo?: GroupLineVerifyMemo;
    roster: readonly DisplayRosterRow[];
    /** The node's name for a key that is no roster member's, or null if the node knows no member for it. */
    nodeNameOf?: (pubkey: string) => string | null | undefined;
    /** The first signer this phone saw for a message id (rule 3: an edit is compared with it). */
    signerSeen?: (messageId: string) => string | undefined;
    /**
     * Succession verdicts, by (member, their former keys, signer): a chain is verified once per load however many lines
     * its former key signed (§4 2b; the keyring keeps one per group). `walk` is core's walker unless a test counts it.
     */
    successions?: Map<string, boolean>;
    walk?: typeof walkKeySuccession;
}

function epochOf(meta: any): number | null {
    const e = meta?.epoch;
    return typeof e === 'number' && Number.isSafeInteger(e) && e >= 1 ? e : null;
}

const hiddenView: GroupLineView = {
    hidden: true, text: '', name: null, nameHint: null, details: null, unverified: false, waitingKey: false, signer: null, after: null, epoch: null,
};

function unverifiedView(epoch: number | null): GroupLineView {
    return {
        hidden: false, text: GROUP_LINE_UNVERIFIED_TEXT, name: GROUP_LINE_UNVERIFIED_NAME, nameHint: null, details: GROUP_LINE_UNVERIFIED_DETAILS,
        unverified: true, waitingKey: false, signer: null, after: null, epoch,
    };
}

/** Who a signer is, by the rule (§4 2a–2c). */
export function nameSigner(signer: string, line: Pick<ServedGroupLine, 'authorPubkey' | 'authorCallsign'>, ctx: Pick<GroupLineDisplayContext, 'roster' | 'nodeNameOf' | 'successions' | 'walk'>):
    { name: string; nameHint: string | null; details: string | null } {
    const row = ctx.roster.find((r) => r.memberPubkey === signer);
    if (row) return { name: row.callsign || signer.slice(0, 8), nameHint: null, details: null };
    // A claim is only the claimant's word: when two rows' chains both reach the signer, neither is named, whatever order
    // the node lists them in (review of #1826, NB3; §6's words for a key this phone can't place).
    const claims = ctx.roster.flatMap((r) => {
        const former = Array.isArray(r.formerKeys) ? r.formerKeys.find((f) => f?.pubkey === signer) : undefined;
        return former && walked(r, signer, ctx) ? [{ r, former }] : [];
    });
    if (claims.length > 1) return { name: GROUP_LINE_FORMER_MEMBER, nameHint: null, details: null };
    if (claims.length === 1) {
        const { r, former } = claims[0];
        const name = r.callsign || r.memberPubkey.slice(0, 8);
        return { name, nameHint: null, details: earlierKeyDetails(name, former.at) };
    }
    const nodeName = (line.authorPubkey === signer ? line.authorCallsign : null) || ctx.nodeNameOf?.(signer) || null;
    if (nodeName) return { name: nodeName, nameHint: GROUP_LINE_NOT_IN_GROUP, details: null };
    return { name: GROUP_LINE_FORMER_MEMBER, nameHint: null, details: null };
}

/**
 * walkKeySuccession over the row's walkable chain (servedChain), once per (row, that chain, signer) for as long as
 * `ctx.successions` lives: keyed by the chain's walkable entries only and at most 4096 kept, so a node serving junk
 * can't grow it (review of #1826, NB5).
 */
function walked(row: DisplayRosterRow, signer: string, ctx: Pick<GroupLineDisplayContext, 'successions' | 'walk'>): boolean {
    const walk = ctx.walk ?? walkKeySuccession;
    const { chain, id: chainId } = servedChain(row.formerKeys);
    if (typeof row.memberPubkey !== 'string' || row.memberPubkey.length !== 64 || signer.length !== 64 || chain.length === 0) return false;
    if (!ctx.successions) return walk({ memberPubkey: row.memberPubkey, formerKeys: chain }, signer);
    const id = `${row.memberPubkey}|${signer}|${chainId}`;
    let v = ctx.successions.get(id);
    if (v === undefined) {
        if (ctx.successions.size >= 4096) ctx.successions.clear();
        v = walk({ memberPubkey: row.memberPubkey, formerKeys: chain }, signer);
        ctx.successions.set(id, v);
    }
    return v;
}

/** True if `a` and `b` are one member's keys by this phone's roster (the same key, or one a former key of the other). */
function sameMember(a: string, b: string, ctx: Pick<GroupLineDisplayContext, 'roster' | 'successions' | 'walk'>): boolean {
    if (a === b) return true;
    return ctx.roster.some((r) => (r.memberPubkey === a && walked(r, b, ctx)) || (r.memberPubkey === b && walked(r, a, ctx)));
}

/**
 * One line's view. A line that isn't sealed (a system line, a tombstone) is not this rule's: the caller draws it as before.
 */
export function groupLineView(line: ServedGroupLine, ctx: GroupLineDisplayContext): GroupLineView {
    const meta = line.metadata && typeof line.metadata === 'object' ? line.metadata : (() => { try { return JSON.parse(line.metadata || '{}'); } catch { return {}; } })();
    const epoch = epochOf(meta);
    if (epoch === null || ctx.fromEpoch === null || epoch < ctx.fromEpoch) return hiddenView;
    const key = ctx.keyFor(epoch);
    if (!key) {
        return { hidden: false, text: GROUP_LINE_WAITING_KEY_TEXT, name: null, nameHint: null, details: null, unverified: false, waitingKey: true, signer: null, after: null, epoch };
    }
    const part: GroupLinePart = line.editedAt ? 'edit' : 'body';
    const replyToId = typeof meta?.replyToId === 'string' && meta.replyToId ? meta.replyToId : null;
    const candidates = [...new Set([typeof meta?.sender === 'string' ? meta.sender : null, line.authorPubkey].filter((k): k is string => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k)))];
    for (const signer of candidates) {
        let opened: OpenedGroupLine;
        try {
            opened = ctx.open({ ciphertext: line.ciphertext, nonce: line.nonce }, { groupId: ctx.groupId, epoch, senderPubHex: signer, messageId: line.id, part, replyToId }, key, ctx.memo);
        } catch {
            continue;
        }
        // An edit is signed by its editor: on this phone, one by anyone but the line's first signer (or that member's
        // other keys) is not the author's words (§4 rule 3).
        const first = ctx.signerSeen?.(line.id);
        if (line.editedAt && first && !sameMember(signer, first, ctx)) return unverifiedView(epoch);
        const named = nameSigner(signer, line, ctx);
        return { hidden: false, text: opened.text, ...named, unverified: false, waitingKey: false, signer, after: opened.after, epoch };
    }
    return unverifiedView(epoch);
}

/** True if a served line is a sealed group line this rule draws. */
export function isSealedGroupLine(line: Pick<ServedGroupLine, 'nonce' | 'type'>): boolean {
    return isGroupEncryptedNonce(line.nonce) && line.type !== 'system' && line.type !== 'removed';
}

/** In-thread search (design §10): the open chat's shown lines whose words hold the query, any case. Nothing leaves the phone. */
export function searchShownLines<T extends { text: string }>(lines: readonly T[], query: string): T[] {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return [...lines];
    return lines.filter((l) => typeof l.text === 'string' && l.text.toLocaleLowerCase().includes(q));
}
