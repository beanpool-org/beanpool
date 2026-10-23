// What the team's inbox gets for a new post or comment in r/beanpool (Marty, 2026-10-23): one JSON message on a second,
// private ntfy topic, which the team's own fetch script (scripts/reddit-inbox.mjs) reads so each new item can be sorted
// and an answer drafted for a moderator to post (TRIAGE.md). Unlike the phone notice it carries the item's public text,
// so a question can be answered without opening Reddit; like it, it never carries who wrote it. Pure: a trigger's
// payload in, an item or null out. It goes exactly where the phone notice goes: toNotice decides what to skip.

import { fromPermalink, oneLine, toNotice } from './notice';

export type AgentItem = {
    v: 1;
    kind: 'post' | 'comment';
    /** Reddit's full id, t3_… or t1_…. */
    id: string;
    /** The item on www.reddit.com. */
    permalink: string;
    /** The post's title (a comment's: the title of the post it is on). */
    title: string;
    /** A post's text or a comment's, at most BODY_MAX characters; '' for a link or image post. */
    body: string;
    /** The post's flair (a comment's: its post's), '' when it has none. */
    flair: string;
    /** When Reddit says it was made, as an ISO time, or null when the payload doesn't say. */
    createdAt: string | null;
    /** A comment's parent: the post, or the comment it answers. Posts have none. */
    parentPermalink?: string;
};

/** Reddit allows titles of up to 300 characters. */
export const AGENT_TITLE_MAX = 300;
export const BODY_MAX = 2000;
/**
 * ntfy.sh keeps a message of up to 4,096 bytes as text and turns a longer one into an attachment, which the fetch script
 * would have to fetch again. The whole message stays under this, the body cut shorter when it must.
 */
export const MESSAGE_MAX_BYTES = 4000;
const FLAIR_MAX = 64;
const REDDIT = 'https://www.reddit.com';
const BASE36 = /^[a-z0-9]{1,16}$/i;
const UTF8 = new TextEncoder();

type Item = Record<string, unknown>;

const obj = (v: unknown): Item | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Item) : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// What Unicode draws as nothing: format characters (Cf: direction overrides, zero-width spaces, the "tag" letters) and
// the default-ignorable code points (variation selectors, Hangul fillers, the combining grapheme joiner).
const HIDDEN = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
const EMOJI = /\p{Emoji}/u;
const JOINERS = new Set(['\u200C', '\u200D']);
const shown = (c: string | undefined): c is string => c !== undefined && !HIDDEN.test(c);

/**
 * Without the characters a reader cannot see, which can hide words from a person but not from a program: the text is
 * read by the team's tools, and what it says should be what a person reading it sees. Two are kept, one at a time, where
 * they change what is drawn: U+FE0F (draw as emoji) straight after a character that can be one, and a joiner (U+200C,
 * U+200D, which emoji and some scripts need) alone between two characters that are drawn. A run of them never is.
 */
export function visible(raw: unknown): string {
    const chars = Array.from(str(raw));
    let out = '';
    let keptLast = false;
    chars.forEach((c, i) => {
        const prev = chars[i - 1];
        // A joiner after a kept U+FE0F stays: \u2764\uFE0F\u200D\uD83D\uDD25 is \u2764, U+FE0F, U+200D, \uD83D\uDD25.
        keptLast =
            shown(c) ||
            (c === '\uFE0F' && shown(prev) && EMOJI.test(prev)) ||
            (JOINERS.has(c) && keptLast && shown(chars[i + 1]));
        if (keptLast) out += c;
    });
    return out;
}

