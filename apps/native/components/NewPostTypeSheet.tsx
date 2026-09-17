/**
 * The chooser behind every + in the app: Offer / Need / Community Poll / Event.
 *
 * Extracted from the Market tab, where it was inline — which is how the map's + came to open an
 * Offer/Need-only sheet while the Market tab offered four types. One component, one list
 * (`NEW_POST_TYPES`), so the two entry points cannot drift apart again.
 */

import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { NEW_POST_TYPES, composeOptionA11yLabel, type ComposePostType } from '../utils/compose-options';

interface NewPostTypeSheetProps {
    visible: boolean;
    onClose: () => void;
    /** The chooser closes itself before this runs, so the chosen form opens over a clear screen. */
    onSelect: (type: ComposePostType) => void;
}

export function NewPostTypeSheet({ visible, onClose, onSelect }: NewPostTypeSheetProps) {
    const styles = useStyles(makeStyles);

    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            onRequestClose={onClose}
        >
            <Pressable style={styles.actionSheetBackdrop} onPress={onClose}>
                <Pressable style={styles.actionSheetContainer} onPress={(e) => e.stopPropagation()}>
                    <Text style={styles.actionSheetTitle}>Create New Post</Text>
                    <Text style={styles.actionSheetSubtitle}>What would you like to share with the village?</Text>

                    {NEW_POST_TYPES.map((option, i) => (
                        <Pressable
                            key={option.id}
                            style={[styles.actionSheetOption, i === NEW_POST_TYPES.length - 1 && { borderBottomWidth: 0 }]}
                            accessibilityRole="button"
                            accessibilityLabel={composeOptionA11yLabel(option)}
                            onPress={() => {
                                onClose();
                                onSelect(option.id);
                            }}
                        >
                            <Text style={styles.actionSheetEmoji}>{option.emoji}</Text>
                            <View style={{ flex: 1 }}>
                                <Text style={styles.actionSheetOptionTitle}>{option.title}</Text>
                                <Text style={styles.actionSheetOptionDesc}>{option.description}</Text>
                            </View>
                        </Pressable>
                    ))}

                    <Pressable
                        style={styles.actionSheetCancel}
                        accessibilityRole="button"
                        accessibilityLabel="Cancel"
                        onPress={onClose}
                    >
                        <Text style={styles.actionSheetCancelText}>Cancel</Text>
                    </Pressable>
                </Pressable>
            </Pressable>
        </Modal>
    );
}

const makeStyles = ({ theme, colors }: ThemeContextType) => StyleSheet.create({
    actionSheetBackdrop: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        justifyContent: 'flex-end',
    },
    actionSheetContainer: {
        backgroundColor: colors.surface.card,
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        padding: 20,
        paddingBottom: 36,
    },
    actionSheetTitle: {
        fontSize: 18,
        fontWeight: '800',
        color: colors.text.body,
        marginBottom: 4,
    },
    actionSheetSubtitle: {
        fontSize: 13,
        color: colors.text.secondary,
        marginBottom: 16,
    },
    actionSheetOption: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 14,
        borderBottomWidth: 1,
        borderBottomColor: theme === 'dark' ? '#374151' : '#f3f4f6',
        gap: 14,
    },
    actionSheetEmoji: {
        fontSize: 26,
    },
    actionSheetOptionTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: colors.text.body,
    },
    actionSheetOptionDesc: {
        fontSize: 12,
        color: colors.text.secondary,
        marginTop: 2,
    },
    actionSheetCancel: {
        marginTop: 16,
        backgroundColor: theme === 'dark' ? '#374151' : '#f3f4f6',
        borderRadius: 12,
        paddingVertical: 12,
        alignItems: 'center',
    },
    actionSheetCancelText: {
        fontSize: 15,
        fontWeight: '700',
        color: colors.text.body,
    },
});
