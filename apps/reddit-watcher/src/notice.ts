// What the team hears when someone posts or comments in r/beanpool (Marty, 2026-10-23): one notice per new post or
// comment, so a question gets a person's answer quickly. A notice carries only public Reddit content — the post's
// title and its link — and never who wrote it. Pure: a trigger's payload in, a notice or null out.
//
// The payload is Devvit's OnPostCreateRequest / OnCommentCreateRequest (and the Submit pair, which has the same shape):
// https://developers.reddit.com/docs/capabilities/server/trigger-events. Every field is read as untrusted: objects can
// be missing, deleted content can be redacted, and enums may arrive as numbers or names.

export type Notice = {
    /** Reddit's id for the item (t3_… or t1_…), for the repeat check only: never sent. */
    id: string;
    /** The notification's title: our words and the subreddit's name, so plain ASCII. */
    title: string;
    /** The post's title (or the commented post's), then the link. */
    body: string;
    /** The item on reddit.com, for a tap. */
    url: string;
};

export const TITLE_MAX = 120;
const REDDIT = 'https://www.reddit.com';
const SUBREDDIT = /^[A-Za-z0-9_]{2,21}$/;
const BASE36 = /^[a-z0-9]{1,16}$/i;
// A post's or comment's permalink as Reddit gives it: a path under its subreddit.
const PERMALINK = /^\/r\/[A-Za-z0-9_]{2,21}\/comments\/[a-z0-9]{1,16}(\/[^\s]*)?$/i;

// Reddit's own AutoModerator answers posts by rule: a ping for each of its replies would double every ping.
const QUIET_AUTHORS = new Set(['automoderator']);
// DistinguishType ADMIN (1) and YES (4, a moderator's distinguish): the team's own announcements.
const TEAM_DISTINGUISH = new Set<unknown>([1, 4, 'ADMIN', 'YES']);
// AccountTypeV2 ACCOUNT_TYPE_APP (3): another app's account.
const APP_ACCOUNT = new Set<unknown>([3, 'ACCOUNT_TYPE_APP']);

type Item = Record<string, unknown>;

const obj = (v: unknown): Item | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Item) : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A title on one line: no control characters, runs of space as one, at most TITLE_MAX characters. */
export function oneLine(raw: unknown, max = TITLE_MAX): string {
    const flat = str(raw).replace(/\p{Cc}+/gu, ' ').replace(/\s+/gu, ' ').trim();
    const chars = Array.from(flat);
    return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/** The base-36 part of a full id (`t3_abc` → `abc`) of the given kind, or ''. */
function baseId(full: unknown, kind: 't1' | 't3'): string {
    const s = str(full);
    const bare = s.startsWith(`${kind}_`) ? s.slice(3) : s;
    return BASE36.test(bare) ? bare.toLowerCase() : '';
}

/** Reddit's permalink as an absolute https://www.reddit.com address, or '' when it isn't one. */
function fromPermalink(permalink: unknown): string {
    const p = str(permalink).trim();
    if (PERMALINK.test(p)) return new URL(p, REDDIT).href;
    try {
        const u = new URL(p);
        if (u.protocol === 'https:' && ['www.reddit.com', 'reddit.com'].includes(u.hostname) && PERMALINK.test(u.pathname)) {
            return new URL(u.pathname, REDDIT).href;
        }
    } catch {
        // not a URL at all
    }
    return '';
}

function isGone(item: Item): boolean {
    return item.deleted === true || item.spam === true;
}

/**
 * The quietUsernames setting as a set: names split on commas, spaces or new lines, without a leading u/, in lower
 * case (Reddit's usernames are case-insensitive).
 */
export function quietNames(raw: unknown): Set<string> {
    return new Set(
        str(raw)
            .split(/[\s,]+/u)
            .map((n) => n.replace(/^\/?u\//i, '').toLowerCase())
            .filter(Boolean),
    );
}

function quietAuthor(author: Item | null, quiet: Set<string>): boolean {
    if (!author) return false;
    const name = str(author.name).toLowerCase();
    return QUIET_AUTHORS.has(name) || (name !== '' && quiet.has(name)) || APP_ACCOUNT.has(author.accountType);
}

/**
 * One notice for a new post or comment, or null when it should not ping (see the README's "What it leaves out").
 * `quiet` is the team's own accounts (the quietUsernames setting): the payload cannot say who is a moderator.
 */
export function toNotice(event: unknown, quiet: Set<string> = new Set()): Notice | null {
    const e = obj(event);
    if (!e) return null;
    const type = str(e.type);
    const isPost = type === 'PostCreate' || type === 'PostSubmit';
    const isComment = type === 'CommentCreate' || type === 'CommentSubmit';
    if (!isPost && !isComment) return null;

    const author = obj(e.author);
    if (quietAuthor(author, quiet)) return null;
    const subName = str(obj(e.subreddit)?.name);
    const sub = SUBREDDIT.test(subName) ? subName : '';
    const where = sub ? `in r/${sub}` : 'on Reddit';
    const subPath = sub ? `/r/${sub}` : '';
    const post = obj(e.post);

    if (isPost) {
        if (!post || isGone(post) || TEAM_DISTINGUISH.has(post.distinguished)) return null;
        const id = baseId(post.id, 't3');
        if (!id) return null;
        const url = fromPermalink(post.permalink) || `${REDDIT}${subPath}/comments/${id}/`;
        return { id: `t3_${id}`, title: `New post ${where}`, body: `${oneLine(post.title) || '(no title)'}\n${url}`, url };
    }

    const comment = obj(e.comment);
    if (!comment || isGone(comment) || (post && isGone(post))) return null;
    const id = baseId(comment.id, 't1');
    const postId = baseId(comment.postId, 't3') || baseId(post?.id, 't3');
    if (!id || !postId) return null;
    const url = fromPermalink(comment.permalink) || `${REDDIT}${subPath}/comments/${postId}/_/${id}/`;
    const on = oneLine(post?.title);
    return { id: `t1_${id}`, title: `New comment ${where}`, body: `${on ? `On: ${on}\n` : ''}${url}`, url };
}