/** Text as written, on its lines: no control characters but new lines and tabs, no line ending in spaces, at most `max`. */
export function plainText(raw: unknown, max = BODY_MAX): string {
    const text = visible(raw)
        .replace(/\r\n?/g, '\n')
        .replace(/[^\P{Cc}\n\t]+/gu, ' ')
        .replace(/[ \t]+$/gmu, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return cut(Array.from(text), max);
}

/** The first `max` characters, the last of them "…" when it is cut. */
function cut(chars: string[], max: number): string {
    return chars.length <= max ? chars.join('') : max < 1 ? '' : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/**
 * Reddit's createdAt as an ISO time. Devvit's proto calls it a number without saying in what: a value this large is
 * milliseconds, a smaller one seconds. Anything outside 2005–2100 (Reddit's lifetime, with room) is not trusted.
 */
export function isoTime(raw: unknown): string | null {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
    const ms = raw >= 1e11 ? raw : raw * 1000;
    if (ms < Date.UTC(2005, 0, 1) || ms > Date.UTC(2100, 0, 1)) return null;
    return new Date(Math.floor(ms)).toISOString();
}

function baseId(full: unknown, kind: 't1' | 't3'): string {
    const s = str(full);
    const bare = s.startsWith(`${kind}_`) ? s.slice(3) : s;
    return BASE36.test(bare) ? bare.toLowerCase() : '';
}

/**
 * A comment's parent on www.reddit.com. A reply to a comment: the comment's own link with the parent's id in its place
 * (Reddit's form, /r/<sub>/comments/<post>/<slug>/<comment>/). A top-level comment: its post's link.
 */
function parentLink(e: Item, commentUrl: string, commentId: string): string {
    const comment = obj(e.comment) ?? {};
    const post = obj(e.post);
    const subName = str(obj(e.subreddit)?.name);
    const subPath = /^[A-Za-z0-9_]{2,21}$/.test(subName) ? `/r/${subName}` : '';
    const postId = baseId(comment.postId, 't3') || baseId(post?.id, 't3');
    const parent = str(comment.parentId).startsWith('t1_') ? baseId(comment.parentId, 't1') : '';
    if (parent) {
        const tail = `/${commentId}/`;
        if (commentUrl.endsWith(tail)) return `${commentUrl.slice(0, -tail.length)}/${parent}/`;
        return `${REDDIT}${subPath}/comments/${postId}/_/${parent}/`;
    }
    const own = post && baseId(post.id, 't3') === postId ? fromPermalink(post.permalink) : '';
    return own || `${REDDIT}${subPath}/comments/${postId}/`;
}

/**
 * The message as sent: compact JSON of at most MESSAGE_MAX_BYTES, the body cut as far as it must be; null when even an
 * empty body would not fit (only a payload far from Reddit's own could make one).
 */
export function agentMessage(item: AgentItem): string | null {
    const fits = (body: string) => {
        const text = JSON.stringify({ ...item, body });
        return UTF8.encode(text).length <= MESSAGE_MAX_BYTES ? text : null;
    };
    const whole = fits(item.body);
    if (whole) return whole;
    const chars = Array.from(item.body);
    // The longest cut that fits: its bytes only grow with its length.
    let lo = 0;
    let hi = chars.length - 1;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fits(cut(chars, mid))) lo = mid;
        else hi = mid - 1;
    }
    return fits(cut(chars, lo));
}

/**
 * The inbox item for a new post or comment, or null when the phone notice would skip it (README, "What it leaves out").
 * `quiet` is the team's own accounts, as for toNotice. It reads the author only to skip: no name or id is kept.
 */
export function toAgentItem(event: unknown, quiet: Set<string> = new Set()): AgentItem | null {
    const notice = toNotice(event, quiet);
    if (!notice) return null;
    const e = obj(event) ?? {};
    const post = obj(e.post);
    const title = oneLine(visible(post?.title), AGENT_TITLE_MAX);
    const flair = oneLine(visible(obj(post?.linkFlair)?.text), FLAIR_MAX);

    if (notice.id.startsWith('t3_')) {
        return {
            v: 1,
            kind: 'post',
            id: notice.id,
            permalink: notice.url,
            title,
            body: plainText(post?.selftext),
            flair,
            createdAt: isoTime(post?.createdAt),
        };
    }
    const comment = obj(e.comment) ?? {};
    return {
        v: 1,
        kind: 'comment',
        id: notice.id,
        permalink: notice.url,
        title,
        body: plainText(comment.body),
        flair,
        createdAt: isoTime(comment.createdAt),
        parentPermalink: parentLink(e, notice.url, notice.id.slice(3)),
    };
}
