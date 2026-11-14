/**
 * "Waiting for a first look" on the phone (slice F3; DESIGN-forums-fable.md §5, §6), as the web's
 * components/forum/ForumFirstLooks.tsx, for the community's owners, admins and moderators, in every language (not in Settings,
 * which is English only): each new member's first topic, oldest first, with its words and photos. OK makes the topic in the
 * writer's name and marks them known; No takes one of the five reasons a removal gives. The writer is told either way by the
 * bell, and never who answered.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { forumSectionName, t, timeAgo } from '@beanpool/core';
import { useTheme } from '../ThemeContext';
import { FIRST_LOOK_NO_REASONS, keptForumFront, listFirstLooks, noFirstLook, okFirstLook, type FirstLookNoReason, type ForumFront, type ForumWaiting } from '../../utils/forum';
import { ForumPhotos, ForumWords, useForumStyles } from '../../components/forum/ForumBits';
import { FIRST_LOOK_WORDS, TOPIC_WORDS } from '../../components/forum/forum-words';

export default function ForumFirstLooksScreen() {
    const styles = useForumStyles();
    const { colors } = useTheme();
    const [front, setFront] = useState<ForumFront | null>(null);
    const [waiting, setWaiting] = useState<ForumWaiting[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [saying, setSaying] = useState<string | null>(null);
    const [reason, setReason] = useState<FirstLookNoReason | ''>('');
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(() => listFirstLooks().then((r) => { setWaiting(r.waiting); setFailed(false); }).catch(() => setFailed(true)), []);
    useEffect(() => { void keptForumFront().then(setFront); void load(); }, [load]);

    /** One answer, then the list again: a moderator with several waiting stays here and answers the next. */
    async function answer(id: string, fn: () => Promise<unknown>) {
        setBusy(id);
        setError(null);
        try {
            await fn();
            setSaying(null);
            setReason('');
            await load();
        } catch (e) {
            setError((e as Error)?.message || t(TOPIC_WORDS.saveFailed));
        } finally {
            setBusy(null);
        }
    }

    return (
        <SafeAreaView style={styles.page} testID="forum-first-looks">
            <View style={styles.head}>
                <Pressable accessibilityRole="button" accessibilityLabel={t(FIRST_LOOK_WORDS.back)} onPress={() => router.back()} style={styles.iconBtn}>
                    <MaterialCommunityIcons name="chevron-left" size={28} color={colors.text.body} />
                </Pressable>
                <Text style={styles.heading} accessibilityRole="header">{t(FIRST_LOOK_WORDS.heading)}</Text>
            </View>
            <ScrollView contentContainerStyle={[styles.pad, { paddingTop: 12 }]}>
                {failed && <Text style={styles.small}>{t(FIRST_LOOK_WORDS.failed)}</Text>}
                {waiting && waiting.length === 0 && <Text style={styles.small}>{t(FIRST_LOOK_WORDS.none)}</Text>}
                {error && <Text style={styles.danger} accessibilityRole="alert">{error}</Text>}
                {waiting?.map((w) => {
                    const section = front?.sections.find((s) => s.id === w.sectionId);
                    return (
                        <View key={w.id} style={styles.card} testID="forum-first-look">
                            <Text style={styles.muted}>{[section ? forumSectionName(section) : '', w.writer.name, timeAgo(Math.max(0, Date.now() - Date.parse(w.createdAt)))].filter(Boolean).join(' · ')}</Text>
                            <Text style={styles.rowTitle}>{w.title}</Text>
                            {w.place ? <Text style={styles.muted}>📍 {w.place}</Text> : null}
                            {/* A new writer's words: their links stay plain text here too, until a moderator says OK. */}
                            <ForumWords words={w.words} linksOn={false} styles={styles} />
                            <ForumPhotos id={w.id} count={w.photos} waiting styles={styles} />
                            {saying === w.id ? (
                                <View style={{ gap: 4 }}>
                                    <Text style={styles.label}>{t(FIRST_LOOK_WORDS.why)}</Text>
                                    {FIRST_LOOK_NO_REASONS.map((r) => (
                                        <Pressable key={r} accessibilityRole="radio" accessibilityState={{ selected: reason === r }} onPress={() => setReason(r)}
                                            style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                                            <MaterialCommunityIcons name={reason === r ? 'radiobox-marked' : 'radiobox-blank'} size={22} color={reason === r ? colors.accent.primary : colors.text.muted} />
                                            <Text style={[styles.body, { flex: 1 }]}>{t(FIRST_LOOK_WORDS.reasons[r])}</Text>
                                        </Pressable>
                                    ))}
                                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
                                        <Pressable accessibilityRole="button" onPress={() => { setSaying(null); setReason(''); }} style={styles.quiet}><Text style={styles.quietText}>{t(FIRST_LOOK_WORDS.cancel)}</Text></Pressable>
                                        <Pressable accessibilityRole="button" testID="forum-first-look-say-no" disabled={!reason || busy === w.id} onPress={() => reason && void answer(w.id, () => noFirstLook(w.id, reason))}
                                            style={[styles.quiet, { backgroundColor: colors.feedback.danger.bg, borderColor: colors.feedback.danger.border }, (!reason || busy === w.id) && { opacity: 0.5 }]}>
                                            <Text style={[styles.quietText, { color: colors.feedback.danger.fg }]}>{t(FIRST_LOOK_WORDS.send)}</Text>
                                        </Pressable>
                                    </View>
                                </View>
                            ) : (
                                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
                                    <Pressable accessibilityRole="button" testID="forum-first-look-no" disabled={busy === w.id} onPress={() => { setSaying(w.id); setReason(''); }} style={styles.quiet}>
                                        <Text style={styles.quietText}>{t(FIRST_LOOK_WORDS.no)}</Text>
                                    </Pressable>
                                    <Pressable accessibilityRole="button" testID="forum-first-look-ok" disabled={busy === w.id} onPress={() => void answer(w.id, () => okFirstLook(w.id))} style={[styles.commit, busy === w.id && { opacity: 0.5 }]}>
                                        <Text style={styles.commitText}>{t(FIRST_LOOK_WORDS.ok)}</Text>
                                    </Pressable>
                                </View>
                            )}
                        </View>
                    );
                })}
            </ScrollView>
        </SafeAreaView>
    );
}
