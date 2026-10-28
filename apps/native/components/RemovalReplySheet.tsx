import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, Modal, ActivityIndicator, Alert, StyleSheet, ScrollView } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { t } from '@beanpool/core';
import { replyToRemovalCase } from '../utils/db';
import { useTheme, useStyles, type ThemeContextType } from '../app/ThemeContext';
import { palette } from '../constants/colors';
import { signedRequestWords } from './signed-request-lines';

/** As long as the node takes a reply: as long as the case it answers may be (server decisions-engine REMOVAL_REPLY_MAX_CHARS). */
export const REMOVAL_REPLY_MAX_CHARS = 1000;

interface RemovalReplySheetProps {
    /** The vote on removing the member this phone belongs to; null keeps the sheet shut. */
    decisionId: string | null;
    /** Their reply as the node has it, to start a change from; null for a first reply. */
    current: string | null;
    onClose: () => void;
    /** After the node has taken the reply: read the votes again. */
    onSent: () => void | Promise<void>;
}

/**
 * The member a vote on removing them is about writes their reply to its case (removal by vote, Amendment A point 2): a
 * sheet over Decide, so the keyboard never hides the field in the Commons list. The node shows the reply beside the case
 * to everyone who reads the vote, and takes it from this member alone while the vote is open.
 */
export function RemovalReplySheet({ decisionId, current, onClose, onSent }: RemovalReplySheetProps) {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const [text, setText] = useState('');
    const [sending, setSending] = useState(false);

    useEffect(() => {
        if (decisionId) setText(current ?? '');
    }, [decisionId, current]);

    const send = async () => {
        if (!decisionId || !text.trim()) return;
        setSending(true);
        try {
            await replyToRemovalCase(decisionId, text.trim());
            await onSent();
            onClose();
        } catch (e: any) {
            Alert.alert(t('Error'), e?.message ? signedRequestWords(e.message) : t('Your reply could not be sent.'));
        } finally {
            setSending(false);
        }
    };

    const canSend = !!text.trim() && !sending;
    return (
        <Modal visible={!!decisionId} transparent animationType="slide" onRequestClose={() => { if (!sending) onClose(); }}>
            <KeyboardAvoidingView style={styles.overlay} behavior="padding">
                <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                    <View style={styles.card} testID="removal-reply-sheet">
                        <Text style={styles.title} accessibilityRole="header">{current ? t('Change your reply') : t('Reply to this case')}</Text>
                        <Text style={styles.hint}>{t('Everyone who reads this vote sees your reply beside the case.')}</Text>
                        <TextInput
                            style={styles.input}
                            accessibilityLabel={current ? t('Change your reply') : t('Reply to this case')}
                            placeholderTextColor={colors.text.muted}
                            multiline
                            maxLength={REMOVAL_REPLY_MAX_CHARS}
                            value={text}
                            onChangeText={setText}
                            testID="removal-reply-input"
                        />
                        <View style={styles.buttonRow}>
                            <Pressable style={styles.cancelBtn} accessibilityRole="button" accessibilityState={{ disabled: sending }} onPress={onClose} disabled={sending}>
                                <Text style={styles.cancelText}>{t('Cancel')}</Text>
                            </Pressable>
                            <Pressable
                                style={[styles.sendBtn, !canSend && styles.btnDisabled]}
                                accessibilityRole="button"
                                accessibilityLabel={sending ? t('Sending...') : t('Send reply')}
                                accessibilityState={{ disabled: !canSend, busy: sending }}
                                onPress={send}
                                disabled={!canSend}
                                testID="removal-reply-send"
                            >
                                {sending ? <ActivityIndicator size="small" color={colors.text.onBrand} /> : <Text style={styles.sendText}>{t('Send reply')}</Text>}
                            </Pressable>
                        </View>
                    </View>
                </ScrollView>
            </KeyboardAvoidingView>
        </Modal>
    );
}

const makeStyles = ({ colors, theme }: ThemeContextType) => StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
    scrollContent: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
    card: { backgroundColor: colors.surface.card, borderRadius: 24, padding: 20, width: '100%', gap: 12 },
    title: { fontSize: 18, fontWeight: '900', color: colors.text.heading },
    hint: { fontSize: 14, color: theme === 'dark' ? colors.text.secondary : palette.gray600 },
    input: {
        width: '100%', backgroundColor: colors.surface.app, borderWidth: 1, borderColor: colors.border.default, borderRadius: 12,
        padding: 12, fontSize: 15, minHeight: 120, maxHeight: 260, textAlignVertical: 'top', color: colors.text.body,
    },
    buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, width: '100%' },
    cancelBtn: { flexGrow: 1, minHeight: 44, backgroundColor: colors.surface.subtle, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    cancelText: { fontWeight: '700', color: theme === 'dark' ? colors.text.secondary : palette.gray600, fontSize: 14 },
    sendBtn: { flexGrow: 1.5, minHeight: 44, backgroundColor: colors.brand.fill, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    sendText: { fontWeight: '800', color: colors.text.onBrand, fontSize: 14 },
    btnDisabled: { opacity: 0.5 },
});
