import React from 'react';
import { View, Text, Pressable, Modal, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { HelpSheet as HelpSheetWords } from '@beanpool/core';
import type { AppColors } from '../constants/colors';
import { editHomeStyles } from './home/EditHomeSheet';

/**
 * The "?"'s sheet (scratch/global-node/DESIGN-getting-started-fable.md §4): the guide page for the screen the member is
 * on (its title and its `help:` line, else its summary, else its section's), then Read the guide page ›, Search the
 * guide, and Take the tour again (Pick up the tour while one is open). With no words it still has Search and the tour:
 * the "?" is never dead and never says "no help here". Drawn in Add a card's frame.
 */
export function HelpSheet({ visible, sheet, tourOpen, canTour, colors, onReadPage, onSearch, onTour, onClose }: {
    visible: boolean;
    sheet: HelpSheetWords;
    /** A tour is running: the last row says Pick up the tour. */
    tourOpen: boolean;
    /** A member's phone (a guest has no account to keep the tour on): the tour row shows. */
    canTour: boolean;
    colors: AppColors;
    onReadPage: () => void;
    onSearch: () => void;
    onTour: () => void;
    onClose: () => void;
}) {
    const insets = useSafeAreaInsets();
    const row = (label: string, onPress: () => void, testID: string, a11y: string) => (
        <Pressable
            onPress={onPress}
            style={[helpStyles.row, { borderBottomColor: colors.border.default }]}
            accessibilityRole="button"
            accessibilityLabel={a11y}
            testID={testID}
        >
            <Text style={[helpStyles.rowText, { color: colors.text.link }]}>{label}</Text>
        </Pressable>
    );
    return (
        <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose} statusBarTranslucent>
            <View style={editHomeStyles.backdrop}>
                <View style={[editHomeStyles.sheet, helpStyles.sheet, { backgroundColor: colors.surface.card, paddingBottom: 12 + insets.bottom }]} testID="help-sheet">
                    <View style={editHomeStyles.head}>
                        <Text style={[editHomeStyles.title, { color: colors.text.heading }]} accessibilityRole="header" testID="help-title">
                            {sheet.title ?? 'Help'}
                        </Text>
                        <Pressable onPress={onClose} style={editHomeStyles.done} accessibilityRole="button" accessibilityLabel="Close help" testID="help-close">
                            <Text style={[editHomeStyles.doneText, { color: colors.text.link }]}>Close</Text>
                        </Pressable>
                    </View>
                    <View style={helpStyles.body}>
                        {!!sheet.text && <Text style={[helpStyles.text, { color: colors.text.body }]} testID="help-text">{sheet.text}</Text>}
                        <View style={[helpStyles.rows, { borderTopColor: colors.border.default }]}>
                            {(sheet.slug || sheet.section) && row('Read the guide page ›', onReadPage, 'help-read-page', `Read the guide page: ${sheet.title ?? ''}`)}
                            {row('Search the guide', onSearch, 'help-search', 'Search the guide')}
                            {canTour && row(tourOpen ? 'Pick up the tour' : 'Take the tour again', onTour, 'help-tour', tourOpen ? 'Pick up the tour' : 'Take the tour again')}
                        </View>
                    </View>
                </View>
            </View>
        </Modal>
    );
}

export const helpStyles = StyleSheet.create({
    sheet: { flexGrow: 0, flexShrink: 1 },
    body: { paddingHorizontal: 16, paddingBottom: 8 },
    text: { fontSize: 15, lineHeight: 22, marginBottom: 12 },
    rows: { borderTopWidth: StyleSheet.hairlineWidth },
    row: { minHeight: 48, justifyContent: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
    rowText: { fontSize: 15, fontWeight: '700' },
});
