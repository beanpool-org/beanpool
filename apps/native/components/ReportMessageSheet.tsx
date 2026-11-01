/**
 * Report one message of a locked group chat (group chat photos S6), from the message's actions. The DM report box's
 * reasons and words (ReportReasonBox), above one sentence that says what the moderators get: this message, its photo
 * when it has one, and who sent it, opened by its own key, and nothing else of the chat (the key opens only it).
 *
 * Keyboard: lifted by useModalKeyboardLift from the root provider's state, NO nested KeyboardProvider inside this Modal
 * (memory keyboard-avoidance-pattern); the sheet scrolls, so at 320dp with 1.3× text Submit is always reachable.
 */
import React from 'react';
import { Modal, View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { t } from '@beanpool/core';
import { useTheme, useStyles } from '../app/ThemeContext';
import { useModalKeyboardLift } from './useModalKeyboardLift';
import { ReportReasonBox } from './ReportReasonBox';

export function ReportMessageSheet({ isOpen, photo, blocks, onSubmit, onClose }: {
    isOpen: boolean;
    /** The message is a photo line whose photo goes with it (a group chat's; a direct message's stays sealed). */
    photo: boolean;
    /** Report on a message request: it blocks its sender too. */
    blocks?: boolean;
    /** Sends the report with the reason as it goes to the node; says why a send failed, then throws (the box keeps the words). */
    onSubmit: (reason: string) => Promise<void>;
    onClose: () => void;
}) {
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();
    const lift = useModalKeyboardLift(insets.top + 8, 0.92);
    const styles = useStyles(({ colors }) => StyleSheet.create({
        backdrop: { flex: 1, backgroundColor: colors.overlay.scrim, justifyContent: 'flex-end' },
        sheet: { backgroundColor: colors.surface.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, flexShrink: 1 },
        header: {
            flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 4, paddingVertical: 6,
            borderBottomWidth: 1, borderBottomColor: colors.border.default,
        },
        title: { flex: 1, minWidth: 0, fontSize: 18, fontWeight: '800', color: colors.text.heading },
        closeBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
        body: { paddingHorizontal: 16, paddingTop: 12 },
        shared: { fontSize: 14, lineHeight: 20, color: colors.text.body },
    }));

    return (
        <Modal visible={isOpen} animationType="slide" transparent onRequestClose={onClose}>
            <View style={[styles.backdrop, { paddingTop: insets.top + 8 }]}>
                <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12), maxHeight: lift.maxHeight, marginBottom: lift.lift }]}>
                    <View style={styles.header}>
                        <Text style={styles.title} numberOfLines={2} accessibilityRole="header">{t('Report this message')}</Text>
                        <Pressable accessibilityRole="button" accessibilityLabel={t('Close')} onPress={onClose} style={styles.closeBtn}>
                            <MaterialCommunityIcons name="close" size={24} color={colors.text.muted} />
                        </Pressable>
                    </View>
                    <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
                        <Text style={styles.shared}>
                            {photo
                                ? t("This community's moderators will see this one message, its photo and who sent it. Nothing else in this chat is shared with them.")
                                : t("This community's moderators will see this one message and who sent it. Nothing else in this chat is shared with them.")}
                            {blocks ? ` ${t('Reporting a request blocks its sender too.')}` : ''}
                        </Text>
                        <ReportReasonBox onSubmit={onSubmit} onCancel={onClose} />
                    </ScrollView>
                </View>
            </View>
        </Modal>
    );
}
