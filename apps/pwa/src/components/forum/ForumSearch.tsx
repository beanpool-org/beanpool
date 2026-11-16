/**
 * The forum's search box on the web (slice F6; DESIGN-forums-fable.md §8, §14 "🔍"), at the top of the Forum's list
 * (pages/ForumPage.tsx). The node finds every word typed in titles, opening posts and replies, newest first, and never a
 * post the member may not read (apps/server/src/engine/forum-search.ts).
 *
 * - **Asked on Search, never as they type:** each search is one of the member's 100 a day. 🔍 always looks like the
 *   live button it is (walk 2, 15 Nov: faded while the box was empty, it read as off): with nothing typed, it puts the
 *   cursor in the box and asks nothing.
 * - **The hits** replace the topic list while they show: the topic's title, who wrote the post, its section, when, and its
 *   words around the find. A tap anywhere on a hit opens the topic at that post (the small-cards rule). ✕ clears the search
 *   and the list is back.
 * - **Kept for the page's life** (lib/forum.ts keptSearch): back from a hit, the same hits show without asking again.
 * - **A door's search** (slice F9, `searchFor`) is asked once: the box tells the page it took it (`onSearchTaken`), and the page
 *   lets go of it, so coming back to the list draws the kept hits (or the member's own later search, or their ✕) and asks
 *   nothing. It is kept to the door's section, its later pages too.
 */
import { useEffect, useRef, useState } from 'react';
import { forumSectionName, t, timeAgo, word } from '@beanpool/core';
import { forgetForumSearch, keptSearch, searchForum, type ForumSearchAnswer, type ForumSearchHit, type ForumSection } from '../../lib/forum';
import { TOPIC_WORDS } from './ForumTopicView';

/** A door's search (slice F9): its words, in its one section. */
export interface ForumSearchDoor { q: string; section: string }

export const SEARCH_WORDS = {
    box: word('Search the forum'),
    search: word('Search'),
    clear: word('Clear the search'),
    none: word('Nothing in the forum has every word of “{q}”.'),
    more: word('Show more results'),
    failed: word('Couldn’t search the forum. Check your connection and try again.'),
};

/**
 * `onOpen`: a hit was tapped; open topic `topicId` at post `number`. `onShowing`: whether hits (or "nothing found") replace
 * the topic list now. `searchFor`: words a door asked for in one section (slice F9, "See who is talking about starting one ›"),
 * searched once when it comes: the member's own tap, so one of their searches. `onSearchTaken`: it was taken; the page clears it.
 */
export function ForumSearch({ sections, searchFor = null, onSearchTaken, onOpen, onShowing }: {
    sections: ForumSection[]; searchFor?: ForumSearchDoor | null; onSearchTaken?: () => void;
    onOpen: (topicId: string, number: number) => void; onShowing: (showing: boolean) => void;
}) {
    const [answer, setAnswer] = useState<ForumSearchAnswer | null>(() => keptSearch());
    const [typed, setTyped] = useState(() => keptSearch()?.q ?? '');
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState<string | null>(null);
    const box = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!searchFor) return;
        // Taken before it is asked: the page lets go of it now, so no later mount of this box asks it again.
        onSearchTaken?.();
        setTyped(searchFor.q);
        void ask(0, searchFor);
    }, [searchFor]);

    async function ask(offset = 0, door?: ForumSearchDoor) {
        const q = door ? door.q.trim() : offset ? answer?.q ?? '' : typed.trim();
        // A later page stays where its first page was asked; the member's own search is the whole forum's (slice F6).
        const section = door ? door.section : offset ? answer?.section ?? null : null;
        if (!q && !offset) box.current?.focus();
        if (!q || busy) return;
        setBusy(true);
        setFailed(null);
        try {
            const out = await searchForum(q, offset, section);
            setAnswer(out);
            onShowing(true);
        } catch (e) {
            setFailed((e as Error)?.message || t(SEARCH_WORDS.failed));
        } finally {
            setBusy(false);
        }
    }
    function clear() {
        forgetForumSearch();
        setAnswer(null);
        setTyped('');
        setFailed(null);
        onShowing(false);
    }
    const nameOf = (id: string) => {
        const s = sections.find((x) => x.id === id);
        return s ? forumSectionName(s) : '';
    };
    const button = 'min-h-[44px] min-w-[44px] px-3 rounded-lg font-semibold shrink-0';
    const quiet = { background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' } as const;

    return (
        <div className="flex flex-col gap-2" data-testid="forum-search">
            <form role="search" className="flex items-center gap-2 min-w-0" onSubmit={(e) => { e.preventDefault(); void ask(0); }}>
                <input ref={box} type="search" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label={t(SEARCH_WORDS.box)} placeholder={t(SEARCH_WORDS.box)}
                    maxLength={200} enterKeyHint="search" data-testid="forum-search-box"
                    className="flex-1 min-w-0 min-h-[44px] rounded-lg px-3 text-[0.95rem]"
                    style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-input)' }} />
                <button type="submit" disabled={busy} aria-label={t(SEARCH_WORDS.search)} data-testid="forum-search-go"
                    className={`${button} disabled:opacity-50`} style={quiet}><span aria-hidden="true">🔍</span></button>
                {answer && (
                    <button type="button" onClick={clear} aria-label={t(SEARCH_WORDS.clear)} data-testid="forum-search-clear" className={button} style={quiet}>
                        <span aria-hidden="true">✕</span>
                    </button>
                )}
            </form>
            {failed && <p role="alert" className="m-0 text-sm" style={{ color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{failed}</p>}
            {answer && answer.hits.length === 0 && (
                <p className="m-0 text-sm" data-testid="forum-search-none" style={{ color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{t(SEARCH_WORDS.none, { q: answer.q })}</p>
            )}
            {answer && answer.hits.length > 0 && (
                <ul className="m-0 p-0 list-none flex flex-col" data-testid="forum-search-hits">
                    {answer.hits.map((hit) => <HitRow key={hit.postId} hit={hit} sectionName={nameOf(hit.sectionId)} onOpen={() => onOpen(hit.topicId, hit.number)} />)}
                </ul>
            )}
            {answer?.next != null && (
                <button type="button" onClick={() => void ask(answer.next!)} disabled={busy} className="min-h-[44px] px-4 rounded-lg font-semibold disabled:opacity-50" style={quiet}>
                    {t(SEARCH_WORDS.more)}
                </button>
            )}
        </div>
    );
}

/** One hit: a tap anywhere opens its topic at the post. */
function HitRow({ hit, sectionName, onOpen }: { hit: ForumSearchHit; sectionName: string; onOpen: () => void }) {
    const when = timeAgo(Math.max(0, Date.now() - Date.parse(hit.createdAt)));
    return (
        <li style={{ borderTop: '1px solid var(--border-primary)' }}>
            <button type="button" onClick={onOpen} data-testid="forum-search-hit" className="w-full min-h-[56px] py-2 text-left flex flex-col gap-0.5">
                <span className="font-bold text-[0.95rem] leading-snug" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
                    {hit.title || t(TOPIC_WORDS.removedTopic)}
                </span>
                <span className="text-xs" style={{ color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>
                    {[hit.writer.name || t('A member'), sectionName, when].filter(Boolean).join(' · ')}
                </span>
                {hit.excerpt && <span className="text-sm" style={{ color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{hit.excerpt}</span>}
            </button>
        </li>
    );
}
