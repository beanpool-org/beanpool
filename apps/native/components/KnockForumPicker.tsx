import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { FORUM_ASK_PICKER_WORDS, FORUM_ASK_POSTS, t } from '@beanpool/core';
import { useStyles, useTheme } from '../app/ThemeContext';
import type { ForumAskPicks } from '../utils/forum-ask-picks';

/**
 * On the Ask to join form (Find a community, a community's card): "Add up to three of your worldwide forum posts
 * (optional)", the asker's own posts there, tap to pick, tap again to take it off (forums F11b, DESIGN-forums-fable.md §13;
 * the list and what is sent: utils/forum-ask-picks.ts). Nothing is drawn without a list: no posts, or not on the worldwide
 * community. Each row shows the topic's title as the forum gave it and where the post is in it. The web's twin is
 * apps/pwa/src/components/KnockForumPicker.tsx.
 */
export function KnockForumPicker({ picks, testID = 'knock-forum-picker' }: { picks: ForumAskPicks; testID?: string }) {
    const { colors } = useTheme();
    const styles = useStyles(({ colors: c }) => StyleSheet.create({
        box: { marginTop: 14, gap: 8 },
        heading: { fontSize: 14, fontWeight: '700', color: c.text.heading, lineHeight: 20 },
        about: { fontSize: 13, color: c.text.secondary, lineHeight: 18 },
        row: {
            flexDirection: 'row', alignItems: 'flex-start', gap: 10, minHeight: 48, paddingVertical: 10, paddingHorizontal: 12,
            borderRadius: 12, borderWidth: 1, borderColor: c.border.default, backgroundColor: c.surface.card,
        },
        off: { opacity: 0.6 },
        text: { flex: 1, minWidth: 0 },
        title: { fontSize: 14, fontWeight: '700', color: c.text.heading, lineHeight: 20 },
        sub: { fontSize: 13, color: c.text.secondary, lineHeight: 18, marginTop: 2 },
    }));
    const { offered, picked, toggle } = picks;
    if (!offered || offered.posts.length === 0) return null;
    const full = picked.length >= FORUM_ASK_POSTS;
    return (
        <View style={styles.box} testID={testID}>
            <Text style={styles.heading} accessibilityRole="header">{t(FORUM_ASK_PICKER_WORDS.heading)}</Text>
            <Text style={styles.about}>{t(FORUM_ASK_PICKER_WORDS.about)}</Text>
            {offered.posts.map((p) => {
                const on = picked.includes(p.postId);
                const disabled = full && !on;
                const where = t(FORUM_ASK_PICKER_WORDS.post, { number: p.number });
                return (
                    <Pressable
                        key={p.postId}
                        style={[styles.row, disabled && styles.off]}
                        onPress={() => toggle(p.postId)}
                        disabled={disabled}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: on, disabled }}
                        accessibilityLabel={`${p.title}. ${where}`}
                        testID={`${testID}-${p.postId}`}
                    >
                        <MaterialCommunityIcons name={on ? 'checkbox-marked' : 'checkbox-blank-outline'} size={26}
                            color={on ? colors.brand.fill : colors.text.muted} />
                        <View style={styles.text}>
                            <Text style={styles.title} numberOfLines={3}>{p.title}</Text>
                            <Text style={styles.sub}>{where}</Text>
                        </View>
                    </Pressable>
                );
            })}
            {full && <Text style={styles.about} accessibilityLiveRegion="polite" testID={`${testID}-full`}>{t(FORUM_ASK_PICKER_WORDS.full)}</Text>}
        </View>
    );
}
