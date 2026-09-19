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

/**
 * Talk's Groups switch total (decision 12, WhatsApp's rule): every unread message in your groups, enterprises and
 * events, except in a chat you muted — a muted chat keeps its own grey count on its row but adds nothing here.
 */
export function groupsUnreadTotal(items: ReadonlyArray<Pick<YourChat, 'unreadCount' | 'mute'>> | null | undefined, now: Date = new Date()): number {
    return (items || []).reduce((n, g) => n + (isMuted(g.mute, now) ? 0 : Math.max(0, g.unreadCount || 0)), 0);
}

/**
 * A row's unread badge. Only Talk shows one (decision 7); a muted chat's badge is grey. Nothing for zero.
 */
export function rowBadge(item: Pick<YourChat, 'unreadCount' | 'mute'>, showUnread: boolean, now: Date = new Date()): { label: string; muted: boolean } | null {
    if (!showUnread) return null;
    const label = unreadLabel(item.unreadCount);
    return label ? { label, muted: isMuted(item.mute, now) } : null;
}

export type YourGroupsPaneState = 'loading' | 'error' | 'empty' | 'list';

/**
 * What the Your groups list shows. A list already on screen stays when a later refresh fails (a dropped signal is
 * not a reason to blank it); an error shows only when there is nothing to show instead.
 */
export function yourGroupsPaneState(items: ReadonlyArray<unknown> | null, error: string | null): YourGroupsPaneState {
    if (items === null) return error ? 'error' : 'loading';
    return items.length ? 'list' : 'empty';
}

/** Opening a chat reads it: its count drops to zero at once. The same array when there was nothing to clear. */
export function markChatRead<T extends Pick<YourChat, 'conversationId' | 'unreadCount'>>(items: T[], conversationId: string): T[] {
    if (!items.some(i => i.conversationId === conversationId && i.unreadCount)) return items;
    return items.map(i => (i.conversationId === conversationId && i.unreadCount ? { ...i, unreadCount: 0 } : i));
}

/**
 * The new group's empty chat opens on "Who do you want to invite?" (decision 8) for its convenor while it is just
 * them: nobody else is in it, nobody has been asked, and nothing has been said. "Not now" skips it for good on this
 * visit; Invite people stays in the header menu.
 */
export function showInvitePrompt(s: {
    kind: 'group' | 'enterprise';
    isConvenor: boolean;
    justCreated: boolean;
    activeCount: number | null;
    invitedCount: number;
    spokenCount: number;
    skipped: boolean;
}): boolean {
    if (s.kind !== 'group' || s.skipped || s.invitedCount > 0 || s.spokenCount > 0) return false;
    const alone = s.isConvenor && (s.activeCount ?? 0) <= 1;
    return s.justCreated || alone;
}

// ── The invite landing (groups slice 2) ──────────────────────────────────────────────────────────────────────

/** What the tap that opened the landing already knew, so the page is drawn before the node answers. */
export interface InviteLandingPreview {
    name?: string;
    category?: string;
    joinPolicy?: string;
    memberCount?: number;
    /** Opened from a row that said INVITED. */
    invited?: boolean;
}

export type InviteLandingPhase =
    /** Nothing from the node yet: the outline, with whatever the tap knew. */
    | 'skeleton'
    /** The node answered with the group. */
    | 'ready'
    /** The node could not be reached, or answered with something other than the group or "not found". */
    | 'error'
    /** No such group for this member (#828: invite-only groups answer "not found" to outsiders). */
    | 'unavailable'
    /** Opened as an invitation, but it is no longer open and there is no other way in. */
    | 'expired';

/**
 * The landing's one state, from what the node has said so far. `group` undefined = still waiting; null = the
 * node said not found.
 */
export function inviteLandingPhase(s: {
    group: Pick<GroupItem, 'joinPolicy' | 'viewerStatus'> | null | undefined;
    error: string | null;
    openedAsInvite: boolean;
}): InviteLandingPhase {
    if (s.group === undefined) return s.error ? 'error' : 'skeleton';
    if (s.group === null) return s.openedAsInvite ? 'expired' : 'unavailable';
    const status = s.group.viewerStatus;
    const stillLive = status === 'invited' || status === 'active' || status === 'pending_approval' || status === 'removed';
    if (s.openedAsInvite && !stillLive && s.group.joinPolicy === 'invite_only') return 'expired';
    return 'ready';
}

/** "Garden Crew · 4 members": the facts line, from the node's answer or the tap's preview. */
export function inviteLandingFacts(p: { category?: string | null; memberCount?: number | null; joinPolicy?: string | null }): string {
    const bits: string[] = [];
    if (p.category) bits.push(GROUP_CATEGORY_WORDS[p.category as GroupCategory] || 'Group');
    if (typeof p.memberCount === 'number' && p.memberCount >= 0) bits.push(`${p.memberCount} ${p.memberCount === 1 ? 'member' : 'members'}`);
    if (p.joinPolicy && JOIN_POLICY_WORDS[p.joinPolicy]) bits.push(JOIN_POLICY_WORDS[p.joinPolicy]);
    return bits.join(' · ');
}

export const GROUP_CATEGORY_WORDS: Readonly<Record<GroupCategory, string>> = {
    social: 'Social Circle', general: 'General', working_group: 'Working Group', project: 'Project Team', guild: 'Guild',
};

export const JOIN_POLICY_WORDS: Readonly<Record<string, string>> = {
    open: 'Anyone can join', request_to_join: 'Ask to join', invite_only: 'Invite only',
};

/** Where the landing is opened from a row: the preview travels as route params (strings). */
export function inviteLandingHref(g: Pick<GroupItem, 'id' | 'name' | 'category' | 'joinPolicy' | 'memberCount' | 'viewerStatus'>): { pathname: string; params: Record<string, string> } {
    const params: Record<string, string> = { name: g.name, category: g.category, joinPolicy: g.joinPolicy };
    if (typeof g.memberCount === 'number') params.memberCount = String(g.memberCount);
    if (g.viewerStatus === 'invited') params.invited = '1';
    return { pathname: `/group/${g.id}`, params };
}

/** Route params back into a preview. Anything missing or malformed is simply left out. */
export function inviteLandingPreviewFromParams(p: Record<string, string | string[] | undefined>): InviteLandingPreview {
    const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
    const count = Number(one(p.memberCount));
    return {
        name: one(p.name),
        category: one(p.category),
        joinPolicy: one(p.joinPolicy),
        memberCount: Number.isFinite(count) && count >= 0 ? count : undefined,
        invited: one(p.invited) === '1',
    };
}
