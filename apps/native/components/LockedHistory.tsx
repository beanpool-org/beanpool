/**
 * What a member who changed phones sees in a group chat (scratch/global-node/DESIGN-group-history-after-rekey-fable.md §7,
 * Marty's pick 5 of 13 Oct): the one quiet row the locked lines from before the change collapse into, the sheet behind it
 * with the two ways back, and the sealed line drawn as nobody's (or as the member's own, with no words). Their own file,
 * so e2e/locked-history-320.mjs renders these very components at 320dp with 1.3× text, in both schemes.
 */
import React, { useMemo } from 'react';
import { View, Text, Pressable, Modal, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../app/ThemeContext';
import type { AppColors } from '../constants/colors';
import { makeChatStyles } from './chat/styles';
import { LOCKED_HISTORY_ASK, LOCKED_HISTORY_KEEP, LOCKED_HISTORY_SHEET_BODY, LOCKED_HISTORY_SHEET_TITLE, LOCKED_HISTORY_WORDS } from '../utils/group-history-unlock';

const makeStyles = (colors: AppColors) => StyleSheet.create({
    systemWrap: { alignItems: 'center', marginVertical: 6, paddingHorizontal: 16 },
    sealedText: {
        fontSize: 13, color: colors.text.secondary, textAlign: 'center', fontStyle: 'italic', overflow: 'hidden',
        backgroundColor: colors.surface.subtle, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10,
    },
    sealedDetails: { fontSize: 12, color: colors.text.muted, textAlign: 'center', marginTop: 2 },
    row: {
        minHeight: 48, justifyContent: 'center', alignSelf: 'stretch', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12,
        backgroundColor: colors.surface.subtle,
    },
    rowText: { fontSize: 14, lineHeight: 20, color: colors.text.secondary, textAlign: 'center' },
});

function useStyles() {
    const { colors } = useTheme();
    return useMemo(() => makeStyles(colors), [colors]);
}

/** A sealed line drawn as nobody's: "Unverified" (it opened under neither key the node names) or still waiting for its key. */
export function SealedNoticeLine({ name, text, details }: { name: string | null; text: string; details: string | null }) {
    const styles = useStyles();
    return (
        <View style={styles.systemWrap} accessibilityRole="text">
            <Text style={styles.sealedText}>{name ? `${name}: ${text}` : text}</Text>
            {!!details && <Text style={styles.sealedDetails}>{details}</Text>}
        </View>
    );
}

/** §7: the one row the lines from before a phone change collapse into; quiet until tapped. */
export function LockedHistoryRow({ text, onPress }: { text: string; onPress: () => void }) {
    const styles = useStyles();
    return (
        <View style={styles.systemWrap}>
            <Pressable onPress={onPress} accessibilityRole="button" style={styles.row}>
                <Text style={styles.rowText}>{text}</Text>
            </Pressable>
        </View>
    );
}

/**
 * The sheet behind the row (§7): the two ways back and "Keep them locked". Its own rows, not ChatMenuSheet's: these
 * labels wrap at 320dp with 1.3× text, where a one-line menu label would be cut.
 */
export function LockedHistorySheet({ open, bottomInset, onClose, onWords, onAsk }: {
    open: boolean; bottomInset: number; onClose: () => void; onWords: () => void; onAsk: () => void;
}) {
    const theme = useTheme();
    const { colors } = theme;
    const styles = useMemo(() => makeChatStyles(theme), [theme]);
    const rows: [string, string, () => void][] = [
        ['form-textbox-password', LOCKED_HISTORY_WORDS, onWords],
        ['account-check-outline', LOCKED_HISTORY_ASK, onAsk],
        ['lock-outline', LOCKED_HISTORY_KEEP, onClose],
    ];
    return (
        <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
            <Pressable style={styles.menuBackdrop} onPress={onClose} accessibilityLabel="Close">
                <View style={[styles.menuSheet, { paddingBottom: Math.max(bottomInset, 12) }]}>
                    <Text style={[styles.menuTitle, { textTransform: 'none' }]}>{LOCKED_HISTORY_SHEET_TITLE}</Text>
                    {/* text.secondary, not menuHint's muted grey: 2.6:1 on the sheet in light, 3.6:1 in dark (e2e/locked-history-320.mjs). */}
                    <Text style={[styles.menuHint, { color: colors.text.secondary }]}>{LOCKED_HISTORY_SHEET_BODY}</Text>
                    {rows.map(([icon, label, onPress]) => (
                        <Pressable key={label} style={styles.menuRow} onPress={onPress} accessibilityRole="button">
                            <MaterialCommunityIcons name={icon as any} size={22} color={colors.text.body} />
                            <Text style={[styles.menuLabel, { paddingVertical: 8 }]}>{label}</Text>
                        </Pressable>
                    ))}
                </View>
            </Pressable>
        </Modal>
    );
}
