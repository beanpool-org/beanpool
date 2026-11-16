/**
 * The visitors' Forum tab on the phone (slice F7, the apps' part; DESIGN-forums-fable.md §7 "The apps' visitors", §18 "guest
 * view gains a Forum tab"), as the web lobby's (apps/pwa/src/pages/ForumVisitorPage.tsx): the global community's forum, read
 * only, from the node's public answer (utils/forum-public.ts, unsigned).
 *
 * - Sections as chips, topics newest activity first; a tap anywhere on a row opens the topic (app/forum-public/[id].tsx).
 * - A forum with no public topic says so, with the door (Join to reply): never a wall. No answer is the forum's own
 *   "Couldn't load" with Try again, never "no topics".
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import {
    FORUM_VISITOR_WORDS, forumSectionName, forumWriterLine, t, timeAgo, tn, type ForumPublicList, type ForumPublicSection,
} from '@beanpool/core';
import { getPublicForum, getPublicSection, openVisitorDoor } from '../../utils/forum-public';
import { FORUM_WORDS, TOPIC_WORDS } from './forum-words';
import { useForumStyles } from './forum-style';

/** Join to reply: where a member's reply box or New topic would be. */
export function VisitorDoor() {
    const styles = useForumStyles();
    return (
        <Pressable testID="forum-visitor-join" accessibilityRole="button" onPress={() => void openVisitorDoor((to) => router.push(to as never))} style={styles.commit}>
            <Text style={styles.commitText}>{t(FORUM_VISITOR_WORDS.joinToReply)}</Text>
        </Pressable>
    );
}

export function ForumVisitorPane() {
    const styles = useForumStyles();
    const [sections, setSections] = useState<ForumPublicSection[]>([]);
    const [section, setSection] = useState<string | null>(null);
    const [list, setList] = useState<ForumPublicList | null>(null);
    const [failed, setFailed] = useState(false);
    const picked = useRef(section);
    picked.current = section;

    const load = useCallback(async (asked: string | null, offset: number) => {
        try {
            const answer = asked ? await getPublicSection(asked, offset) : await getPublicForum(offset);
            if ('sections' in answer) setSections(answer.sections.slice().sort((a, b) => a.position - b.position));
            if (picked.current !== asked) return;
            setList((was) => (offset && was ? { topics: [...was.topics, ...answer.topics.filter((p) => !was.topics.some((x) => x.id === p.id))], next: answer.next } : answer));
            setFailed(false);
        } catch {
            if (picked.current === asked) setFailed(true);
        }
    }, []);
    useEffect(() => { void load(section, 0); }, [section, load]);

    const nameOf = (id: string) => { const s = sections.find((x) => x.id === id); return s ? forumSectionName(s) : ''; };
    return (
        <ScrollView testID="forum-visitor" style={{ flex: 1 }} contentContainerStyle={[styles.pad, { paddingTop: 8, paddingBottom: 100 }]}>
            {sections.length > 0 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} accessibilityLabel={t(FORUM_WORDS.pickSection)} testID="forum-visitor-section">
                    {[null, ...sections.map((s) => s.id)].map((id) => {
                        const on = section === id;
                        return (
                            <Pressable key={id ?? ''} onPress={() => { setList(null); setSection(id); }} accessibilityRole="button" accessibilityState={{ selected: on }} style={[styles.chip, on && styles.chipOn]}>
                                <Text style={on ? styles.chipTextOn : styles.chipText}>{id ? nameOf(id) : t(FORUM_WORDS.allSections)}</Text>
                            </Pressable>
                        );
                    })}
                </ScrollView>
            )}
            {failed && !list && (
                <View style={{ gap: 8, alignItems: 'flex-start' }} testID="forum-visitor-failed">
                    <Text style={styles.small} accessibilityRole="alert">{t(FORUM_WORDS.failed)}</Text>
                    <Pressable accessibilityRole="button" onPress={() => void load(section, 0)} style={styles.quiet}>
                        <Text style={styles.quietText}>{t(FORUM_WORDS.again)}</Text>
                    </Pressable>
                </View>
            )}
            {list && list.topics.length === 0 && (
                <>
                    <Text style={styles.small} testID="forum-visitor-none">{t(FORUM_VISITOR_WORDS.none)}</Text>
                    <VisitorDoor />
                </>
            )}
            {list && list.topics.length > 0 && (
                <View testID="forum-visitor-topics">
                    {list.topics.map((topic) => {
                        const replies = tn(topic.replyCount, FORUM_WORDS.replies.one, FORUM_WORDS.replies.other, { n: topic.replyCount });
                        const title = `${topic.pinned ? '📌 ' : ''}${topic.title}`;
                        return (
                            <Pressable key={topic.id} testID="forum-visitor-topic-row" accessibilityRole="button" style={styles.row}
                                onPress={() => router.push({ pathname: '/forum-public/[id]', params: { id: topic.id } })}>
                                <View style={styles.rowWords}>
                                    <Text style={styles.rowTitle}>{title}</Text>
                                    <Text style={styles.muted}>{[forumWriterLine(topic.writer, t(TOPIC_WORDS.member)), section ? '' : nameOf(topic.sectionId)].filter(Boolean).join(' · ')}</Text>
                                    <Text style={styles.muted}>{[replies, timeAgo(Math.max(0, Date.now() - Date.parse(topic.lastActivityAt)))].join(' · ')}</Text>
                                </View>
                            </Pressable>
                        );
                    })}
                </View>
            )}
            {list?.next != null && (
                <Pressable accessibilityRole="button" onPress={() => void load(section, list.next!)} style={styles.quiet}>
                    <Text style={styles.quietText}>{t(FORUM_WORDS.more)}</Text>
                </Pressable>
            )}
        </ScrollView>
    );
}
