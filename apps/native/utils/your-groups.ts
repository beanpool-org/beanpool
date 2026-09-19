/**
 * "Your groups" on the phone (groups decisions 6, 7, 9, 13; 2026-09-19).
 *
 * One list of every group-like chat the member is in — Commons groups, enterprises they keep (🥖) and events they
 * host or are Going to (📅) — served by the node's GET /api/your-groups (slice 1, #924). Talk's Groups tab shows it
 * with unread counts; Commons → Groups shows the same rows without them (decision 7: nobody clears a count twice).
 *
 * The helpers below are pure so the row wording and the one-header-for-every-chat label are unit tested.
 */

import type { GroupCategory, GroupItem } from './db';

export type YourChatKind = 'group' | 'enterprise' | 'event';

export interface YourChatLastMessage {
    id: string;
    authorPubkey: string;
    authorCallsign: string | null;
    type: string;
    systemType: string | null;
    text: string;
    timestamp: string;
}

export interface YourChatMute {
    conversationId: string;
    /** null while muted for good. */
    mutedUntil: string | null;
    always: boolean;
}

export interface YourChat {
    kind: YourChatKind;
    badge: string | null;
    id: string;
    conversationId: string;
    name: string;
    avatarUrl: string | null;
    role: string;
    category?: string;
    joinPolicy?: string;
    eventStartAt?: string | null;
    eventEndAt?: string | null;
    readOnly: boolean;
    lastMessage: YourChatLastMessage | null;
    unreadCount: number;
    mute: YourChatMute | null;
    lastActivityAt: string;
}

export interface YourChatsResponse {
    items: YourChat[];
    totalUnread: number;
}

/**
 * A group has no picture of its own yet, so its category stands in, as an emoji that reads at 320dp without an
 * image download. 🌻 for Social Circle is the example Marty used ("🌻 Garden Crew · group").
 */
export const GROUP_CATEGORY_EMOJI: Readonly<Record<GroupCategory, string>> = {
    social: '🌻',
    general: '💬',
    working_group: '🤝',
    project: '🛠️',
    guild: '🛡️',
};

/** The words after the dot in every chat header (decision 9). */
export const OWNER_KIND_WORD: Readonly<Record<YourChatKind | 'dm', string>> = {
    group: 'group',
    enterprise: 'enterprise',
    event: 'event',
    dm: 'message',
};

export function chatEmoji(kind: YourChatKind, category?: string | null): string {
    if (kind === 'enterprise') return '🥖';
    if (kind === 'event') return '📅';
    return GROUP_CATEGORY_EMOJI[(category as GroupCategory)] ?? '👥';
}

/**
 * The owner line every chat header carries: "🌻 Garden Crew" over "group". Split in two so the name can truncate
 * on a narrow screen while the kind word always shows.
 */
export function ownerHeader(kind: YourChatKind, name: string, category?: string | null): { title: string; kindWord: string; a11y: string } {
    const clean = (name || '').trim() || (kind === 'event' ? 'Event' : kind === 'enterprise' ? 'Enterprise' : 'Group');
    const word = OWNER_KIND_WORD[kind];
    return {
        title: `${chatEmoji(kind, category)} ${clean}`,
        kindWord: word,
        a11y: `${clean}, ${word}. Opens the ${word} page.`,
    };
}

/**
 * The second line of a row: "You: see you there", "Ana: bring gloves", a system line as written, or an invitation
 * to start when the chat is empty. The convenor of a brand-new group is nudged to invite people (decision 8).
 */
export function previewLine(item: Pick<YourChat, 'lastMessage' | 'kind' | 'role'>, myPubkey?: string | null): string {
    const m = item.lastMessage;
    if (!m) {
        if (item.kind === 'group' && item.role === 'convenor') return 'New group · invite people to get started';
        return 'No messages yet';
    }
    const text = (m.text || '').replace(/\s+/g, ' ').trim();
    if (m.type === 'system' || m.authorPubkey === 'SYSTEM') return text;
    if (m.type === 'removed') return text;
    const who = myPubkey && m.authorPubkey === myPubkey ? 'You' : (m.authorCallsign || 'Someone');
    return `${who}: ${text}`;
}

