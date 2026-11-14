/**
 * The chooser behind every + in the app: Offer / Need / Community Poll / Event, and 📖 Local knowledge where Learn is live
 * (slice K4: its choice opens Learn's form, a screen of its own, app/learn/new.tsx).
 *
 * Extracted from the Market tab, where it was inline — which is how the map's + came to open an
 * Offer/Need-only sheet while the Market tab offered four types. One component, one list
 * (`NEW_POST_TYPES`), so the two entry points cannot drift apart again.
 *
 * A phone with no account, looking around (slice S12, utils/look-around.ts), has nothing to post with: the sheet says so
 * and offers **Join to post**, the door, where the key is made.
 */

import React from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { t } from '@beanpool/core';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { composeOptionA11yLabel, composeOptions, composeTargetFor, type ComposePostType } from '../utils/compose-options';
import { useAfterDismiss } from '../utils/screen-presented';
import { useIdentity } from '../app/IdentityContext';
import { openLookDoor } from '../utils/look-door';
import { useLearnMode } from '../utils/use-learn-mode';

interface NewPostTypeSheetProps {
    visible: boolean;
    /** The chooser is closing. `choosing` is true when a choice is behind the close (onSelect follows), so a screen that leaves when its chooser is cancelled can tell the two apart. */
    onClose: (choosing?: boolean) => void;
    /**
     * A choice. The chooser has been asked to close first. A Poll or Event is a Modal of its own, and on iOS a Modal cannot
     * open while another is still closing (UIKit drops it; React Native never retries): so there that choice arrives once the
     * chooser has gone (its `onDismiss`, or after AFTER_DISMISS_FALLBACK_MS if that never comes). Everywhere else, and for an
     * Offer or a Need (a view in the screen, whose alerts open in a window of their own), it arrives at once.
     */
    onSelect: (type: ComposePostType) => void;
    /** The Modal has actually been shown. On iOS a Modal asked for mid-presentation is refused and this never fires (utils/screen-presented.ts). */
    onShow?: () => void;
}

export function NewPostTypeSheet({ visible, onClose, onSelect, onShow }: NewPostTypeSheetProps) {
    const styles = useStyles(makeStyles);
    const { identity } = useIdentity();
    const afterClose = useAfterDismiss<ComposePostType>((type) => onSelect(type));
    const pick = (type: ComposePostType) => {
        onClose(true);
        if (Platform.OS === 'ios' && composeTargetFor(type) !== 'offer-need-form') afterClose.hold(type);
        else onSelect(type);
    };

    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            onRequestClose={() => onClose()}
            onShow={onShow}
            onDismiss={afterClose.release}
        >
            <Pressable style={styles.actionSheetBackdrop} accessibilityRole="button" accessibilityLabel={t('Close create post sheet')} onPress={() => onClose()}>
                <Pressable style={styles.actionSheetContainer} onPress={(e) => e.stopPropagation()}>
                    <Text style={styles.actionSheetTitle}>{t('Create New Post')}</Text>
                    <Text style={styles.actionSheetSubtitle}>{identity ? t('What would you like to share with the village?') : t("You're looking around as a visitor. Nothing is saved until you join.")}</Text>

                    {!identity && (
                        <Pressable
                            style={styles.joinToPost}
                            accessibilityRole="button"
                            onPress={() => {
                                onClose();
                                openLookDoor();
                            }}
                            testID="new-post-join"
                        >
                            <Text style={styles.joinToPostText}>{t('Join to post')}</Text>
                        </Pressable>
                    )}

                    {identity && <ChoiceRows styles={styles} pick={pick} />}

                    <Pressable
                        style={styles.actionSheetCancel}
                        accessibilityRole="button"
                        accessibilityLabel={t('Cancel')}
                        onPress={() => onClose()}
                    >
                        <Text style={styles.actionSheetCancelText}>{t('Cancel')}</Text>
                    </Pressable>
                </Pressable>
            </Pressable>
        </Modal>
    );
}

/**
 * The choices, in their order: the four kinds, and 📖 Local knowledge after them where Learn is live here (slice K4). Drawn
 * inside the sheet, so the community's switches are read only while it is open, never by a screen that merely holds it.
 */
function ChoiceRows({ styles, pick }: { styles: ReturnType<typeof makeStyles>; pick: (type: ComposePostType) => void }) {
    const options = composeOptions({ learn: useLearnMode() === 'live' });
    return (
        <>
            {options.map((option, i) => (
                <Pressable
                    key={option.id}
                    style={[styles.actionSheetOption, i === options.length - 1 && { borderBottomWidth: 0 }]}
                    accessibilityRole="button"
                    accessibilityLabel={composeOptionA11yLabel(option)}
                    onPress={() => pick(option.id)}
                >
                    <Text style={styles.actionSheetEmoji}>{option.emoji}</Text>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.actionSheetOptionTitle}>{t(option.title)}</Text>
                        <Text style={styles.actionSheetOptionDesc}>{t(option.description)}</Text>
                    </View>
                </Pressable>
            ))}
        </>
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
    joinToPost: {
        minHeight: 48,
        backgroundColor: colors.brand.fill,
        borderRadius: 12,
        paddingVertical: 12,
        paddingHorizontal: 16,
        alignItems: 'center',
        justifyContent: 'center',
    },
    joinToPostText: {
        color: colors.text.inverse,
        fontSize: 16,
        fontWeight: '800',
        textAlign: 'center',
    },
    actionSheetCancel: {
        marginTop: 16,
        minHeight: 48,
        backgroundColor: theme === 'dark' ? '#374151' : '#f3f4f6',
        borderRadius: 12,
        paddingVertical: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    actionSheetCancelText: {
        fontSize: 15,
        fontWeight: '700',
        color: colors.text.body,
    },
});
