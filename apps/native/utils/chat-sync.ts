/**
 * What a message that came back from the node does to the row already on the phone.
 *
 * This used to live entirely inside one SQL `ON CONFLICT DO UPDATE` in utils/db, which could express
 * "a newer edit replaces the text" and nothing else — so a DM tombstone (the node replaces the ciphertext
 * and sets `type = 'removed'`, with no editedAt) landed as a metadata-only update and the old words stayed
 * on screen. The decision is pure here so it can be tested without a database, and db.ts applies it.
 */

export interface LocalMessageRow {
    ciphertext: string | null;
    nonce: string | null;
    type: string | null;
    edited_at: string | null;
    metadata: string | null;
}

export interface IncomingMessage {
    id: string;
    authorPubkey?: string;
    author_pubkey?: string;
    ciphertext?: string;
    nonce?: string;
    type?: string;
    systemType?: string | null;
    system_type?: string | null;
    metadata?: string | null;
    timestamp?: string;
    created_at?: string;
    editedAt?: string | null;
    edited_at?: string | null;
}

export interface MergedMessage {
    ciphertext: string;
    nonce: string;
    type: string;
    editedAt: string | null;
    metadata: string | null;
    /** True when the node's copy replaced the words on screen — a tombstone or a newer edit. */
    contentReplaced: boolean;
}

function parseMeta(raw: string | null | undefined): any {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

/** A row the node has turned into a tombstone: `type = 'removed'`, or `metadata.removed`. */
export function isRemovedPayload(m: { type?: string | null; metadata?: string | null }): boolean {
    if (m.type === 'removed') return true;
    return parseMeta(m.metadata)?.removed === true;
}

/**
 * The node's copy merged onto the phone's row.
 *
 * - A tombstone always wins: it is terminal, it carries no editedAt, and both phones must land on it.
 * - A row that is ALREADY a tombstone keeps its words: a sync that was in flight with the pre-delete
 *   content must not un-delete it.
 * - Otherwise the text is replaced only by a strictly-newer edit, exactly as before.
 * - Metadata (reactions, reply refs, send state) always refreshes.
 */
export function mergeIncomingMessage(local: LocalMessageRow | null | undefined, incoming: IncomingMessage): MergedMessage {
    const inCiphertext = incoming.ciphertext ?? '';
    const inNonce = incoming.nonce ?? '';
    const inType = incoming.type || 'text';
    const inEditedAt = incoming.editedAt ?? incoming.edited_at ?? null;
    const inMetadata = incoming.metadata ?? null;

    if (!local) {
        return { ciphertext: inCiphertext, nonce: inNonce, type: inType, editedAt: inEditedAt, metadata: inMetadata, contentReplaced: true };
    }

    const localType = local.type || 'text';
    const keep: MergedMessage = {
        ciphertext: local.ciphertext ?? '',
        nonce: local.nonce ?? '',
        type: localType,
        editedAt: local.edited_at ?? null,
        metadata: inMetadata,
        contentReplaced: false,
    };

    if (isRemovedPayload(incoming)) {
        return { ciphertext: inCiphertext, nonce: inNonce, type: 'removed', editedAt: local.edited_at ?? null, metadata: inMetadata, contentReplaced: true };
    }
    if (isRemovedPayload({ type: localType, metadata: local.metadata })) {
        // Already deleted here. Keep the tombstone, and keep its metadata too: a stale answer's metadata
        // would drop `removed`/`removedBy` and the bubble would read as an ordinary message again.
        return { ...keep, type: 'removed', metadata: local.metadata };
    }
    if (inEditedAt && (!local.edited_at || inEditedAt >= local.edited_at)) {
        return { ciphertext: inCiphertext, nonce: inNonce, type: inType, editedAt: inEditedAt, metadata: inMetadata, contentReplaced: true };
    }
    return keep;
}
