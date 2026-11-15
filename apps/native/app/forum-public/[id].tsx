/**
 * One forum topic for a visitor (slice F7, the apps' part), as the web lobby's (apps/pwa/src/pages/ForumVisitorPage.tsx): the
 * node's public answer, unsigned (utils/forum-public.ts), read only. Each post's writer (their name, and their community where
 * they switched the label on) and words; no pictures, no profile. Where the reply box would be, the door: Join to reply.
 *
 * Opened from the visitors' Forum tab, the Home card "From the forum", and a public page's link to the app (app/forum/index.tsx).
 * A screen a phone with no account may stay on while it looks around (utils/look-around.ts).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { forumSectionName, publicWriterLine, t, timeAgo, type ForumPublicTopicPage } from '@beanpool/core';
import { getPublicTopic } from '../../utils/forum-public';
import { ForumWords } from '../../components/forum/ForumBits';
import { useForumStyles } from '../../components/forum/forum-style';
import { TOPIC_WORDS } from '../../components/forum/forum-words';
import { VisitorDoor } from '../../components/forum/ForumVisitorPane';

export default function ForumPublicTopicScreen() {
    const styles = useForumStyles();
    const { id } = useLocalSearchParams<{ id: string }>();
    const [page, setPage] = useState<ForumPublicTopicPage | null>(null);
    const [failed, setFailed] = useState(false);
    const read = useCallback(async (after: number) => {
        try {
            const next = await getPublicTopic(String(id), after);
            setPage((was) => (after && was ? { ...next, posts: [...was.posts.filter((p) => p.number <= after), ...next.posts] } : next));
            setFailed(false);
        } catch {
            setFailed(true);
        }
    }, [id]);
    useEffect(() => { setPage(null); void read(0); }, [read]);

    const topic = page?.topic;
    const titleLine = topic ? `${topic.pinned ? '📌 ' : ''}${topic.title}` : '';
    const placeLine = topic?.place ? `📍 ${topic.place}` : '';
    const member = t(TOPIC_WORDS.member);
    const quoted = (n: number | null) => (n ? page?.posts.find((p) => p.number === n) ?? null : null);
    return (
        <SafeAreaView style={styles.page} edges={['top']} testID="forum-visitor-topic">
            <View style={styles.head}>
                <Pressable accessibilityRole="button" accessibilityLabel={t(TOPIC_WORDS.back)} testID="forum-visitor-back"
                    onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/forum'))} style={styles.iconBtn}>
                    <Text style={styles.heading}>‹</Text>
                </Pressable>
                <Text style={styles.headWords} numberOfLines={1}>{page?.section ? forumSectionName(page.section) : ''}</Text>
            </View>
            <ScrollView contentContainerStyle={[styles.pad, { paddingTop: 12, paddingBottom: 48 }]}>
                {failed && !page && (
                    <View style={{ gap: 8, alignItems: 'flex-start' }} testID="forum-visitor-failed">
                        <Text style={styles.small} accessibilityRole="alert">{t(TOPIC_WORDS.failed)}</Text>
                        <Pressable accessibilityRole="button" onPress={() => void read(0)} style={styles.quiet}>
                            <Text style={styles.quietText}>{t(TOPIC_WORDS.again)}</Text>
                        </Pressable>
                    </View>
                )}
                {topic && <Text style={styles.title} testID="forum-visitor-title">{titleLine}</Text>}
                {placeLine ? <Text style={styles.muted}>{placeLine}</Text> : null}
                {page?.posts.map((post) => {
                    const q = quoted(post.quotes);
                    return (
                        <View key={post.id} testID={`forum-visitor-post-${post.number}`} style={[{ gap: 4, paddingTop: 8 }, post.number > 1 && styles.row, post.number > 1 && { flexDirection: 'column' }]}>
                            <Text style={styles.muted}>
                                {[publicWriterLine(post.writer, member), timeAgo(Math.max(0, Date.now() - Date.parse(post.createdAt))), post.edited ? t(TOPIC_WORDS.edited) : ''].filter(Boolean).join(' · ')}
                            </Text>
                            {q?.words ? (
                                <View style={styles.quote}>
                                    <Text style={styles.small} numberOfLines={2}>{t(TOPIC_WORDS.quoteLine, { name: publicWriterLine(q.writer, member), words: q.words })}</Text>
                                </View>
                            ) : null}
                            <ForumWords words={post.words} linksOn testID={`forum-visitor-words-${post.number}`} />
                        </View>
                    );
                })}
                {page?.next != null && (
                    <Pressable accessibilityRole="button" onPress={() => void read(page.next!)} style={styles.quiet}>
                        <Text style={styles.quietText}>{t(TOPIC_WORDS.moreReplies)}</Text>
                    </Pressable>
                )}
                {topic && (topic.closed
                    ? <Text style={styles.italic}>{t(TOPIC_WORDS.closed)}</Text>
                    : <View style={{ paddingTop: 12 }}><VisitorDoor /></View>)}
            </ScrollView>
        </SafeAreaView>
    );
}
