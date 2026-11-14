import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { t, timeAgo, word } from '@beanpool/core';
import { useStyles, useTheme } from '../../app/ThemeContext';
import { searchForum, type ForumSearchHit } from '../../utils/forum-search';

/**
 * The forum's search box on the phone (slice F6; DESIGN-forums-fable.md §8, §14 "🔍"), for the top of the Forum's list.
 * Slice F3 builds that list (components/forum/ForumPane.tsx) and draws this at its top:
 * `<ForumSearch sectionName={…} onShowing={setSearching} onOpen={(topicId, number) => open the topic at that post} />`,
 * hiding its topic rows while `onShowing(true)`. The node finds every word typed in titles, opening posts and replies,
 * newest first, never a post the member may not read (apps/server/src/engine/forum-search.ts).
 *
 * - **Asked on Search** (the keyboard's search key, or 🔍), never as they type: each search is one of the member's 100 a day.
 * - **A hit** is a small card: a tap anywhere opens its topic at the post found. Its topic's title, who wrote the post, its
 *   section, when, and its words around the find. ✕ clears the search and gives the list back.
 * - The search row is the chat list's own shape (app/(tabs)/chats.tsx): 44 dp, the subtle surface, colours from the theme.
 */
export const FORUM_SEARCH_WORDS = {
    box: word('Search the forum'),
    search: word('Search'),
    clear: word('Clear the search'),
    none: word('Nothing in the forum has every word of “{q}”.'),
    more: word('Show more results'),
    failed: word('Couldn’t search the forum. Check your connection and try again.'),
    removedTopic: word('A removed topic'),
};

export function ForumSearch({ onOpen, onShowing, sectionName }: {
    /** A hit was tapped: open topic `topicId` at post `number`. */
    onOpen: (topicId: string, number: number) => void;
    /** Whether hits (or "nothing found") take the topic list's place now. */
    onShowing?: (showing: boolean) => void;
    /** A section's name, by its id, as the list names it; none, and a hit names no section. */
    sectionName?: (sectionId: string) => string;
}) {
    const { colors } = useTheme();
    const styles = useStyles(({ colors: c }) => StyleSheet.create({
        row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
        box: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 44, borderRadius: 12, paddingHorizontal: 10, backgroundColor: c.surface.subtle },
        input: { flex: 1, fontSize: 15, color: c.text.body, paddingVertical: 8 },
        iconButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
        note: { fontSize: 14, color: c.text.secondary, paddingHorizontal: 16, paddingBottom: 8 },
        hit: { paddingHorizontal: 16, paddingVertical: 10, minHeight: 56, borderTopWidth: 1, borderTopColor: c.surface.subtle },
        title: { fontSize: 15, fontWeight: '700', color: c.text.body },
        meta: { fontSize: 12, color: c.text.muted, marginTop: 2 },
        excerpt: { fontSize: 14, color: c.text.secondary, marginTop: 4 },
        more: { minHeight: 44, marginHorizontal: 16, marginVertical: 8, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surface.subtle },
        moreText: { fontSize: 15, fontWeight: '600', color: c.text.body },
    }));
    const [typed, setTyped] = useState('');
    const [answer, setAnswer] = useState<{ q: string; hits: ForumSearchHit[]; next: number | null } | null>(null);
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState<string | null>(null);

    async function ask(offset = 0) {
        const q = offset ? answer?.q ?? '' : typed.trim();
        if (!q || busy) return;
        setBusy(true);
        setFailed(null);
        try {
            const page = await searchForum(q, offset);
            const before = offset && answer ? answer.hits.filter((h) => !page.hits.some((x) => x.postId === h.postId)) : [];
            setAnswer({ q, hits: [...before, ...page.hits], next: page.next });
            onShowing?.(true);
        } catch (e) {
            setFailed((e as Error)?.message || t(FORUM_SEARCH_WORDS.failed));
        } finally {
            setBusy(false);
        }
    }
    function clear() {
        setTyped('');
        setAnswer(null);
        setFailed(null);
        onShowing?.(false);
    }

    return (
        <View testID="forum-search">
            <View style={styles.row}>
                <View style={styles.box}>
                    <MaterialCommunityIcons name="magnify" size={20} color={colors.text.muted} />
                    <TextInput
                        testID="forum-search-box"
                        accessibilityLabel={t(FORUM_SEARCH_WORDS.box)}
                        placeholder={t(FORUM_SEARCH_WORDS.box)}
                        placeholderTextColor={colors.text.muted}
                        style={styles.input}
                        value={typed}
                        onChangeText={setTyped}
                        maxLength={200}
                        returnKeyType="search"
                        onSubmitEditing={() => void ask(0)}
                    />
                    {busy
                        ? <ActivityIndicator size="small" color={colors.text.muted} />
                        : (
                            <Pressable testID="forum-search-go" accessibilityRole="button" accessibilityLabel={t(FORUM_SEARCH_WORDS.search)} disabled={!typed.trim()}
                                onPress={() => void ask(0)} style={styles.iconButton}>
                                <MaterialCommunityIcons name="arrow-right-circle" size={24} color={typed.trim() ? colors.accent.fill : colors.text.muted} />
                            </Pressable>
                        )}
                </View>
                {(answer || typed !== '') && (
                    <Pressable testID="forum-search-clear" accessibilityRole="button" accessibilityLabel={t(FORUM_SEARCH_WORDS.clear)} onPress={clear} style={styles.iconButton}>
                        <MaterialCommunityIcons name="close-circle" size={22} color={colors.text.muted} />
                    </Pressable>
                )}
            </View>
            {failed && <Text testID="forum-search-failed" accessibilityRole="alert" style={styles.note}>{failed}</Text>}
            {answer && answer.hits.length === 0 && <Text testID="forum-search-none" style={styles.note}>{t(FORUM_SEARCH_WORDS.none, { q: answer.q })}</Text>}
            {answer?.hits.map((hit) => {
                const meta = [hit.writer.name || t('A member'), sectionName?.(hit.sectionId) ?? '', timeAgo(Math.max(0, Date.now() - Date.parse(hit.createdAt)))].filter(Boolean).join(' · ');
                const title = hit.title || t(FORUM_SEARCH_WORDS.removedTopic);
                return (
                    // TalkBack reads the card's own lines, title first: no label of its own to translate.
                    <Pressable key={hit.postId} testID="forum-search-hit" accessibilityRole="button"
                        onPress={() => onOpen(hit.topicId, hit.number)} style={styles.hit}>
                        <Text style={styles.title} numberOfLines={2}>{title}</Text>
                        <Text style={styles.meta} numberOfLines={1}>{meta}</Text>
                        {!!hit.excerpt && <Text style={styles.excerpt} numberOfLines={3}>{hit.excerpt}</Text>}
                    </Pressable>
                );
            })}
            {answer?.next != null && (
                <Pressable testID="forum-search-more" accessibilityRole="button" disabled={busy} onPress={() => void ask(answer.next!)} style={styles.more}>
                    <Text style={styles.moreText}>{t(FORUM_SEARCH_WORDS.more)}</Text>
                </Pressable>
            )}
        </View>
    );
}
