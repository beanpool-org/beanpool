/**
 * The Chat tab's Forum side on the phone (slice F3; DESIGN-forums-fable.md §2 to §6, §14, §18, and
 * DESIGN-forums-messaging-joint-fable.md §2.1), drawn under T0's Chats · Forum switch (app/(tabs)/chats.tsx) where this
 * community's forum is on. In the web's order and words (apps/pwa/src/pages/ForumPage.tsx):
 *
 * - **The list:** the section to show (All sections, or one), ＋ New topic, then for moderators "Waiting for a first look (n) ›",
 *   for a new member their own first topic while it waits (with the measured wait, and Withdraw it), then the topics: pinned
 *   first, then the newest activity, each row opening its topic on a tap anywhere (a person's card opens only from inside the
 *   topic), ● where a followed topic has a reply they haven't opened.
 * - **A topic, a new topic, the first looks** are their own screens (app/forum/), each with ‹ back to this list.
 * - **Kept copies:** what was last read draws at once from this phone's copy (utils/forum-kept.ts), then the node is asked
 *   again; with no connection the copy is what shows, with the node's words and Try again.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { forumSectionName, t, timeAgo, tn } from '@beanpool/core';
import {
    getForumFront, getForumTopics, keptForumFront, keptForumList, myFirstLook, takeForumBack, withdrawFirstLook,
    type ForumFront, type ForumList, type ForumTopic, type ForumWaiting,
} from '../../utils/forum';
import { FORUM_WORDS, TOPIC_WORDS } from './forum-words';
import { useForumStyles, type ForumStyles } from './ForumBits';

export function ForumPane() {
    const styles = useForumStyles();
    const [front, setFront] = useState<ForumFront | null>(null);
    const [section, setSection] = useState<string | null>(null);
    const [list, setList] = useState<ForumList | null>(null);
    const [failed, setFailed] = useState<string | null>(null);
    const [mine, setMine] = useState<{ waiting: ForumWaiting | null; usuallyWithinHours: number | null } | null>(null);
    const [back, setBack] = useState<ReturnType<typeof takeForumBack>>(null);
    // The section picked now: a slower answer for one picked before it is dropped, never drawn under the newer pick.
    const picked = useRef(section);
    useEffect(() => { picked.current = section; }, [section]);

    const loadFront = useCallback(async () => {
        try {
            const f = await getForumFront();
            setFront(f);
            setFailed(null);
            if (f.firstTopicWaits) void myFirstLook().then(setMine).catch(() => {});
            else setMine(null);
        } catch (e) {
            setFailed((e as Error)?.message || t(FORUM_WORDS.failed));
        }
    }, []);
    const loadList = useCallback(async (asked: string | null, offset = 0) => {
        try {
            const answer = await getForumTopics(asked, offset);
            if (picked.current === asked) setList(answer);
        } catch (e) {
            if (picked.current === asked) setFailed((e as Error)?.message || t(FORUM_WORDS.failed));
        }
    }, []);

    // The kept copies first, then the node: each time the tab comes back (a reply, a first look's answer or another member's
    // topic may have come meanwhile), and each pick of a section.
    useFocusEffect(useCallback(() => {
        setBack(takeForumBack());
        void keptForumFront().then((f) => { if (f) setFront((now) => now ?? f); });
        void loadFront();
    }, [loadFront]));
    useFocusEffect(useCallback(() => {
        const asked = section;
        void keptForumList(asked).then((kept) => { if (kept && picked.current === asked) setList((now) => now ?? kept); });
        void loadList(asked, 0);
    }, [section, loadList]));
    const pick = (id: string | null) => { setList(null); setSection(id); };

    const sections = front?.sections ?? [];
    const nameOf = (id: string) => {
        const s = sections.find((x) => x.id === id);
        return s ? forumSectionName(s) : '';
    };
    const waiting = mine?.waiting ?? null;

    return (
        <ScrollView testID="forum-pane" style={{ flex: 1 }} contentContainerStyle={[styles.pad, { paddingTop: 8, paddingBottom: 100 }]} keyboardShouldPersistTaps="handled">
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} accessibilityLabel={t(FORUM_WORDS.pickSection)} testID="forum-section-pick">
                {[null, ...sections.map((s) => s.id)].map((id) => {
                    const s = id ? sections.find((x) => x.id === id) : null;
                    const on = section === id;
                    const words = !id ? t(FORUM_WORDS.allSections) : s?.archived ? t(FORUM_WORDS.archived, { name: forumSectionName(s) }) : forumSectionName(s!);
                    return (
                        <Pressable key={id ?? ''} onPress={() => pick(id)} accessibilityRole="button" accessibilityState={{ selected: on }} style={[styles.chip, on && styles.chipOn]}>
                            <Text style={on ? styles.chipTextOn : styles.chipText}>{words}</Text>
                        </Pressable>
                    );
                })}
            </ScrollView>
            {front && (
                <Pressable testID="forum-new" accessibilityRole="button" disabled={!!waiting && front.firstTopicWaits}
                    onPress={() => router.push({ pathname: '/forum/new', params: { section: section ?? '', hours: String(mine?.usuallyWithinHours ?? '') } })}
                    style={[styles.commit, !!waiting && front.firstTopicWaits && { opacity: 0.5 }]}>
                    <Text style={styles.commitText}>{t(FORUM_WORDS.newTopic)}</Text>
                </Pressable>
            )}

            {failed && (
                <View style={{ gap: 8, alignItems: 'flex-start' }}>
                    <Text style={styles.small} accessibilityRole="alert">{failed}</Text>
                    <Pressable accessibilityRole="button" onPress={() => { void loadFront(); void loadList(section, 0); }} style={styles.quiet}>
                        <Text style={styles.quietText}>{t(FORUM_WORDS.again)}</Text>
                    </Pressable>
                </View>
            )}

            {front?.moderator && (front.firstLooksWaiting ?? 0) > 0 && (
                <Pressable testID="forum-first-looks-row" accessibilityRole="button" onPress={() => router.push('/forum/first-looks')} style={styles.warnRow}>
                    <Text style={styles.warnText}>{t(FORUM_WORDS.firstLooks, { n: front.firstLooksWaiting! })}</Text>
                </Pressable>
            )}

            {back?.kind === 'gone' && <Text style={styles.small} accessibilityRole="alert" testID="forum-gone">{back.words}</Text>}
            {back?.kind === 'sent' && !waiting && <Text style={styles.small}>{t(FORUM_WORDS.sentForLook)}</Text>}
            {waiting && (
                <View style={styles.infoBox} testID="forum-mine-waiting">
                    <Text style={[styles.infoText, { fontWeight: '700' }]}>{t(FORUM_WORDS.waitingMine, { title: waiting.title })}</Text>
                    {mine?.usuallyWithinHours ? <Text style={styles.infoText}>{tn(mine.usuallyWithinHours, FORUM_WORDS.usually.one, FORUM_WORDS.usually.other, { n: mine.usuallyWithinHours })}</Text> : null}
                    <Pressable accessibilityRole="button" style={[styles.quiet, { alignSelf: 'flex-start' }]}
                        onPress={() => void withdrawFirstLook(waiting.id).then(loadFront).catch((e) => setFailed((e as Error)?.message || t(FORUM_WORDS.failed)))}>
                        <Text style={styles.quietText}>{t(FORUM_WORDS.withdraw)}</Text>
                    </Pressable>
                </View>
            )}

            {list && list.topics.length === 0 && !failed && <Text style={styles.small}>{t(FORUM_WORDS.none)}</Text>}
            <View testID="forum-topics">
                {list?.topics.map((topic) => <TopicRow key={topic.id} topic={topic} sectionName={section ? '' : nameOf(topic.sectionId)} styles={styles} />)}
            </View>
            {list?.next != null && (
                <Pressable accessibilityRole="button" onPress={() => void loadList(section, list.next!)} style={styles.quiet}>
                    <Text style={styles.quietText}>{t(FORUM_WORDS.more)}</Text>
                </Pressable>
            )}
        </ScrollView>
    );
}

/** One topic in the list: a tap anywhere opens it (the small-cards rule). */
function TopicRow({ topic, sectionName, styles }: { topic: ForumTopic; sectionName: string; styles: ForumStyles }) {
    const when = timeAgo(Math.max(0, Date.now() - Date.parse(topic.lastActivityAt)));
    const replies = tn(topic.replyCount, FORUM_WORDS.replies.one, FORUM_WORDS.replies.other, { n: topic.replyCount });
    // Its opening post removed, with others' replies kept: the node sends no title (the topic page's words).
    const title = `${topic.pinned ? '📌 ' : ''}${topic.removed ? t(TOPIC_WORDS.removedTopic) : topic.title}`;
    return (
        <Pressable testID="forum-topic-row" accessibilityRole="button" onPress={() => router.push({ pathname: '/forum/[id]', params: { id: topic.id } })} style={styles.row}>
            <View style={styles.rowWords}>
                <Text style={styles.rowTitle}>{title}</Text>
                <Text style={styles.muted}>{[topic.writer.name, sectionName].filter(Boolean).join(' · ')}</Text>
                <Text style={styles.muted}>{replies} · {when}</Text>
            </View>
            {topic.unread && <View style={styles.dot} accessibilityLabel={t(FORUM_WORDS.unread)} accessibilityRole="image" />}
        </Pressable>
    );
}
