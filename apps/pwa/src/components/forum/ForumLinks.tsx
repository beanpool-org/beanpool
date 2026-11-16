/**
 * What a forum topic links, on the web (slice F9; scratch/fable-design/DESIGN-forums-fable.md §10.2 to §10.5, §14): the chips
 * under its opening words, the Link sheet (the composer's and the topic's ⋯), and the topics that link one thing, which a
 * listing ("Talked about in the forum"), a group ("Topics about this group") and a Learn page ("From the forum") show.
 *
 * - **A link never shows its reader anything they could not already see.** The node answers each reader with the thing as
 *   their own read of it gives them, else a placeholder holding its kind alone (apps/server engine/forum-links.ts). A chip
 *   draws exactly that answer: a title only where the node sent one (`shown: true`), else "Linked: a group" and nothing to tap.
 *   No title is kept from elsewhere or made up for a placeholder, and the topics that link a thing are whatever the node
 *   answered for it (nothing for a thing the reader may not see).
 * - **"Posted as a Need ›"** is a Need the topic's writer made (Make this a Need, §10.2): `listingType === 'need' && byWriter`.
 * - **What may be linked** (§10.4): one of the writer's groups, their listings, or an event of theirs; at most
 *   FORUM_LIMITS.topicLinks things a topic, the Decision chip counted. The node decides again and says why in its refusal.
 */
import { useEffect, useState, type ReactPortal } from 'react';
import { createPortal } from 'react-dom';
import { FORUM_LIMITS, t, timeAgo, tn, word, wordn, type ForumLink, type ForumLinkKind } from '@beanpool/core';
import { getMarketplacePosts, getMyEvents, getYourGroups } from '../../lib/api';
import { forumLinkedTopics, forumSectionOfGroup, type ForumLinkedTopic, type ForumTopic } from '../../lib/forum';
import { useCoversScreen } from '../../lib/screen-cover';
import type { ComposerDraft } from '../../tools/builder';
import { COMPOSER_DESCRIPTION_CHARS, COMPOSER_TITLE_CHARS } from '../../tools/builder';

export const LINK_WORDS = {
    placeholder: {
        group: word('Linked: a group'),
        listing: word('Linked: a listing'),
        event: word('Linked: an event'),
        learn: word('Linked: a Learn page'),
    } satisfies Record<ForumLinkKind, string>,
    postedAsNeed: word('Posted as a Need ›'),
    link: word('Link'),
    sheet: word('Link to this topic'),
    yourGroups: word('Your groups'),
    yourListings: word('Your listings'),
    yourEvents: word('Your events'),
    nothing: word('Nothing of yours to link yet: a group you are in, a listing or an event.'),
    linkedNow: word('Linked now'),
    takeOff: word('Take off'),
    takeOffNamed: word('Take “{title}” off this topic'),
    full: word('A topic can link at most {n} things. Take one off first.'),
    loading: word('Loading…'),
    failed: word('Couldn’t load what you can link. Check your connection and try again.'),
    done: word('Done'),
    talkedAbout: word('Talked about in the forum'),
    aboutGroup: word('Topics about this group'),
    fromForum: word('From the forum'),
    replies: wordn('{n} reply', '{n} replies'),
    makeNeed: word('Make this a Need'),
    groupTopics: word('Topics'),
    /** A place circle's card and the Find card (§10.5): the "Start a community near you" section, searched for the town. */
    circleTalk: word('Talk about it in the forum ›'),
    findTalk: word('See who is talking about starting one ›'),
};

const ICON: Record<ForumLinkKind, string> = { group: '👥', listing: '🛍️', event: '📅', learn: '📖' };

/** Where a shown link opens, as App's navigateToTab takes it: a listing and an event in the Market, a group's info, a Learn page. */
export function linkDoor(link: ForumLink): [tab: string, id: string] | null {
    if (!link.shown) return null;
    if (link.kind === 'group') return ['group', link.id];
    if (link.kind === 'learn') return ['learn-page', link.id];
    return ['marketplace', link.id];
}

/** How many of a topic's FORUM_LIMITS.topicLinks places are taken: every link the node sent (placeholders too) and the Decision chip. */
export const linksTaken = (topic: Pick<ForumTopic, 'links' | 'decision'>): number => (topic.links?.length ?? 0) + (topic.decision ? 1 : 0);

