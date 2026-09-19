/**
 * The one chat header (groups decision 9): back, then the owner — "🌻 Garden Crew · group",
 * "🥖 Bakery · enterprise", "📅 Working bee · event" — and an optional menu. Tapping the owner opens the owner's
 * page, which is the chat's "info" screen.
 *
 * At 320dp and 1.3× text the name truncates on its own line and the kind word sits under it, so the kind is
 * never the part that gets cut. Back and menu are 48dp targets that never shrink.
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme, useStyles } from '../app/ThemeContext';
import { ownerHeader, type YourChatKind } from '../utils/your-groups';

interface Props {
    kind: YourChatKind;
    name: string;
    category?: string | null;
    /** A second fact after the kind word, e.g. "12 members" or "muted". */
    detail?: string | null;
    onBack: () => void;
    onOpenOwner?: () => void;
    onMenu?: () => void;
}

export function ChatOwnerHeader({ kind, name, category, detail, onBack, onOpenOwner, onMenu }: Props) {
    const { colors } = useTheme();
    const styles = useStyles(({ colors }) => StyleSheet.create({
        header: {
            flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, minHeight: 56,
            borderBottomWidth: 1, borderBottomColor: colors.surface.subtle, backgroundColor: colors.surface.app,
        },
        iconBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
        owner: { flex: 1, minWidth: 0, minHeight: 48, justifyContent: 'center', paddingHorizontal: 4 },
        title: { fontSize: 17, fontWeight: '800', color: colors.text.heading },
        sub: { fontSize: 12, fontWeight: '600', color: colors.text.secondary, marginTop: 1 },
    }));
    const h = ownerHeader(kind, name, category);

    return (
        <View style={styles.header}>
            <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} style={styles.iconBtn}>
                <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text.body} />
            </Pressable>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={h.a11y}
                onPress={onOpenOwner}
                disabled={!onOpenOwner}
                style={styles.owner}
            >
                <Text style={styles.title} numberOfLines={1}>{h.title}</Text>
                <Text style={styles.sub} numberOfLines={1}>
                    {h.kindWord}{detail ? ` · ${detail}` : ''}{onOpenOwner ? '  ·  tap for info' : ''}
                </Text>
            </Pressable>
            {onMenu && (
                <Pressable accessibilityRole="button" accessibilityLabel="Chat menu" onPress={onMenu} style={styles.iconBtn}>
                    <MaterialCommunityIcons name="dots-vertical" size={24} color={colors.text.body} />
                </Pressable>
            )}
        </View>
    );
}
