/**
 * "Your groups" on the phone (groups decisions 6, 7, 9, 13; 2026-09-19).
 *
 * One list of every group-like chat the member is in — Commons groups, enterprises they keep (🥖), projects they lead
 * or help (🎯) and events they host or are Going to (📅) — served by the node's GET /api/your-groups (slice 1, #924). Talk's Groups tab shows it
 * with unread counts; Commons → Groups shows the same rows without them (decision 7: nobody clears a count twice).
 *
 * The helpers below are pure so the row wording and the one-header-for-every-chat label are unit tested.
 */

import { formatDate, t, tn, word, type WordKey } from '@beanpool/core';
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
    /** An enterprise-kind row: 'bounded' is a project, 'ongoing' an enterprise (§3.1). A node too old to say: an enterprise. */
    lifecycle?: 'ongoing' | 'bounded';
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

/** The words after the dot in every chat header (decision 9): word() keys, shown through t() (ownerKindWord). */
export const OWNER_KIND_WORD: Readonly<Record<YourChatKind | 'dm', WordKey>> = {
    group: word('group', 'chat kind'),
    enterprise: word('enterprise', 'chat kind'),
    event: word('event', 'chat kind'),
    dm: word('message', 'chat kind'),
};

/** The same kinds as a name: a row's kind pill, a chat's name while it has none. Written capitalised, never upper-cased in code. */
const OWNER_KIND_NAME: Readonly<Record<YourChatKind, WordKey>> = {
    group: word('Group', 'chat kind'),
    enterprise: word('Enterprise', 'chat kind'),
    event: word('Event', 'chat kind'),
};
/** A project, both ways: an enterprise-kind chat whose lifecycle is bounded. */
const PROJECT_WORDS = { kind: word('project', 'chat kind'), name: word('Project', 'chat kind') } as const;

/** An enterprise-kind chat is a project when the node says its lifecycle is 'bounded' (group decisions §3.1). */
const isProject = (kind: YourChatKind, lifecycle?: string | null) => kind === 'enterprise' && lifecycle === 'bounded';

/** The kind word a member reads: a project is a project, never an enterprise (§3.1). */
export function ownerKindWord(kind: YourChatKind, lifecycle?: string | null): string {
    return isProject(kind, lifecycle) ? t(PROJECT_WORDS.kind) : t(OWNER_KIND_WORD[kind]);
}

/** The kind as a name ('Group', 'Enterprise', 'Project', 'Event'), in the member's language. */
export function ownerKindName(kind: YourChatKind, lifecycle?: string | null): string {
    return isProject(kind, lifecycle) ? t(PROJECT_WORDS.name) : t(OWNER_KIND_NAME[kind]);
}

export function chatEmoji(kind: YourChatKind, category?: string | null, lifecycle?: string | null): string {
    if (isProject(kind, lifecycle)) return '🎯';
    if (kind === 'enterprise') return '🥖';
    if (kind === 'event') return '📅';
    return GROUP_CATEGORY_EMOJI[(category as GroupCategory)] ?? '👥';
}

/**
 * The owner line every chat header carries: "🌻 Garden Crew" over "group". Split in two so the name can truncate
 * on a narrow screen while the kind word always shows.
 */
export function ownerHeader(kind: YourChatKind, name: string, category?: string | null, lifecycle?: string | null): { title: string; kindWord: string; a11y: string } {
    const clean = (name || '').trim() || ownerKindName(kind, lifecycle);
    return {
        title: `${chatEmoji(kind, category, lifecycle)} ${clean}`,
        kindWord: ownerKindWord(kind, lifecycle),
        a11y: ownerHeaderSpoken(kind, clean, lifecycle),
    };
}

/** What a screen reader says for a chat's owner line: one sentence per kind. */
function ownerHeaderSpoken(kind: YourChatKind, name: string, lifecycle?: string | null): string {
    if (isProject(kind, lifecycle)) return t('{name}, project. Opens the project page.', { name });
    if (kind === 'enterprise') return t('{name}, enterprise. Opens the enterprise page.', { name });
    if (kind === 'event') return t('{name}, event. Opens the event page.', { name });
    return t('{name}, group. Opens the group page.', { name });
}

/**
 * The second line of a row: "You: see you there", "Ana: bring gloves", a system line as written, or an invitation
 * to start when the chat is empty. The convenor of a brand-new group is nudged to invite people (decision 8).
 */
