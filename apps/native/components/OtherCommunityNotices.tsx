import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme, useStyles } from '../app/ThemeContext';
import type { OtherCommunityNotice } from '../utils/use-notice-counts';
import { tn } from '@beanpool/core';

/**
 * Chat's row for each other community where messages wait (design R6): its name and count, and a tap lands in that
 * community's Talk (app/(tabs)/chats.tsx `openOtherCommunity`). The row wraps its line at any text size, so a long
 * community name at 320 dp with 1.3× text is never cut. A tap that moved nothing says so under the rows, in `note`.
 * Drawn here, apart from the screen, so the 320 dp harness (e2e/chat-s1-45-320.mjs) and the render tests draw this very row.
 */
export function OtherCommunityNotices({ notices, busy, onOpen, note }: {
    notices: readonly OtherCommunityNotice[];
    busy: boolean;
    onOpen: (url: string) => void;
    note?: string | null;
}) {
    const { colors } = useTheme();
    const styles = useStyles(({ colors: c }) => StyleSheet.create({
        row: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            minHeight: 48,
            paddingHorizontal: 16,
            paddingVertical: 8,
            borderBottomWidth: 1,
            borderBottomColor: c.border.default,
        },
        text: { flex: 1, fontSize: 15, fontWeight: '600', color: c.text.body },
        note: { fontSize: 13, lineHeight: 18, color: c.text.secondary, paddingHorizontal: 16, paddingVertical: 8 },
    }));
    if (notices.length === 0) return null;
    return (
        <>
            {notices.map((item) => {
                const label = tn(item.count, '{n} new message in {community} · Switch', '{n} new messages in {community} · Switch', { community: item.name });
                return (
                    <Pressable
                        key={item.url}
                        accessibilityRole="button"
                        accessibilityLabel={label}
                        testID={`other-community-notice-${item.url}`}
                        style={styles.row}
                        disabled={busy}
                        onPress={() => onOpen(item.url)}
                    >
                        <Text style={styles.text}>{label}</Text>
                        <MaterialCommunityIcons name="chevron-right" size={22} color={colors.text.muted} />
                    </Pressable>
                );
            })}
            {note ? <Text style={styles.note} accessibilityRole="alert" testID="other-community-note">{note}</Text> : null}
        </>
    );
}

export default OtherCommunityNotices;