/** "14:05" today, "Tue" this week, "12 Sep" before that. Empty for an unreadable timestamp. */
export function rowTime(iso: string | null | undefined, now: Date = new Date()): string {
    if (!iso) return '';
    const t = new Date(iso);
    if (isNaN(t.getTime())) return '';
    const sameDay = t.toDateString() === now.toDateString();
    if (sameDay) return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    const ageDays = (now.getTime() - t.getTime()) / 86_400_000;
    if (ageDays >= 0 && ageDays < 6) return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][t.getDay()];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${t.getDate()} ${months[t.getMonth()]}`;
}

/**
 * The words of one message in a node-readable chat. Spoken and removed messages arrive base64 (plaintext-v1);
 * a system line (joins, leaves, role changes) is stored and served as written.
 */
export function threadMessageText(m: { type?: string; authorPubkey?: string; ciphertext?: string }, decode: (c: string, type: string) => string): string {
    if (m.type === 'system' || m.authorPubkey === 'SYSTEM') return String(m.ciphertext ?? '');
    return decode(String(m.ciphertext ?? ''), String(m.type ?? 'text'));
}

/**
 * Where a row (or a just-created group) opens: the one chat screen, told on the way in which kind it is so it
 * never waits on a database read to decide.
 */
export function chatHref(item: { kind: YourChatKind; conversationId: string; name?: string }, opts: { created?: boolean } = {}): { pathname: string; params: Record<string, string> } {
    const params: Record<string, string> = {};
    if (item.kind === 'event') params.event = '1';
    else params[item.kind] = '1';
    if (item.name) params.name = item.name;
    if (opts.created && item.kind === 'group') params.created = '1';
    return { pathname: `/chat/${item.conversationId}`, params };
}

/** A capped badge: 1–99, then "99+". Nothing for zero. */
export function unreadLabel(n: number): string {
    if (!n || n < 1) return '';
    return n > 99 ? '99+' : String(n);
}

/** Muted until a time in the future, or for good. */
export function isMuted(mute: YourChatMute | null | undefined, now: Date = new Date()): boolean {
    if (!mute) return false;
    if (mute.always || mute.mutedUntil === null) return true;
    const t = new Date(mute.mutedUntil).getTime();
    return !isNaN(t) && t > now.getTime();
}

/**
 * Commons → Groups, lower half (decision 7): groups the member could join. Never one they are already in,
 * already asked to join, or were removed from; invite-only groups never reach the phone for an outsider (#828),
 * so there is no extra filter for them here. An open invitation IS shown — it is something they could join.
 */
export function groupsYouCouldJoin(all: GroupItem[], yourGroupIds: ReadonlySet<string>): GroupItem[] {
    return all.filter(g => {
        if (yourGroupIds.has(g.id)) return false;
        if (g.viewerStatus === 'active' || g.viewerStatus === 'pending_approval' || g.viewerStatus === 'removed') return false;
        return true;
    });
}

/** What the invite landing's main button says, from the group's join policy and the viewer's standing. */
export function inviteLandingAction(group: Pick<GroupItem, 'joinPolicy' | 'viewerStatus'>): { label: string; enabled: boolean; note?: string } {
    if (group.viewerStatus === 'active') return { label: 'Open the group chat', enabled: true };
    if (group.viewerStatus === 'pending_approval') return { label: 'Request sent', enabled: false, note: 'The convenor will look at your request.' };
    if (group.viewerStatus === 'removed') return { label: 'You can’t rejoin this group', enabled: false, note: 'A convenor removed you. Only they can let you back in.' };
    if (group.viewerStatus === 'invited') return { label: 'Join the group', enabled: true };
    if (group.joinPolicy === 'request_to_join') return { label: 'Ask to join', enabled: true, note: 'The convenor approves new members.' };
    if (group.joinPolicy === 'invite_only') return { label: 'Invitation needed', enabled: false, note: 'Only people the convenor invites can join.' };
    return { label: 'Join the group', enabled: true };
}
