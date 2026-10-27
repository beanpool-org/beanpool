/**
 * The one chat header (groups decision 9): back, then the owner — "🌻 Garden Crew · group",
 * "🥖 Bakery · enterprise", "🎯 Hall roof · project", "📅 Working bee · event" — and an optional menu. Tapping the owner opens the owner's
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
import { MemberAvatar } from './MemberAvatar';
import { t } from '@beanpool/core';

/** The line under the chat's name: its kind, what the screen adds ("4 members · muted"), and "tap for info", whole per variant. */
function ownerSubLine(kind: string, detail: string | null | undefined, tapForInfo: boolean): string {
    if (detail && tapForInfo) return t('{kind} · {detail}  ·  tap for info', { kind, detail });
    if (detail) return t('{kind} · {detail}', { kind, detail });
    if (tapForInfo) return t('{kind}  ·  tap for info', { kind });
    return kind;
}

interface Props {
    kind: YourChatKind;
    name: string;
    avatarUrl?: string | null;
    category?: string | null;
    /** An enterprise-kind chat's lifecycle: 'bounded' is a project (§3.1). */
    lifecycle?: string | null;
    /** A second fact after the kind word, e.g. "12 members" or "muted". */
    detail?: string | null;
    onBack: () => void;
    onOpenOwner?: () => void;
    onMenu?: () => void;
}

export function ChatOwnerHeader({ kind, name, avatarUrl, category, lifecycle, detail, onBack, onOpenOwner, onMenu }: Props) {
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
    const h = ownerHeader(kind, name, category, lifecycle);

    return (
        <View style={styles.header}>
            <Pressable accessibilityRole="button" accessibilityLabel={t('Back')} onPress={onBack} style={styles.iconBtn}>
                <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text.body} />
            </Pressable>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={h.a11y}
                onPress={onOpenOwner}
                disabled={!onOpenOwner}
                style={[styles.owner, avatarUrl ? { flexDirection: 'row', alignItems: 'center', gap: 10 } : null]}
            >
                {avatarUrl ? (
                    <MemberAvatar avatarUrl={avatarUrl} pubkey="" callsign={name} size={28} />
                ) : null}
                <View style={{ flex: 1, minWidth: 0, justifyContent: 'center' }}>
                    <Text style={styles.title} numberOfLines={1}>{h.title}</Text>
                    <Text style={styles.sub} numberOfLines={1}>
                        {ownerSubLine(h.kindWord, detail, !!onOpenOwner)}
                    </Text>
                </View>
            </Pressable>
            {onMenu && (
                <Pressable accessibilityRole="button" accessibilityLabel={t('Chat menu')} onPress={onMenu} style={styles.iconBtn}>
                    <MaterialCommunityIcons name="dots-vertical" size={24} color={colors.text.body} />
                </Pressable>
            )}
        </View>
    );
}
