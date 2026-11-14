/**
 * The forum: sections, topics with a title, replies under them (scratch/fable-design/DESIGN-forums-fable.md, as changed by
 * DESIGN-forums-messaging-joint-fable.md; Marty answered all four questions, 13 and 14 Nov 2026). Slice F0: one file for the
 * node and both apps, holding the limits, the starter sections and their words, the link and mention rules, the fields a
 * public answer may hold, the proof an Ask to join carries, and the order topics list in. No behaviour of its own.
 *
 * - **Where it is on.** `features.forum` is present and true where the node has a forum (every community, until its owners
 *   switch it off under How this community works). A server from before it says nothing, which is read as OFF.
 *   `features.forumPublic` is present only where anyone on the web will be able to read it (the global community).
 * - **Words.** Members never read "lounge", "node", "thread" or "category": a forum has sections, a section has topics, a
 *   topic has replies. A starter section's name is a word here, so each language reads its own; a renamed one shows as the
 *   owner typed it.
 * - **No Beans anywhere in it.** Nothing here prices, pays or counts.
 *
 * Pure and universal: no Node built-ins, no Intl (the barrel is bundled for the phone). @noble/hashes for the proof.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { splitTextWithLinks } from './chat-links.js';
import { t, word, type WordKey } from './words.js';

/** The feature keys in a node's `features` (GET /api/community/info, /api/community/me, /api/home). */
export const FORUM_FEATURE = 'forum' as const;
export const FORUM_PUBLIC_FEATURE = 'forumPublic' as const;

/** Whether a node's `features` says it has a forum. Absent (a server from before it) is off. */
export function forumOn(features: { forum?: unknown } | null | undefined): boolean {
    return features?.forum === true;
}

/**
 * Whether a node's `features` says it sends the forum's notices (slice F5): present only where the forum is on, on a server
 * that takes the member's Forum switch (`notify_forum`). Both apps show the switch in Settings → Notifications only here: a
 * server from before F5 refuses the key, and the web app saves every switch at once.
 */
export function forumNoticesOn(features: object | null | undefined): boolean {
    return (features as { forumNotices?: unknown } | null | undefined)?.forumNotices === true;
}

/** The member's preference behind the Forum switch: on until they turn it off, as every push switch is. */
export const FORUM_PUSH_PREF = 'notify_forum' as const;

/** Settings → Notifications: the Forum switch's name (and its label for a screen reader), and its line. Both apps. */
export const FORUM_PUSH_WORDS = {
    switchName: word('Forum'),
    switchLine: word('Replies in topics you follow, mentions, and first topics'),
} as const;

/** What a member does with one topic's notices: follow it (each reply tells them), mute it (nothing does), or neither. */
export type ForumFollow = 'following' | 'muted';

/**
 * The limits, in characters as the apps' fields count them (design §2). The section name and about line are not in the
 * design; 40 and 200 fit a 320 px row and a line under it.
 */
export const FORUM_LIMITS = Object.freeze({
    title: 100,
    /** A topic's opening words. */
    opening: 5000,
    /** A reply: the size of a Learn page's body, so a good answer always fits one. */
    reply: 3000,
    photos: 3,
    /** A place, in words ("near Kyogle"); never a map point. */
    place: 80,
    mentions: 5,
    /** Links a known member's post may hold; a new member's are plain text (slice F2). */
    links: 5,
    sections: 12,
    sectionName: 40,
    sectionAbout: 200,
    pinsPerSection: 2,
    /** Posts in one read of a topic, and topics in one read of a list. */
    postsPerPage: 30,
    topicsPerPage: 30,
    /** Things one topic may link (slice F9): a listing, an event, a poll, a group, a Decision or a Learn page. */
    topicLinks: 3,
});

/**
 * New topics and replies in any 24 hours (design §5). Owners and admins use the "Owner and admin limit" instead, as they do
 * for posts. `new` and `newWords` are for an account still new (slice F2: its first days, by the sign-in door or the
 * 12-words one); `known` for everyone else.
 */
export const FORUM_DAY_LIMITS = Object.freeze({
    known: Object.freeze({ topics: 10, replies: 100 }),
    new: Object.freeze({ topics: 2, replies: 10 }),
    newWords: Object.freeze({ topics: 1, replies: 5 }),
});

/** The forum's clocks (design §3, §5, §7). */
export const FORUM_TIMES = Object.freeze({
    /** A new account may edit a post only this long after writing it (so an approved first topic can't be swapped). */
    newEditMinutes: 60,
    /** On the global community a topic with no reply for this long closes, still readable. */
    quietCloseDays: 180,
    /** The wording before an edit is kept this long, for moderators only. */
    editsKeptDays: 30,
    /** A first topic waits for a look at most this long, then goes back to its writer. */
    firstLookDays: 30,
    /** A public topic may be listed by search engines once it is this old and still up (Marty, Q2, 14 Nov 2026). */
    indexAfterDays: 2,
});

