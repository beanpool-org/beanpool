/**
 * The visitor Home card "From the forum" on the web (slice F7, the apps' part; core forum-visitors.ts): on the global
 * community's lobby, beside "Near you" and "What people post". Read by the page itself from the node's public answer.
 *
 * - **The three newest public topics:** title, the opening post's first line, the section. A tap anywhere opens the topic
 *   read only in the lobby's Forum tab; "Open the forum ›" opens its list.
 * - **Never an empty card:** while the forum has no public topic, or no answer came, the members' guide's "How BeanPool
 *   works" (bundled with the app), which opens over the lobby. Never "nothing here" for an answer that did not come.
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
    FORUM_HOME_WORDS, FORUM_VISITOR_GUIDE_PAGE, findGuidePage, firstLineOf, forumSectionName, newestPublicTopics, t, visitorForumShows,
    type ForumPublicAnswer, type ForumPublicSection, type ForumPublicTopic,
} from '@beanpool/core';
import { getPublicForum, getPublicTopic } from '../../lib/forum-public';
import { inShownLanguage, loadBundledGuide } from '../../lib/guide';

export interface VisitorForumRow { topic: ForumPublicTopic; line: string; section: string }

/** The card's rows: the three newest topics, each with its opening's first line (none if that read fails) and section. */
export async function readVisitorForumRows(): Promise<{ answer: ForumPublicAnswer; rows: VisitorForumRow[] }> {
    try {
        const front = await getPublicForum();
        const sections: ForumPublicSection[] = front.sections ?? [];
        const newest = newestPublicTopics(front.topics ?? []);
        if (newest.length === 0) return { answer: 'none', rows: [] };
        const rows = await Promise.all(newest.map(async (topic) => {
            const opening = await getPublicTopic(topic.id).then((p) => p.posts.find((x) => x.number === 1) ?? null, () => null);
            const s = sections.find((x) => x.id === topic.sectionId);
            return { topic, line: opening ? firstLineOf(opening.words) : '', section: s ? forumSectionName(s) : '' };
        }));
        return { answer: 'topics', rows };
    } catch {
        return { answer: 'unreachable', rows: [] };
    }
}

export function ForumVisitorHome({ features, onNavigate, frame }: {
    features: object;
    onNavigate: (to: string, contextId?: string) => void;
    /** Home's card frame around the body; never called with nothing in it. */
    frame: (body: ReactNode) => ReactNode;
}) {
    const [read, setRead] = useState<{ answer: ForumPublicAnswer; rows: VisitorForumRow[] } | null>(null);
    const [guide, setGuide] = useState<{ slug: string; title: string; summary: string } | null>(null);
    useEffect(() => {
        let live = true;
        void readVisitorForumRows().then((r) => { if (live) setRead(r); });
        void loadBundledGuide().then((g) => {
            const page = findGuidePage(inShownLanguage(g), FORUM_VISITOR_GUIDE_PAGE);
            if (live && page) setGuide({ slug: page.slug, title: page.title, summary: page.summary ?? '' });
        }).catch(() => {});
        return () => { live = false; };
    }, []);
    // Until the forum answers, the guide's page holds the card's place (never an empty box), as it does for no answer.
    const shows = visitorForumShows('visitor', features, read?.answer ?? 'unreachable').card;
    const line = 'block text-xs text-nature-600 dark:text-nature-300 break-words';
    const row = 'w-full min-h-[48px] py-2 text-left flex flex-col gap-0.5 bg-transparent border-0 cursor-pointer';
    if (shows === 'topics' && read) {
        return frame(
            <div data-testid="home-forum-visitor" className="flex flex-col">
                {read.rows.map(({ topic, line: first, section }) => (
                    <button key={topic.id} type="button" onClick={() => onNavigate('forum', topic.id)} data-testid="home-forum-visitor-topic"
                        className={row} style={{ borderTop: '1px solid var(--border-primary)' }}>
                        <span dir="auto" className="block break-words font-semibold text-nature-950 dark:text-white">{topic.title}</span>
                        {first && <span dir="auto" className={line}>{first}</span>}
                        {section && <span className={line}>{section}</span>}
                    </button>
                ))}
                <button type="button" onClick={() => onNavigate('forum')} data-testid="home-forum-visitor-open"
                    className="self-end min-h-[44px] px-2 bg-transparent border-0 text-sm font-bold underline cursor-pointer text-nature-700 dark:text-nature-200">
                    {t(FORUM_HOME_WORDS.open)}<span aria-hidden="true"> ›</span>
                </button>
            </div>,
        );
    }
    if (shows !== 'guide' || !guide) return null;
    return frame(
        <button type="button" onClick={() => onNavigate('guide', guide.slug)} data-testid="home-forum-visitor-guide" className={row}>
            <span className="block break-words font-semibold text-nature-950 dark:text-white">{guide.title}</span>
            {guide.summary && <span className={line}>{guide.summary}</span>}
        </button>,
    );
}
