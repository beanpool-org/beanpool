// Per-member, per-chat mute (groups decision 12, 2026-09-19).
//
// WhatsApp's model: every message in a DM or a group notifies by default; a member can mute one chat for
// 8 hours, a week, or always; an @mention of them still gets through. The mute is stored on the node so
// it follows the member across devices and applies where pushes are decided — here, not in the app.
// A mute only silences pushes. Unread counts, the Talk list and live updates are unchanged.

import { db } from '../db/db.js';

export type ChatMuteDuration = '8h' | '1w' | 'always';

export const CHAT_MUTE_DURATIONS: readonly ChatMuteDuration[] = ['8h', '1w', 'always'] as const;

const DURATION_MS: Record<Exclude<ChatMuteDuration, 'always'>, number> = {
    '8h': 8 * 60 * 60 * 1000,
    '1w': 7 * 24 * 60 * 60 * 1000,
};

export interface ChatMute {
    conversationId: string;
    /** null while muted for good ("always"). */
    mutedUntil: string | null;
    always: boolean;
}

export function isChatMuteDuration(v: unknown): v is ChatMuteDuration {
    return typeof v === 'string' && (CHAT_MUTE_DURATIONS as readonly string[]).includes(v);
}

export function setChatMute(conversationId: string, memberPubkey: string, duration: ChatMuteDuration, nowMs = Date.now()): ChatMute {
    if (!isChatMuteDuration(duration)) throw new Error("duration must be '8h', '1w' or 'always'");
    const mutedUntil = duration === 'always' ? null : new Date(nowMs + DURATION_MS[duration]).toISOString();
    db.prepare(`
        INSERT INTO chat_mutes (conversation_id, member_pubkey, muted_until, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(conversation_id, member_pubkey) DO UPDATE SET muted_until = excluded.muted_until, created_at = excluded.created_at
    `).run(conversationId, memberPubkey, mutedUntil, new Date(nowMs).toISOString());
    return { conversationId, mutedUntil, always: mutedUntil === null };
}

export function clearChatMute(conversationId: string, memberPubkey: string): boolean {
    return db.prepare('DELETE FROM chat_mutes WHERE conversation_id = ? AND member_pubkey = ?')
        .run(conversationId, memberPubkey).changes > 0;
}

/** The member's mute on one chat, or null when it is not muted (an expired timed mute counts as none). */
export function getChatMute(conversationId: string, memberPubkey: string, nowMs = Date.now()): ChatMute | null {
    const row = db.prepare('SELECT muted_until FROM chat_mutes WHERE conversation_id = ? AND member_pubkey = ?')
        .get(conversationId, memberPubkey) as { muted_until: string | null } | undefined;
    if (!row) return null;
    if (row.muted_until !== null && Date.parse(row.muted_until) <= nowMs) return null;
    return { conversationId, mutedUntil: row.muted_until, always: row.muted_until === null };
}

/** Every live mute the member holds, keyed by conversation id — one query for a whole chat list. */
export function getChatMutesFor(memberPubkey: string, nowMs = Date.now()): Map<string, ChatMute> {
    const rows = db.prepare('SELECT conversation_id, muted_until FROM chat_mutes WHERE member_pubkey = ?')
        .all(memberPubkey) as { conversation_id: string; muted_until: string | null }[];
    const out = new Map<string, ChatMute>();
    for (const r of rows) {
        if (r.muted_until !== null && Date.parse(r.muted_until) <= nowMs) continue;
        out.set(r.conversation_id, { conversationId: r.conversation_id, mutedUntil: r.muted_until, always: r.muted_until === null });
    }
    return out;
}

/**
 * Who of `recipients` should get a push for one message in this chat: everyone not muting it, plus anyone
 * @mentioned in it whatever their mute says.
 */
export function unmutedRecipients(conversationId: string, recipients: string[], mentioned: readonly string[] = [], nowMs = Date.now()): string[] {
    if (recipients.length === 0) return [];
    const nowIso = new Date(nowMs).toISOString();
    const muted = new Set((db.prepare(`
        SELECT member_pubkey FROM chat_mutes
        WHERE conversation_id = ? AND (muted_until IS NULL OR muted_until > ?)
    `).all(conversationId, nowIso) as { member_pubkey: string }[]).map(r => r.member_pubkey));
    const mentionedSet = new Set(mentioned);
    return recipients.filter(pk => !muted.has(pk) || mentionedSet.has(pk));
}
