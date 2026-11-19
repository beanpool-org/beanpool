import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme, useStyles } from '../app/ThemeContext';
import type { OtherCommunityNotice } from '../utils/use-notice-counts';
import { tn } from '@beanpool/core';

/**
 * Chat's row for each other community where messages wait (design R6): its name and count, and a tap lands in that
 * community's Talk (app/(tabs)/chats.tsx `openOtherCommunity`). Message requests waiting there get a row of their own that
 * says so, "1 message request in {community} · Switch", and lands on that community's Message requests (Marty, 19 Nov
 * 2026: a request read as "new message" would promise a chat that isn't in the list); a real message keeps its wording.
 * The row wraps its line at any text size, so a long community name at 320 dp with 1.3× text is never cut. A tap that moved nothing says so under the rows, in `note`.
 * Drawn here, apart from the screen, so the 320 dp harness (e2e/chat-s1-45-320.mjs) and the render tests draw this very row.
 */
export function OtherCommunityNotices({ notices, busy, onOpen, note }: {
    notices: readonly OtherCommunityNotice[];
    busy: boolean;
    onOpen: (url: string, what: 'messages' | 'requests') => void;
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
            {notices.flatMap((item) => {
                const rows: { what: 'messages' | 'requests'; label: string; testID: string }[] = [];
                if (item.count > 0) rows.push({
                    what: 'messages',
                    label: tn(item.count, '{n} new message in {community} · Switch', '{n} new messages in {community} · Switch', { community: item.name }),
                    testID: `other-community-notice-${item.url}`,
                });
                if (item.requests > 0) rows.push({
                    what: 'requests',
                    label: tn(item.requests, '{n} message request in {community} · Switch', '{n} message requests in {community} · Switch', { community: item.name }),
                    testID: `other-community-requests-${item.url}`,
                });
                return rows.map((row) => (
                    <Pressable
                        key={`${row.what}:${item.url}`}
                        accessibilityRole="button"
                        accessibilityLabel={row.label}
                        testID={row.testID}
                        style={styles.row}
                        disabled={busy}
                        onPress={() => onOpen(item.url, row.what)}
                    >
                        <Text style={styles.text}>{row.label}</Text>
                        <MaterialCommunityIcons name="chevron-right" size={22} color={colors.text.muted} />
                    </Pressable>
                ));
            })}
            {note ? <Text style={styles.note} accessibilityRole="alert" testID="other-community-note">{note}</Text> : null}
        </>
    );
}

export default OtherCommunityNotices;