export function previewLine(item: Pick<YourChat, 'lastMessage' | 'kind' | 'role'>, myPubkey?: string | null): string {
    const m = item.lastMessage;
    if (!m) {
        if (item.kind === 'group' && item.role === 'convenor') return t('New group · invite people to get started');
        return t('No messages yet');
    }
    const text = (m.text || '').replace(/\s+/g, ' ').trim();
    if (m.type === 'system' || m.authorPubkey === 'SYSTEM') return text;
    if (m.type === 'removed') return text;
    if (myPubkey && m.authorPubkey === myPubkey) return t('You: {text}', { text });
    return m.authorCallsign ? t('{name}: {text}', { name: m.authorCallsign, text }) : t('Someone: {text}', { text });
}

/** "14:05" today, "Tue" this week, "12 Sep" before that. Empty for an unreadable timestamp. */
export function rowTime(iso: string | null | undefined, now: Date = new Date()): string {
    if (!iso) return '';
    const t = new Date(iso);
    if (isNaN(t.getTime())) return '';
    const sameDay = t.toDateString() === now.toDateString();
    if (sameDay) return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    const ageDays = (now.getTime() - t.getTime()) / 86_400_000;
    if (ageDays >= 0 && ageDays < 6) return formatDate(t, 'weekday');
    return formatDate(t, 'day-month');
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

/**
 * The line above an enterprise chat's message box. The thread is the enterprise's public discussion: the node
 * checks no role when it is read, any active member may post, and the enterprise's page shows it as "Public
 * coordination for this enterprise". It is not the keepers' private chat, so never say it is (PR #963 review, B1).
 * A group's chat gets its line from the node (members only); an event chat's is EVENT_CHAT_NOTICE.
 */
export const ENTERPRISE_CHAT_NOTICE = word("Any member of this community can read this, and so can the node's operator.");

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
    if (group.viewerStatus === 'active') return { label: t('Open the group chat'), enabled: true };
    if (group.viewerStatus === 'pending_approval') return { label: t('Request sent'), enabled: false, note: t('The convenor will look at your request.') };
    if (group.viewerStatus === 'removed') return { label: t('You can’t rejoin this group'), enabled: false, note: t('A convenor removed you. Only they can let you back in.') };
    if (group.viewerStatus === 'invited') return { label: t('Join the group'), enabled: true };
    if (group.joinPolicy === 'request_to_join') return { label: t('Ask to join'), enabled: true, note: t('The convenor approves new members.') };
    if (group.joinPolicy === 'invite_only') return { label: t('Invitation needed'), enabled: false, note: t('Only people the convenor invites can join.') };
    return { label: t('Join the group'), enabled: true };
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
 * A chat's mute as "Your groups" last knew it — what a chat screen shows before the chat itself has loaded, and all
 * it has on a node too old to send the mute with an enterprise thread. Without it an enterprise chat muted on an
 * earlier visit opened unmuted, with no Unmute in its menu.
 */
export function chatMuteFromRows(items: ReadonlyArray<Pick<YourChat, 'id' | 'conversationId' | 'mute'>> | null | undefined, conversationId: string): YourChatMute | null {
    const row = (items || []).find(i => i.conversationId === conversationId || i.id === conversationId);
    return row?.mute ?? null;
}

/** Whether "Your groups" last knew this chat as a project ('bounded'): what names the chat header's kind. */
export function chatLifecycleFromRows(items: ReadonlyArray<Pick<YourChat, 'id' | 'conversationId' | 'lifecycle'>> | null | undefined, conversationId: string): 'ongoing' | 'bounded' | undefined {
    return (items || []).find(i => i.conversationId === conversationId || i.id === conversationId)?.lifecycle;
}

/**
 * The member's part in an enterprise-kind row, in its kind's words: Leader / Collaborator on a project, Lead keeper /
 * Keeper on an enterprise (the same words as core keeperWords). For a group row: Convenor when the member is a convenor;
 * null for members and observers. Null for an event.
 */
export function rowRoleWord(item: Pick<YourChat, 'kind' | 'role' | 'lifecycle'>): string | null {
    if (item.kind === 'group') {
        return item.role === 'convenor' ? t('Convenor', undefined, 'group role') : null;
    }
    if (item.kind !== 'enterprise') return null;
    if (item.lifecycle === 'bounded') return item.role === 'lead' ? t('Leader', undefined, 'project role') : t('Collaborator', undefined, 'project role');
    return item.role === 'lead' ? t('Lead keeper', undefined, 'enterprise role') : t('Keeper', undefined, 'enterprise role');
}

/**
 * The start of what a screen reader says for a row: its name, its kind and the member's part, one phrase per variant
 * ("Garden Crew, group", "Bakery, enterprise, lead keeper"). The row adds its unread count, muting and preview.
 */
export function rowSpokenName(item: Pick<YourChat, 'kind' | 'role' | 'lifecycle' | 'name'>): string {
    const name = item.name;
    if (item.kind === 'event') return t('{name}, event', { name });
    if (item.kind !== 'enterprise') return t('{name}, group', { name });
    const lead = item.role === 'lead';
    if (item.lifecycle === 'bounded') return lead ? t('{name}, project, leader', { name }) : t('{name}, project, collaborator', { name });
    return lead ? t('{name}, enterprise, lead keeper', { name }) : t('{name}, enterprise, keeper', { name });
}

/** The chat's answer wins when it carries a mute (null included); an answer without the field keeps what we had. */
export function chatMuteFromAnswer(answer: { mute?: YourChatMute | null } | null | undefined, current: YourChatMute | null): YourChatMute | null {
    return answer && 'mute' in answer ? (answer.mute ?? null) : current;
}

/** Record a mute (or null for unmuted) on the chat's row, so the Groups total and the next visit see it at once. */
export function setChatMute<T extends Pick<YourChat, 'conversationId' | 'mute'>>(items: T[], conversationId: string, mute: YourChatMute | null): T[] {
    if (!items.some(i => i.conversationId === conversationId)) return items;
    return items.map(i => (i.conversationId === conversationId ? { ...i, mute } : i));
}

/** The chat menu's mute row: Unmute while muted, otherwise the way into the mute choices. */
export function muteMenuLabel(mute: YourChatMute | null | undefined, now: Date = new Date()): string {
    return isMuted(mute, now) ? t('Unmute') : t('Mute notifications');
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

/**
 * The landing's "Convenor: X": from the roster's faces when they were read, else from the group's own card. Where anyone
 * can join in a minute (openMembership) an invitee's faces read is refused, and the card still names its convenor
 * (#1939 review N4). Null when neither does.
 */
export function inviteLandingConvenor(
    active: ReadonlyArray<{ role: string; callsign?: string | null; memberPubkey: string }>,
    card: { convenorCallsign?: string | null } | null | undefined,
): string | null {
    const fromRoster = active.find(m => m.role === 'convenor');
    if (fromRoster) return fromRoster.callsign || fromRoster.memberPubkey.slice(0, 6);
    return card?.convenorCallsign || null;
}

/** "Garden Crew · 4 members": the facts line, from the node's answer or the tap's preview. */
export function inviteLandingFacts(p: { category?: string | null; memberCount?: number | null; joinPolicy?: string | null }): string {
    const bits: string[] = [];
    // Separate facts, each whole in the member's language, side by side. The tables' own names only: these come from the
    // route's params too, and a "constructor" there is not one.
    const own = (table: object, name: string) => Object.prototype.hasOwnProperty.call(table, name);
    if (p.category) bits.push(own(GROUP_CATEGORY_WORDS, p.category) ? t(GROUP_CATEGORY_WORDS[p.category as GroupCategory]) : t(OWNER_KIND_NAME.group));
    if (typeof p.memberCount === 'number' && p.memberCount >= 0) bits.push(tn(p.memberCount, '{n} member', '{n} members'));
    if (p.joinPolicy && own(JOIN_POLICY_WORDS, p.joinPolicy)) bits.push(t(JOIN_POLICY_WORDS[p.joinPolicy]));
    return bits.join(' · ');
}

/** A group's category by name: word() keys, shown through t(). */
export const GROUP_CATEGORY_WORDS: Readonly<Record<GroupCategory, WordKey>> = {
    social: word('Social Circle'), general: word('General'), working_group: word('Working Group'), project: word('Team'), guild: word('Guild'),
};

/** How a group is joined, as its landing says it: word() keys, shown through t(). */
export const JOIN_POLICY_WORDS: Readonly<Record<string, WordKey>> = {
    open: word('Anyone can join'), request_to_join: word('Ask to join'), invite_only: word('Invite only'),
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