/** Searches a member may make in a day (the number people-search uses), and the most followers a reply's push reaches. */
export const FORUM_SEARCHES_PER_DAY = 100;
export const FORUM_PUSH_FOLLOWERS_MAX = 200;

// ── Sections ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Who may start a topic in a section: any member, or only owners and admins ("News from BeanPool"). */
export type ForumSectionStarts = 'members' | 'staff';

export interface ForumStarterSection {
    /** Kept in the section's row while its name is the starter's own, so each language reads its word. */
    id: string;
    name: WordKey;
    starts: ForumSectionStarts;
    /** Whether search engines may list its topics (global only, F7). "Introduce yourself" never (Marty, Q2). */
    listed: boolean;
}

/**
 * The sections a forum starts with, made once when its server first finds none (design §2; local per Marty, Q3). Global's
 * "Builders" is not here: it is a section tied to an invite-only group, made with slice F8.
 */
export const FORUM_STARTER_SECTIONS: Readonly<Record<'global' | 'local', readonly ForumStarterSection[]>> = Object.freeze({
    global: Object.freeze([
        { id: 'news', name: word('News from BeanPool'), starts: 'staff', listed: true },
        { id: 'introduce', name: word('Introduce yourself'), starts: 'members', listed: false },
        { id: 'start-community', name: word('Start a community near you'), starts: 'members', listed: true },
        { id: 'skills', name: word('Skills & how-to'), starts: 'members', listed: true },
        { id: 'ideas-beanpool', name: word('Ideas for BeanPool'), starts: 'members', listed: true },
    ] as const),
    local: Object.freeze([
        { id: 'general', name: word('General'), starts: 'members', listed: false },
        { id: 'ideas-local', name: word('Ideas for our community'), starts: 'members', listed: false },
    ] as const),
});

/** A starter section by id, from either list, or undefined. */
export function forumStarterSection(id: unknown): ForumStarterSection | undefined {
    return [...FORUM_STARTER_SECTIONS.global, ...FORUM_STARTER_SECTIONS.local].find((s) => s.id === id);
}

/**
 * A section's name in the reader's language: the name its owner typed, else its starter's word. `starter` is cleared when an
 * owner renames it, so a renamed starter shows as typed.
 */
export function forumSectionName(section: { starter?: string | null; name?: string | null }): string {
    if (section.name) return section.name;
    const starter = forumStarterSection(section.starter);
    return starter ? t(starter.name) : '';
}

// ── Links and mentions ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * The links in a post's words, in order: `http://…`, `https://…` or a bare `www.…`, the chat's own rule (chat-links.ts), so
 * the forum and the chat never disagree about what is a link.
 */
export function forumLinks(words: string | null | undefined): string[] {
    return splitTextWithLinks(words).filter((run) => run.isUrl).map((run) => run.text);
}

/** Whether a post's words hold no more links than a post may (FORUM_LIMITS.links). */
export function forumLinksFit(words: string | null | undefined): boolean {
    return forumLinks(words).length <= FORUM_LIMITS.links;
}

/**
 * A post's words as runs to draw: links tappable only where `linksOn` (a known writer's post); a new writer's are plain text
 * (design §5), so nothing in them can be tapped before a moderator has seen them.
 */
export function forumWordRuns(words: string | null | undefined, linksOn: boolean): { text: string; isUrl: boolean }[] {
    const runs = splitTextWithLinks(words);
    return linksOn ? runs : runs.map((run) => ({ text: run.text, isUrl: false }));
}

/** Characters that end a mention's name. */
const MENTION_ENDS = ' \t\n\r.,;:!?()[]{}"\'«»“”‘’<>@/\\';

/**
 * The names @mentioned in a post's words, each once, in order: an `@` at the start or after a space, then the name up to the
 * next space or punctuation. Who they are (only people already in that topic) is the node's to find (slice F5).
 */
export function forumMentions(words: string | null | undefined): string[] {
    const text = String(words ?? '');
    const found: string[] = [];
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '@') continue;
        if (i > 0 && !' \t\n\r('.includes(text[i - 1])) continue;
        let end = i + 1;
        while (end < text.length && !MENTION_ENDS.includes(text[end])) end++;
        const name = text.slice(i + 1, end);
        if (name && !found.some((n) => n.toLowerCase() === name.toLowerCase())) found.push(name);
        i = end - 1;
    }
    return found;
}

/** Whether a post mentions no more people than a post may (FORUM_LIMITS.mentions). */
export function forumMentionsFit(words: string | null | undefined): boolean {
    return forumMentions(words).length <= FORUM_LIMITS.mentions;
}

// ── The order topics list in ────────────────────────────────────────────────────────────────────────────────────

