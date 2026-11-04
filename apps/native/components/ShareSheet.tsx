/**
 * The sheet one Share button opens (DESIGN-detail-pages-fable.md §2.5, slice DP2; Marty, 4 Nov: "All Fable's picks", question
 * 3): the ways to share, each with its sentence under its name, so every sentence still shows before the tap that shares, one
 * tap in. It draws; it decides nothing. What the items are, and what a tap does, is components/SharePost.tsx ShareButton's
 * (core shareSays). A body (the invite panel) can take the items' place.
 *
 * The calendar choice's sheet (components/EventExtras.tsx): a Modal over a dimmed backdrop, a card from the foot with the
 * bottom inset under it, items 52 dp tall, and Cancel.
 */
import React from 'react';
import { View, Text, StyleSheet, Pressable, Modal } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '@beanpool/core';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';

export interface ShareSheetItem {
    key: string;
    label: string;
    /** The sentence under the name: what the link does. None where there is nothing to say (an open door). */
    line?: string | null;
    onPress: () => void;
    busy?: boolean;
    testID: string;
    lineTestID?: string;
    expanded?: boolean;
}

export function ShareSheet({ visible, onClose, onDismiss, items, body, testID = 'share-sheet' }: {
    visible: boolean;
    onClose: () => void;
    /** iOS: once the sheet is gone, so another sheet (the ask form) can open after it. */
    onDismiss?: () => void;
    items: ShareSheetItem[];
    /** Drawn under the items (the invite panel), in the same card. */
    body?: React.ReactNode;
    testID?: string;
}) {
    const insets = useSafeAreaInsets();
    const styles = useStyles(makeStyles);
    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} onDismiss={onDismiss} statusBarTranslucent>
            <View style={styles.backdrop}>
                <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('Close')} />
                <View style={[styles.card, { paddingBottom: 16 + insets.bottom }]} testID={testID}>
                    <Text style={styles.title} accessibilityRole="header" maxFontSizeMultiplier={1.3}>{t('Share')}</Text>
                    {items.map((item) => (
                        <Pressable
                            key={item.key}
                            onPress={item.onPress}
                            disabled={item.busy}
                            style={({ pressed }) => [styles.item, (pressed || item.expanded) && styles.itemPressed, item.busy && styles.itemBusy]}
                            accessibilityRole="button"
                            accessibilityState={{ busy: !!item.busy, disabled: !!item.busy, ...(item.expanded !== undefined ? { expanded: item.expanded } : {}) }}
                            testID={item.testID}
                        >
                            <Text style={styles.itemText} maxFontSizeMultiplier={1.3}>{item.label}</Text>
                            {item.line ? <Text style={styles.itemLine} maxFontSizeMultiplier={1.3} testID={item.lineTestID}>{item.line}</Text> : null}
                        </Pressable>
                    ))}
                    {body}
                    <Pressable onPress={onClose} style={({ pressed }) => [styles.cancel, pressed && styles.itemPressed]} accessibilityRole="button" testID={`${testID}-cancel`}>
                        <Text style={styles.cancelText} numberOfLines={1} maxFontSizeMultiplier={1.3}>{t('Cancel')}</Text>
                    </Pressable>
                </View>
            </View>
        </Modal>
    );
}

const makeStyles = ({ colors }: ThemeContextType) => StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
    card: { backgroundColor: colors.surface.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 16, paddingHorizontal: 16 },
    title: { fontSize: 16, fontWeight: '800', color: colors.text.heading, marginBottom: 12, paddingHorizontal: 4 },
    item: {
        minHeight: 52, justifyContent: 'center', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1,
        borderColor: colors.border.default, marginBottom: 8, backgroundColor: colors.surface.card,
    },
    itemPressed: { backgroundColor: colors.surface.subtle },
    itemBusy: { opacity: 0.6 },
    itemText: { fontSize: 15, fontWeight: '700', color: colors.text.heading },
    itemLine: { fontSize: 13, lineHeight: 18, fontWeight: '500', color: colors.text.secondary, marginTop: 2 },
    cancel: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 12, marginTop: 4 },
    cancelText: { fontSize: 15, fontWeight: '700', color: colors.text.body },
});
