import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Linking } from 'react-native';
import { useStyles } from '../app/ThemeContext';
import {
    FORUM_ASK_WORDS, checkKnockForumPost, knockForumRowView, t,
    type KnockForum, type KnockForumPost, type KnockForumRowState,
} from '@beanpool/core';

/**
 * Under a request to join (components/WantsToJoin.tsx): up to three of the asker's posts on the worldwide forum (forums F11,
 * DESIGN-forums-fable.md §13). A row reads "A post on the worldwide forum ›" until a tap reads the post there and checks who
 * wrote it (@beanpool/core checkKnockForumPost: "Written by the same key that is asking ✓", not that key, not there now, or
 * "Could not check"); then it shows the forum's own title and words. Everything on the row is @beanpool/core
 * knockForumRowView: nothing the request carried is drawn as the forum's. No score, no count. The request is answered the
 * same whatever the check says. The web's components/KnockForumPosts.tsx is its twin, word for word.
 */
export function KnockForumPosts({ forum, knockId }: { forum: KnockForum; knockId: string }) {
    const [checks, setChecks] = useState<Record<string, KnockForumRowState>>({});
    const styles = useStyles(({ colors }) => StyleSheet.create({
        list: { marginTop: 10, gap: 8 },
        row: { minHeight: 48, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card },
        head: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
        title: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: '700', color: colors.text.heading, lineHeight: 20 },
        chevron: { fontSize: 16, color: colors.text.secondary, lineHeight: 20 },
        line: { fontSize: 13, color: colors.text.secondary, lineHeight: 18, marginTop: 4 },
        same: { color: colors.feedback.success.fg, fontWeight: '700' },
        other: { color: colors.feedback.warning.fg, fontWeight: '700' },
        words: { fontSize: 14, color: colors.text.body, lineHeight: 20, marginTop: 6 },
        open: { minHeight: 44, justifyContent: 'center', marginTop: 2 },
        openText: { fontSize: 14, fontWeight: '700', color: colors.text.link },
    }));

    const check = async (p: KnockForumPost) => {
        if (checks[p.postId] === 'checking') return;
        setChecks(c => ({ ...c, [p.postId]: 'checking' }));
        const result = await checkKnockForumPost(forum.at, p);
        setChecks(c => ({ ...c, [p.postId]: result }));
    };

    return (
        <View style={styles.list}>
            {forum.posts.map(p => {
                const c = checks[p.postId];
                const v = knockForumRowView(forum.at, p, c);
                const openUrl = v.openUrl;
                return (
                    <View key={p.postId} style={styles.row} testID={`knock-forum-${knockId}-${p.postId}`}>
                        {/* The label is the headline and the check's line, so VoiceOver says the answer with the row (a live region
                            is Android's only); the line itself says what a tap does. */}
                        <Pressable onPress={() => check(p)} accessibilityRole="button" accessibilityLabel={v.label}
                            accessibilityState={{ busy: c === 'checking' }}>
                            <View style={styles.head}>
                                <Text style={styles.title}>{v.headline}</Text>
                                <Text style={styles.chevron} accessible={false}>›</Text>
                            </View>
                            <Text style={[styles.line, v.tone === 'same' && styles.same, v.tone === 'other' && styles.other]}
                                accessibilityLiveRegion="polite" testID={`knock-forum-check-${knockId}-${p.postId}`}>{v.line}</Text>
                        </Pressable>
                        {!!v.words && <Text style={styles.words} numberOfLines={6}>{v.words}</Text>}
                        {openUrl && (
                            <Pressable style={styles.open} onPress={() => { void Linking.openURL(openUrl); }} accessibilityRole="link"
                                accessibilityLabel={t(FORUM_ASK_WORDS.open)}>
                                <Text style={styles.openText}>{t(FORUM_ASK_WORDS.open)}</Text>
                            </Pressable>
                        )}
                    </View>
                );
            })}
        </View>
    );
}
