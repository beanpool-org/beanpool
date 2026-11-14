/**
 * The Home card "Forum" on the phone (slice F3 part 2; DESIGN-forums-fable.md §14 "Home card 'Forum': the three newest topics
 * and 'Open the forum ›'"). Worked out on the phone (core's catalogue says `asks: 'none'`): the forum's own list
 * (utils/forum.ts), its kept copy at once and then the node's, so it reads with no connection too.
 *
 * - **The three newest topics**, newest first, each a small card's row: a tap anywhere opens the topic (the small-cards rule);
 *   a writer's card opens only from inside it. ● where a followed topic has a reply not opened, as in the list.
 * - **Open the forum ›** opens the Chat tab's Forum side.
 * - Nothing kept and no answer: the forum's own line. No topics: the list's line.
 */
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { FORUM_HOME_WORDS, t, timeAgo, tn } from '@beanpool/core';
import type { AppColors } from '../../constants/colors';
import { getForumTopics, keptForumList, type ForumTopic } from '../../utils/forum';
import { FORUM_WORDS, TOPIC_WORDS } from '../forum/forum-words';
import { HomeLink, HomeRow } from './HomeParts';

/** The three newest topics of a list (by when each was started), removed ones left out. */
export function newestForumTopics(topics: readonly ForumTopic[], n = 3): ForumTopic[] {
    return topics.filter((x) => !x.removed).slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, n);
}

export function ForumHomeBody({ colors, now }: { colors: AppColors; now?: number }) {
    const [topics, setTopics] = useState<ForumTopic[] | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let live = true;
        void keptForumList(null).then((kept) => { if (live && kept) setTopics((was) => was ?? kept.topics); });
        void getForumTopics(null, 0)
            .then((list) => { if (live) { setTopics(list.topics); setFailed(false); } })
            .catch(() => { if (live) setFailed(true); });
        return () => { live = false; };
    }, []);
    const at = now ?? Date.now();
    const rows = topics ? newestForumTopics(topics) : [];
    return (
        <>
            {!topics && failed && <Text style={{ fontSize: 14, lineHeight: 20, color: colors.text.secondary }}>{t(FORUM_WORDS.failed)}</Text>}
            {topics && rows.length === 0 && <Text style={{ fontSize: 14, lineHeight: 20, color: colors.text.secondary }}>{t(FORUM_WORDS.none)}</Text>}
            {rows.map((topic) => {
                const replies = tn(topic.replyCount, FORUM_WORDS.replies.one, FORUM_WORDS.replies.other, { n: topic.replyCount });
                const sub = [topic.writer.name || t(TOPIC_WORDS.member), replies, timeAgo(Math.max(0, at - Date.parse(topic.createdAt)))].join(' · ');
                return (
                    <HomeRow
                        key={topic.id}
                        colors={colors}
                        text={topic.title}
                        sub={sub}
                        a11y={`${topic.title}. ${sub}`}
                        onPress={() => router.push({ pathname: '/forum/[id]', params: { id: topic.id } })}
                        right={topic.unread ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent.fill }} accessibilityLabel={t(FORUM_WORDS.unread)} accessibilityRole="image" /> : undefined}
                        testID="home-forum-topic"
                    />
                );
            })}
            <HomeLink id="forum:open" colors={colors} text={t(FORUM_HOME_WORDS.open)} a11y={t(FORUM_HOME_WORDS.open)}
                onPress={() => router.navigate({ pathname: '/(tabs)/chats', params: { view: 'forum' } })} testID="home-forum-open" />
        </>
    );
}