export interface ForumTopicOrder {
    id: string;
    pinned: boolean;
    /** ISO time of the newest reply, or of the topic itself with none. */
    lastActivityAt: string;
}

/**
 * Pinned topics first, then the newest activity, then the id (so two topics active in the same millisecond keep one order).
 * The node's SQL sorts the same way: `(pinned_at IS NOT NULL) DESC, last_activity_at DESC, id ASC`.
 */
export function compareForumTopics(a: ForumTopicOrder, b: ForumTopicOrder): number {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.lastActivityAt !== b.lastActivityAt) return a.lastActivityAt > b.lastActivityAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ── What a public answer may hold (slice F7) ────────────────────────────────────────────────────────────────────

/**
 * Every field an unsigned answer about the forum may carry, by the kind of thing (design §7). Never a picture of a person, a
 * key, a profile link, an area, who voted, who follows. A test holds the public JSON to exactly these: a field added to an
 * answer without being added here fails it, so nothing new becomes public by a missed filter.
 */
export const FORUM_PUBLIC_FIELDS = Object.freeze({
    section: Object.freeze(['id', 'starter', 'name', 'about', 'position', 'topicCount'] as const),
    topic: Object.freeze(['id', 'sectionId', 'title', 'writer', 'createdAt', 'lastActivityAt', 'replyCount', 'pinned', 'closed', 'place', 'lang', 'indexable'] as const),
    post: Object.freeze(['id', 'topicId', 'number', 'writer', 'words', 'quotes', 'createdAt', 'edited', 'removed', 'photos', 'lang', 'proof'] as const),
    /** A writer on a public page: a name, and the community label they switched on (slice F10), else null. */
    writer: Object.freeze(['name', 'community'] as const),
});

export type ForumPublicKind = keyof typeof FORUM_PUBLIC_FIELDS;

/**
 * The fields of `value` a public answer of `kind` may not hold, as `kind.field` (a writer's own as `writer.field`), or an
 * empty list when it holds only allowed ones. Not an object at all is `kind` itself.
 */
export function forumPublicShapeProblems(kind: ForumPublicKind, value: unknown): string[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [kind];
    const allowed = FORUM_PUBLIC_FIELDS[kind] as readonly string[];
    const problems: string[] = [];
    for (const [field, v] of Object.entries(value as Record<string, unknown>)) {
        if (!allowed.includes(field)) problems.push(`${kind}.${field}`);
        else if (field === 'writer' && v !== null) problems.push(...forumPublicShapeProblems('writer', v));
    }
    return problems;
}

// ── The proof an Ask to join carries (slice F11) ────────────────────────────────────────────────────────────────

/** What the proof's HMAC is over, before the post's id and the writer's key. A new form gets a new tag. */
export const FORUM_PROOF_TAG = 'beanpool-forum-post-proof-v1';

const HEX_64 = '0123456789abcdef';
function isHex64(value: unknown): value is string {
    if (typeof value !== 'string' || value.length !== 64) return false;
    for (const ch of value) if (!HEX_64.includes(ch)) return false;
    return true;
}

export interface ForumProofInput {
    postId: string;
    /** The writer's key, 64 lower-case hex. */
    writerKey: string;
    /** 32 bytes as 64 lower-case hex: only the global community and the writer can get it. */
    secret: string;
}

/**
 * The proof global's public JSON carries for a post (design §13): HMAC-SHA256 keyed by the writer's secret over the tag, the
 * post's id and the writer's key, each on its own line, as lower-case hex. Nobody without the secret can test a key against
 * a public post; an admin's app, given the secret by the asker and knowing the asking key, makes the same proof and compares.
 * Throws on a key or secret that is not 64 lower-case hex, or an empty post id.
 */
export function forumPostProof(input: ForumProofInput): string {
    if (!input.postId || typeof input.postId !== 'string') throw new Error('forumPostProof: postId is required');
    if (!isHex64(input.writerKey)) throw new Error('forumPostProof: writerKey is 64 lower-case hex');
    if (!isHex64(input.secret)) throw new Error('forumPostProof: secret is 64 lower-case hex');
    const text = `${FORUM_PROOF_TAG}\n${input.postId}\n${input.writerKey}`;
    return bytesToHex(hmac(sha256, hexToBytes(input.secret), utf8ToBytes(text)));
}

/**
 * Whether `proof` (from a public post) is the one the asking key and the secret it sent make for that post. False, never a
 * throw, for anything malformed: an Ask to join is accepted either way, only the tick differs.
 */
export function forumPostProofMatches(proof: unknown, input: ForumProofInput): boolean {
    if (!isHex64(proof)) return false;
    let made: string;
    try {
        made = forumPostProof(input);
    } catch {
        return false;
    }
    let diff = 0;
    for (let i = 0; i < made.length; i++) diff |= made.charCodeAt(i) ^ proof.charCodeAt(i);
    return diff === 0;
}
