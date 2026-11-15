/**
 * The visitor Home card "From the forum" on the phone (slice F7, the apps' part; core forum-visitors.ts), as the web lobby's
 * (apps/pwa/src/components/forum/ForumVisitorHome.tsx): on the global community's visitor Home, after the Market card. Read
 * by the phone itself from the node's public answer (utils/forum-public.ts, unsigned), read again with Home (`turn`).
 *
 * - **The three newest public topics:** title, the opening post's first line, the section. A tap anywhere opens the topic read
 *   only (app/forum-public/[id].tsx); "Open the forum ›" opens the visitors' Forum tab.
 * - **Never an empty card:** while the forum has no public topic, or no answer came, the members' guide's "How BeanPool works"
 *   (bundled in the app). The frame is drawn only around something (`frame`).
 */
import React, { useEffect, useState } from 'react';
import { router } from 'expo-router';
import {
    FORUM_HOME_WORDS, FORUM_VISITOR_GUIDE_PAGE, findGuidePage, firstLineOf, forumSectionName, newestPublicTopics, visitorForumShows, t,
    type ForumPublicAnswer, type ForumPublicTopic,
} from '@beanpool/core';
import type { AppColors } from '../../constants/colors';
import { getPublicForum, getPublicTopic } from '../../utils/forum-public';
import { useGuide } from '../../utils/use-guide';
import { HomeLink, HomeRow } from './HomeParts';

export interface VisitorForumRow { topic: ForumPublicTopic; line: string; section: string }

/** The card's rows: the three newest topics, each with its opening's first line (none if that read fails) and section. */
export async function readVisitorForumRows(): Promise<{ answer: ForumPublicAnswer; rows: VisitorForumRow[] }> {
    try {
        const front = await getPublicForum();
        const newest = newestPublicTopics(front.topics ?? []);
        if (newest.length === 0) return { answer: 'none', rows: [] };
        const rows = await Promise.all(newest.map(async (topic) => {
            const opening = await getPublicTopic(topic.id).then((p) => p.posts.find((x) => x.number === 1) ?? null, () => null);
            const s = front.sections?.find((x) => x.id === topic.sectionId);
            return { topic, line: opening ? firstLineOf(opening.words) : '', section: s ? forumSectionName(s) : '' };
        }));
        return { answer: 'topics', rows };
    } catch {
        return { answer: 'unreachable', rows: [] };
    }
}

export function ForumVisitorHomeBody({ colors, features, turn, frame }: {
    colors: AppColors;
    features: object;
    turn?: number;
    /** Home's card frame around the body; never called with nothing in it. */
    frame: (body: React.ReactNode) => React.ReactElement;
}) {
    const [read, setRead] = useState<{ answer: ForumPublicAnswer; rows: VisitorForumRow[] } | null>(null);
    const { guide } = useGuide();
    useEffect(() => {
        let live = true;
        // A read again that gets no answer keeps what is drawn.
        void readVisitorForumRows().then((r) => { if (live) setRead((was) => (r.answer === 'unreachable' && was ? was : r)); });
        return () => { live = false; };
    }, [turn]);
    // Until the forum answers, the guide's page holds the card's place (never an empty box), as it does for no answer.
    const shows = visitorForumShows('visitor', features, read?.answer ?? 'unreachable').card;
    if (shows === 'topics' && read) {
        return frame(
            <>
                {read.rows.map(({ topic, line, section }) => {
                    const sub = [line, section].filter(Boolean).join('\n');
                    return (
                        <HomeRow key={topic.id} colors={colors} text={topic.title} sub={sub || undefined} a11y={[topic.title, line, section].filter(Boolean).join('. ')}
                            onPress={() => router.push({ pathname: '/forum-public/[id]', params: { id: topic.id } })} testID="home-forum-visitor-topic" />
                    );
                })}
                <HomeLink id="forum:visitor-open" colors={colors} text={t(FORUM_HOME_WORDS.open)} a11y={t(FORUM_HOME_WORDS.open)}
                    onPress={() => router.navigate('/(tabs)/forum')} testID="home-forum-visitor-open" />
            </>,
        );
    }
    const page = shows === 'guide' ? findGuidePage(guide, FORUM_VISITOR_GUIDE_PAGE) : null;
    if (!page) return null;
    return frame(
        <HomeRow colors={colors} text={page.title} sub={page.summary || undefined} a11y={[page.title, page.summary].filter(Boolean).join('. ')}
            onPress={() => router.push({ pathname: '/guide/[slug]', params: { slug: page.slug } })} testID="home-forum-visitor-guide" />,
    );
}
