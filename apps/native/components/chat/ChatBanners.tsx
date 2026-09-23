/**
 * The two strips above the message box — "Replying to Ana" and "Editing message" — and the ⋮ sheet.
 *
 * All three were one-screen-only before: the banners belonged to the DM screen, the sheet to the group
 * chat. Both chats now carry both.
 */

import React from 'react';
import { View, Text, Pressable, Modal } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../../app/ThemeContext';
import type { ChatStyles } from './styles';

interface BannerProps {
    styles: ChatStyles;
    /** "You", or the other person's name. */
    author: string;
    /** One line of the message being replied to or edited. */
    text: string;
    onCancel: () => void;
}

export function ChatReplyBanner({ styles, author, text, onCancel }: BannerProps) {
    const { colors } = useTheme();
    return (
        <View style={styles.replyPreviewContainer}>
            <View style={styles.replyPreviewBar}>
                <View style={{ flex: 1, borderLeftWidth: 3, borderLeftColor: colors.accent.primary, paddingLeft: 8 }}>
                    <Text style={styles.replyPreviewAuthor}>Replying to {author}</Text>
                    <Text style={styles.replyPreviewText} numberOfLines={1}>{text}</Text>
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel="Cancel reply" onPress={onCancel} style={styles.replyPreviewClose}>
                    <MaterialCommunityIcons name="close" size={20} color={colors.text.secondary} />
                </Pressable>
            </View>
        </View>
    );
}

export function ChatEditBanner({ styles, text, onCancel }: Omit<BannerProps, 'author'>) {
    const { colors } = useTheme();
    return (
        <View style={styles.replyPreviewContainer}>
            <View style={styles.replyPreviewBar}>
                <View style={{ flex: 1, borderLeftWidth: 3, borderLeftColor: colors.brand.primary, paddingLeft: 8 }}>
                    <Text style={[styles.replyPreviewAuthor, { color: colors.brand.primary }]}>Editing message</Text>
                    <Text style={styles.replyPreviewText} numberOfLines={1}>{text}</Text>
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel="Cancel edit" onPress={onCancel} style={styles.replyPreviewClose}>
                    <MaterialCommunityIcons name="close" size={20} color={colors.text.secondary} />
                </Pressable>
            </View>
        </View>
    );
}

export interface ChatMenuItem {
    icon: string;
    label: string;
    onPress: () => void;
    hidden?: boolean;
}

/** The mute choices, in the one wording every chat uses. */
export const MUTE_CHOICES: Array<{ key: '8h' | '1w' | 'always'; label: string }> = [
    { key: '8h', label: 'For 8 hours' },
    { key: '1w', label: 'For a week' },
    { key: 'always', label: 'Always' },
];

interface SheetProps {
    styles: ChatStyles;
    menuOpen: boolean;
    muteOpen: boolean;
    title: string;
    items: ChatMenuItem[];
    /** Shown under the mute choices, e.g. "@mentions still reach you." */
    muteHint?: string | null;
    onClose: () => void;
    onPickMute: (duration: '8h' | '1w' | 'always') => void;
    bottomInset: number;
}

/** A small sheet, not a popover: the rows are full-width 56dp targets at 320dp. */
export function ChatMenuSheet({ styles, menuOpen, muteOpen, title, items, muteHint, onClose, onPickMute, bottomInset }: SheetProps) {
    const { colors } = useTheme();
    return (
        <Modal visible={menuOpen || muteOpen} transparent animationType="fade" onRequestClose={onClose}>
            <Pressable style={styles.menuBackdrop} onPress={onClose} accessibilityLabel="Close menu">
                <View style={[styles.menuSheet, { paddingBottom: Math.max(bottomInset, 12) }]}>
                    <Text style={styles.menuTitle} numberOfLines={1}>{muteOpen ? 'Mute notifications' : title}</Text>
                    {muteOpen ? (
                        <>
                            {MUTE_CHOICES.map(c => (
                                <Pressable key={c.key} style={styles.menuRow} onPress={() => onPickMute(c.key)} accessibilityRole="button">
                                    <Text style={styles.menuLabel}>{c.label}</Text>
                                </Pressable>
                            ))}
                            {!!muteHint && <Text style={styles.menuHint}>{muteHint}</Text>}
                        </>
                    ) : items.filter(m => !m.hidden).map(m => (
                        <Pressable key={m.label} style={styles.menuRow} onPress={m.onPress} accessibilityRole="button">
                            <MaterialCommunityIcons name={m.icon as any} size={22} color={colors.text.body} />
                            <Text style={styles.menuLabel} numberOfLines={1}>{m.label}</Text>
                        </Pressable>
                    ))}
                </View>
            </Pressable>
        </Modal>
    );
}