/**
 * Make this a Need (§10.2): the Market's own Need form, with the topic's title and opening words cut to the form's limits.
 * Nothing is posted until the member taps Post there; the Need it makes is then linked to the topic (`forumTopicId`).
 */
export function needDraftOf(topic: { id: string; title: string }, words: string): ComposerDraft {
    const cut = (s: string, n: number) => Array.from(s.trim()).slice(0, n).join('');
    return {
        type: 'need', title: cut(topic.title, COMPOSER_TITLE_CHARS), description: cut(words, COMPOSER_DESCRIPTION_CHARS),
        category: null, credits: null, priceType: null, repeatable: false, cashAlsoNeeded: false, forumTopicId: topic.id,
    };
}

const chip = 'inline-flex items-center gap-1 max-w-full min-h-[44px] px-3 rounded-full text-sm font-semibold';
const chipStyle = { background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' } as const;

/** The chips under a topic's opening words: each link exactly as the node sent it; a placeholder says its kind and opens nothing. */
export function ForumLinkChips({ links, onOpen }: { links: ForumLink[] | undefined; onOpen?: (link: ForumLink) => void }) {
    if (!links?.length) return null;
    return (
        <ul data-testid="forum-link-chips" className="m-0 p-0 list-none flex flex-wrap gap-2">
            {links.map((link, i) => (
                <li key={link.shown ? `${link.kind}:${link.id}` : `${link.kind}:hidden:${i}`} className="max-w-full min-w-0">
                    {link.shown ? (
                        <button type="button" onClick={() => onOpen?.(link)} data-testid={`forum-link-${link.kind}`} className={chip} style={chipStyle}>
                            <span aria-hidden="true">{ICON[link.kind]}</span>
                            {link.listingType === 'need' && link.byWriter
                                ? <span className="min-w-0" style={{ overflowWrap: 'anywhere' }}>{t(LINK_WORDS.postedAsNeed)}</span>
                                : <><span className="min-w-0 truncate">{link.title}</span><span aria-hidden="true">›</span></>}
                        </button>
                    ) : (
                        <span data-testid={`forum-link-${link.kind}-placeholder`} className={chip} style={{ ...chipStyle, color: 'var(--text-secondary)' }}>
                            <span style={{ overflowWrap: 'anywhere' }}>{t(LINK_WORDS.placeholder[link.kind])}</span>
                        </span>
                    )}
                </li>
            ))}
        </ul>
    );
}

/** Something the member could link, as the Link sheet lists it. */
export interface LinkPick { kind: ForumLinkKind; id: string; title: string }

/** The member's own groups (active ones: the node takes no other), listings and events: what §10.4 lets them link. */
async function linkablesOf(me: string): Promise<{ groups: LinkPick[]; listings: LinkPick[]; events: LinkPick[] }> {
    const [groups, listings, events] = await Promise.all([
        // The node lists only active memberships; a closed group reads as nobody's, so it is not offered.
        getYourGroups().then((r) => (r.items ?? []).filter((g) => g.kind === 'group' && !g.readOnly)),
        getMarketplacePosts({ author: me, limit: 50 }),
        getMyEvents(),
    ]);
    return {
        groups: groups.map((g) => ({ kind: 'group', id: g.id, title: g.name })),
        listings: listings.filter((p) => (p.type === 'offer' || p.type === 'need') && p.authorPublicKey === me).map((p) => ({ kind: 'listing', id: p.id, title: p.title })),
        events: events.map((e) => ({ kind: 'event', id: e.postId, title: e.title })),
    };
}

/**
 * The Link sheet: what is linked now (each shown link with Take off, where `onTakeOff` is given: the writer, an owner or an
 * admin), then, where `onPick` is given (the topic's writer), their groups, listings and events, while the topic has room.
 * `room`: places left of FORUM_LIMITS.topicLinks.
 */
export function ForumLinkSheet({ me, linked, room, onPick, onTakeOff, onClose }: {
    me: string; linked: LinkPick[]; room: number; onPick?: (pick: LinkPick) => Promise<void>; onTakeOff?: (pick: LinkPick) => Promise<void>; onClose: () => void;
}): ReactPortal {
    useCoversScreen(true);
    const [lists, setLists] = useState<Awaited<ReturnType<typeof linkablesOf>> | null>(null);
    const [failed, setFailed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        if (!onPick) return;
        let live = true;
        linkablesOf(me).then((l) => { if (live) setLists(l); }).catch(() => { if (live) setFailed(true); });
        return () => { live = false; };
    }, [me]);
    const isLinked = (p: LinkPick) => linked.some((l) => l.kind === p.kind && l.id === p.id);

    async function act(fn: () => Promise<void>) {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            await fn();
        } catch (e) {
            setError((e as Error)?.message || t('Couldn’t save this in the forum.'));
        }
        setBusy(false);
    }

    const row = 'w-full min-h-[48px] px-3 rounded-lg text-left font-semibold flex items-center gap-2 disabled:opacity-50';
    const heading = 'm-0 mt-2 px-3 text-xs font-bold uppercase tracking-wide';
    function group(title: string, picks: LinkPick[]) {
        if (!picks.length) return null;
        return (
            <>
                <h3 className={heading} style={{ color: 'var(--text-secondary)' }}>{title}</h3>
                {picks.map((p) => (
                    <button key={`${p.kind}:${p.id}`} type="button" disabled={busy || isLinked(p)} onClick={() => void act(() => onPick!(p))}
                        data-testid={`forum-link-pick-${p.kind}`} className={row} style={{ color: 'var(--text-primary)' }}>
                        <span aria-hidden="true">{isLinked(p) ? '✓' : ICON[p.kind]}</span>
                        <span className="min-w-0 flex-1" style={{ overflowWrap: 'anywhere' }}>{p.title}</span>
                    </button>
                ))}
            </>
        );
    }
    const empty = lists && !lists.groups.length && !lists.listings.length && !lists.events.length;

    return createPortal(
        <div role="dialog" aria-modal="true" aria-label={t(LINK_WORDS.sheet)} data-testid="forum-link-sheet"
            className="fixed inset-0 z-[130] flex items-end sm:items-center justify-center p-4 bg-black/60" onClick={onClose}>
            {/* A block, not a flex column: in a column with a height cap, a row whose min-height is set shrinks to it and its
                words spill over the next row (the 320 px shots, 16 Nov). */}
            <div className="w-full max-w-sm max-h-[85vh] overflow-y-auto rounded-2xl p-2" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }} onClick={(e) => e.stopPropagation()}>
                <h2 className="m-0 px-3 py-2 text-base font-bold" style={{ color: 'var(--text-primary)' }}>{t(LINK_WORDS.sheet)}</h2>
                {linked.length > 0 && (
                    <>
                        <h3 className={heading} style={{ color: 'var(--text-secondary)' }}>{t(LINK_WORDS.linkedNow)}</h3>
                        {linked.map((p) => (
                            // Take off goes under the title where both don't fit (320 px at 1.3x): the title keeps whole words.
                            <div key={`${p.kind}:${p.id}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1 min-h-[48px]">
                                <span aria-hidden="true">{ICON[p.kind]}</span>
                                <span className="min-w-[8rem] flex-1 text-sm break-words" style={{ color: 'var(--text-primary)' }}>{p.title}</span>
                                {onTakeOff && (
                                    <button type="button" disabled={busy} onClick={() => void act(() => onTakeOff(p))} aria-label={t(LINK_WORDS.takeOffNamed, { title: p.title })}
                                        data-testid="forum-link-take-off" className="min-h-[44px] px-3 rounded-lg text-sm font-semibold shrink-0 disabled:opacity-50"
                                        style={{ color: 'var(--bp-ink-danger)', border: '1px solid var(--border-primary)' }}>{t(LINK_WORDS.takeOff)}</button>
                                )}
                            </div>
                        ))}
                    </>
                )}
                {onPick && room <= 0 && <p data-testid="forum-link-full" className="m-0 px-3 py-2 text-sm" style={{ color: 'var(--text-secondary)' }}>{t(LINK_WORDS.full, { n: FORUM_LIMITS.topicLinks })}</p>}
                {onPick && room > 0 && (
                    failed ? <p className="m-0 px-3 py-2 text-sm" style={{ color: 'var(--text-secondary)' }}>{t(LINK_WORDS.failed)}</p>
                        : !lists ? <p className="m-0 px-3 py-2 text-sm" style={{ color: 'var(--text-secondary)' }}>{t(LINK_WORDS.loading)}</p>
                        : empty ? <p className="m-0 px-3 py-2 text-sm" style={{ color: 'var(--text-secondary)' }}>{t(LINK_WORDS.nothing)}</p>
                        : <>{group(t(LINK_WORDS.yourGroups), lists.groups)}{group(t(LINK_WORDS.yourListings), lists.listings)}{group(t(LINK_WORDS.yourEvents), lists.events)}</>
                )}
                {error && <p role="alert" className="m-0 px-3 py-2 text-sm" style={{ color: 'var(--bp-ink-danger)', overflowWrap: 'anywhere' }}>{error}</p>}
                <button type="button" onClick={onClose} className="w-full mt-1 min-h-[48px] px-4 rounded-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{t(LINK_WORDS.done)}</button>
            </div>
        </div>,
        document.body,
    );
}

/**
 * The topics this member may read that link one thing, under `heading` ("Talked about in the forum", "Topics about this
 * group", "From the forum"), each opening its topic on a tap anywhere. Nothing at all while there is none, the node says
 * nothing, or the read fails: the node answers [] for a thing the member may not see, so the row never hints at it.
 */
export function ForumLinkedTopics({ kind, id, heading, onOpenTopic }: {
    kind: ForumLinkKind; id: string; heading: string; onOpenTopic: (topicId: string) => void;
}) {
    const [topics, setTopics] = useState<ForumLinkedTopic[]>([]);
    useEffect(() => {
        let live = true;
        setTopics([]);
        forumLinkedTopics(kind, id).then((list) => { if (live) setTopics(list); }).catch(() => { /* nothing to show */ });
        return () => { live = false; };
    }, [kind, id]);
    if (!topics.length) return null;
    return (
        <section data-testid={`forum-linked-${kind}`} className="flex flex-col gap-1 min-w-0">
            <h3 className="m-0 text-sm font-bold" style={{ color: 'var(--text-secondary)' }}>{heading}</h3>
            <ul className="m-0 p-0 list-none flex flex-col gap-1">
                {topics.map((topic) => {
                    // Each a whole sentence of its own, as the forum's list rows draw them.
                    const replies = tn(topic.replyCount, LINK_WORDS.replies.one, LINK_WORDS.replies.other, { n: topic.replyCount });
                    const when = timeAgo(Math.max(0, Date.now() - Date.parse(topic.lastActivityAt)));
                    return (
                        <li key={topic.id}>
                            <button type="button" onClick={() => onOpenTopic(topic.id)} data-testid="forum-linked-topic"
                                className="w-full min-h-[48px] px-3 py-2 rounded-lg text-left flex items-center gap-2" style={chipStyle}>
                                <span className="flex-1 min-w-0 flex flex-col">
                                    <span className="font-semibold text-sm" style={{ overflowWrap: 'anywhere' }}>{topic.title}</span>
                                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{replies} · {when}</span>
                                </span>
                                <span aria-hidden="true">›</span>
                            </button>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}

/**
 * A group's sheet (§10.4): "Topics about this group" (the topics that link it), and, for a group with its own section (slice
 * F8), a Topics row that opens the forum on it. The node answers that section only to the group's members and the moderators.
 */
export function GroupForumRows({ groupId, onNavigate }: { groupId: string; onNavigate: (tab: string, contextId?: string) => void }) {
    const [section, setSection] = useState<string | null>(null);
    useEffect(() => {
        let live = true;
        setSection(null);
        forumSectionOfGroup(groupId).then((id) => { if (live) setSection(id); }).catch(() => { /* no row */ });
        return () => { live = false; };
    }, [groupId]);
    return (
        <>
            {section && (
                <button type="button" onClick={() => onNavigate('forum-section', section)} data-testid="group-forum-topics"
                    className="w-full min-h-[48px] px-4 rounded-xl text-left font-bold text-sm flex items-center gap-2" style={chipStyle}>
                    <span aria-hidden="true">🗨️</span><span className="flex-1 min-w-0" style={{ overflowWrap: 'anywhere' }}>{t(LINK_WORDS.groupTopics)}</span><span aria-hidden="true">›</span>
                </button>
            )}
            <ForumLinkedTopics kind="group" id={groupId} heading={t(LINK_WORDS.aboutGroup)} onOpenTopic={(id) => onNavigate('forum-topic', id)} />
        </>
    );
}
