/**
 * A DM stays a DM (crypto review M F2 follow-up, 2026-10-02).
 *
 * The node says what type a conversation is, and a group's, an event's and an enterprise's chats are node-readable by
 * design: their lines are plaintext-v1, shown as written, and this app sends them readable. So the node retyping a DM
 * as one of those would show its unencrypted lines as members' words, and make this app send the next line readable.
 * A conversation this browser has ever seen as a DM, or that holds an encrypted line (no node-readable chat ever does:
 * the node refuses one), stays a DM here whatever the node says. A type change from the node is ignored, and logged.
 * The phone does the same (apps/native/utils/db.ts, the DM guard).
 *
 * Kept in localStorage, which is this community's own (one origin per node); it can come back empty (a private window,
 * cleared site data), when the encrypted lines still tell.
 */
import { isEncryptedNonce } from './e2e-crypto';

const KEY = 'beanpool_dm_conversations_seen';

function seen(): Set<string> {
    try {
        const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
        return new Set(Array.isArray(raw) ? raw.filter((x: unknown) => typeof x === 'string') : []);
    } catch {
        return new Set();
    }
}

/** Remember conversations seen as DMs. Never forgotten. */
export function rememberDmConversations(ids: readonly string[]): void {
    const s = seen();
    const before = s.size;
    for (const id of ids) if (typeof id === 'string' && id) s.add(id);
    if (s.size === before) return;
    try { localStorage.setItem(KEY, JSON.stringify([...s])); } catch { /* storage blocked: the encrypted lines still tell */ }
}

/** True for a conversation seen here as a DM, or one of whose lines (when given) is encrypted. */
export function isKnownDmConversation(id: string, lines?: ReadonlyArray<{ nonce?: string | null }>): boolean {
    if (!id) return false;
    if (seen().has(id)) return true;
    return !!lines?.some((l) => isEncryptedNonce(l?.nonce ?? undefined));
}

/**
 * The conversation as this app keeps it: a DM the node now types otherwise stays a DM (logged); one the node types as a
 * DM is remembered as one. `lines`: the conversation's lines, when they are at hand.
 */
export function heldConversation<T extends { id: string; type: string }>(conv: T, lines?: ReadonlyArray<{ nonce?: string | null }>): T {
    if (!conv?.id) return conv;
    if (conv.type === 'dm') {
        rememberDmConversations([conv.id]);
        return conv;
    }
    if (isKnownDmConversation(conv.id, lines)) {
        console.warn(`[DM guard] the node calls DM ${conv.id.slice(0, 8)} a ${conv.type}: ignored, it stays a DM`);
        rememberDmConversations([conv.id]);
        return { ...conv, type: 'dm' as T['type'] };
    }
    return conv;
}
