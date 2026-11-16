/**
 * What a forum topic links (slice F9; scratch/fable-design/DESIGN-forums-fable.md §10.2 to §10.4): one of its writer's groups,
 * one of their listings (a Need made with "Make this a Need" is one), an event, or a Learn page, kept in forum_links beside
 * the Decision chip (slice F8), at most FORUM_LIMITS.topicLinks rows a topic in all.
 *
 * **A link never shows its reader anything they could not already see.** Each reader is answered with what their own read
 * of the thing gives them, by the very read the apps make for it, never a rule of the forum's own:
 *   - a listing or an event: the Market's read by id for that reader (@beanpool/engine getPosts: its audience, a group's
 *     post to the group alone, a direct one to its two people, a hidden or removed one to nobody but its author, a taken-down
 *     one to nobody), and nothing by someone the reader blocked (the forum's own rule for people's words, §4);
 *   - a Learn page: one that shows (engine/knowledge.ts showingKnowledgeRow), where Learn is on, read as the Market reads it;
 *   - a group: its card as the reader may open it (engine/group-thread.ts visibleGroup: an invite-only group only to someone
 *     in it, invited or asking), and nothing of a group closed by its Decision.
 * Anything else is a placeholder holding its kind alone: no id, no title, no photo. The public pages carry no links
 * (@beanpool/core FORUM_PUBLIC_FIELDS).
 */
import { getPosts, type MarketplacePost } from '@beanpool/engine';
import type { ForumLink, ForumLinkKind } from '@beanpool/core';
import { db } from '../db/db.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { visibleGroup } from './group-thread.js';
import { showingKnowledgeRow } from './knowledge.js';
import { readOfCopy } from './event-copy.js';

/** One thing a link names, as `reader` may see it: its title, its maker, and what its chip draws; null when they may not. */
export interface ForumLinkTarget { id: string; title: string; maker: string; photo: string | null; listingType: 'offer' | 'need' | null; startAt: string | null }

const blocked = (reader: string, maker: string) =>
    !!db.prepare('SELECT 1 FROM member_blocks WHERE owner_pubkey = ? AND blocked_pubkey = ?').get(reader, maker);

/**
 * The Market's read of one post by id, as `reader` would make it in their own app (state-engine getPosts: the engine's read,
 * then readOfCopy, so a listing copied from another community reads as the reader's own read of it does, its author's name
 * and key only to its author), of the kind the link says; or null.
 */
function postSeenBy(reader: string, kind: 'listing' | 'event' | 'learn', id: string): MarketplacePost | null {
    if (kind === 'learn' && (!getProfileSwitches().knowledge || !showingKnowledgeRow(id))) return null;
    const post = getPosts(db, { id, viewerPubkey: reader, ...(kind === 'learn' ? { type: 'knowledge', withKnowledge: true } : {}) })
        .find((p) => p.id === id);
    if (!post) return null;
    const fits = kind === 'listing' ? post.type === 'offer' || post.type === 'need' : kind === 'event' ? post.type === 'event' : post.type === 'knowledge';
    if (!fits || blocked(reader, post.authorPublicKey)) return null;
    return readOfCopy(post, reader);
}

/** A group's card as `reader` may open it, not closed by its Decision; or null (an id nobody has reads the same). */
function groupSeenBy(reader: string, id: string): { id: string; name: string; created_by: string } | null {
    if (!visibleGroup(id, reader, { byIdOnly: true })) return null;
    if (db.prepare('SELECT 1 FROM group_closures WHERE group_id = ?').get(id)) return null;
    return (db.prepare('SELECT id, name, created_by FROM groups WHERE id = ?').get(id) as { id: string; name: string; created_by: string } | undefined) ?? null;
}

/** The thing a link names, as `reader` may see it, or null. */
export function forumLinkTarget(reader: string, kind: ForumLinkKind, id: string): ForumLinkTarget | null {
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null;
    if (kind === 'group') {
        const g = groupSeenBy(reader, id);
        return g ? { id: g.id, title: g.name, maker: g.created_by, photo: null, listingType: null, startAt: null } : null;
    }
    const p = postSeenBy(reader, kind, id);
    if (!p) return null;
    return {
        id: p.id, title: p.title, maker: p.authorPublicKey, photo: p.photos?.[0] ?? null,
        listingType: p.type === 'offer' || p.type === 'need' ? p.type : null,
        startAt: p.type === 'event' ? (p.eventStartAt ?? null) : null,
    };
}

/** One link as `reader` reads it: shown with what they may see, or a placeholder with its kind alone. */
export function forumLinkFor(reader: string, kind: ForumLinkKind, id: string, topicWriter: string): ForumLink {
    const t = forumLinkTarget(reader, kind, id);
    if (!t) return { kind, shown: false };
    return { kind, shown: true, id: t.id, title: t.title, photo: t.photo, listingType: t.listingType, startAt: t.startAt, byWriter: t.maker === topicWriter };
}

const F9_KINDS_SQL = "kind IN ('group', 'listing', 'event', 'learn')";

/** A topic's links (not its Decision chip), oldest first, each as `reader` reads it. */
export function forumLinksOf(reader: string, topicId: string, topicWriter: string): ForumLink[] {
    const rows = db.prepare(`SELECT kind, target_id FROM forum_links WHERE topic_id = ? AND ${F9_KINDS_SQL} ORDER BY created_at, kind, target_id`)
        .all(topicId) as { kind: ForumLinkKind; target_id: string }[];
    return rows.map((r) => forumLinkFor(reader, r.kind, r.target_id, topicWriter));
}

/** The topics' ids that link one thing (the reader's sight of the topics is the caller's). */
export const FORUM_LINKING_SQL = `SELECT topic_id FROM forum_links WHERE kind = @kind AND target_id = @target`;

/** The F9 kinds' rows of one topic, as SQL for deletePlainRows: a topic its writer removed takes its links with it. */
export const FORUM_TARGET_LINKS_WHERE = `topic_id = ? AND ${F9_KINDS_SQL}`;
