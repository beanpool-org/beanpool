/**
 * PinSheet — The sheet for pinning a post for 1 day, 3 days, or 1 week (DESIGN-pinning-fable.md §0.2, §2.5, §2.12).
 *
 * Tap targets are 48 dp minimum. Central tokens only. Node's refusal shown in words via Alert.
 */

import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View, ActivityIndicator, Alert } from 'react-native';
import { t, PIN_CHOICES, type PinDays } from '@beanpool/core';
import { useStyles, useTheme, type ThemeContextType } from '../app/ThemeContext';
import { pinPostOnNode } from '../utils/db';

export interface PinSheetProps {
    visible: boolean;
    postId: string;
    onClose: () => void;
    onPinned?: () => void;
}

export function PinSheet({ visible, postId, onClose, onPinned }: PinSheetProps) {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const [submitting, setSubmitting] = useState(false);

    const handlePin = async (days: PinDays) => {
        if (submitting) return;
        setSubmitting(true);
        try {
            await pinPostOnNode(postId, days);
            onPinned?.();
            onClose();
        } catch (err: any) {
            Alert.alert(t('Error'), err?.message || t('Failed to pin post'));
        } finally {
            setSubmitting(false);
        }
    };

    const choices: { days: PinDays; label: string }[] = [
        { days: 1, label: t('For 1 day') },
        { days: 3, label: t('For 3 days') },
        { days: 7, label: t('For 1 week') },
    ];

    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            onRequestClose={onClose}
        >
            <Pressable
                style={styles.backdrop}
                accessibilityRole="button"
                accessibilityLabel={t('Close')}
                onPress={onClose}
            >
                <Pressable style={styles.sheet} onPress={e => e.stopPropagation()}>
                    <Text style={styles.title}>{t('Pin to the top')}</Text>
                    <Text style={styles.subtitle}>{t('Choose how long to pin this post to the top of the Market:')}</Text>

                    {submitting ? (
                        <View style={styles.loadingContainer}>
                            <ActivityIndicator size="small" color={colors.brand.primary} />
                        </View>
                    ) : (
                        <View style={styles.optionsList}>
                            {choices.map(c => (
                                <Pressable
                                    key={c.days}
                                    style={styles.optionRow}
                                    accessibilityRole="button"
                                    accessibilityLabel={c.label}
                                    onPress={() => handlePin(c.days)}
                                    testID={`pin-choice-${c.days}`}
                                >
                                    <Text style={styles.optionText}>{c.label}</Text>
                                </Pressable>
                            ))}
                        </View>
                    )}

                    <Pressable
                        style={styles.cancelBtn}
                        accessibilityRole="button"
                        accessibilityLabel={t('Cancel')}
                        onPress={onClose}
                        testID="pin-sheet-cancel"
                    >
                        <Text style={styles.cancelText}>{t('Cancel')}</Text>
                    </Pressable>
                </Pressable>
            </Pressable>
        </Modal>
    );
}

const makeStyles = ({ colors }: ThemeContextType) => StyleSheet.create({
    backdrop: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        justifyContent: 'flex-end',
    },
    sheet: {
        backgroundColor: colors.surface.card,
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        padding: 20,
        paddingBottom: 36,
    },
    title: {
        fontSize: 18,
        fontWeight: '800',
        color: colors.text.heading,
        marginBottom: 6,
    },
    subtitle: {
        fontSize: 13,
        color: colors.text.secondary,
        marginBottom: 16,
        lineHeight: 18,
    },
    optionsList: {
        marginBottom: 12,
    },
    optionRow: {
        minHeight: 48,
        justifyContent: 'center',
        paddingVertical: 12,
        paddingHorizontal: 8,
        borderBottomWidth: 1,
        borderBottomColor: colors.border.default,
    },
    optionText: {
        fontSize: 16,
        fontWeight: '600',
        color: colors.text.body,
    },
    loadingContainer: {
        minHeight: 144,
        justifyContent: 'center',
        alignItems: 'center',
    },
    cancelBtn: {
        minHeight: 48,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: colors.surface.subtle,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: colors.border.default,
        marginTop: 8,
    },
    cancelText: {
        fontSize: 15,
        fontWeight: '700',
        color: colors.text.secondary,
    },
});
