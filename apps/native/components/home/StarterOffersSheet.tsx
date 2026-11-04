import React from 'react';
import { View, Text, Pressable, Modal, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { t, type StarterRow, type StarterSheet } from '@beanpool/core';
import type { AppColors } from '../../constants/colors';
import { HomeRow } from './HomeParts';
import { sheetStyles } from './sheet-parts';

/**
 * What could you offer? (scratch/fable-design/DESIGN-cold-start-trades-fable.md §3.1, slice O2): what "Post your first
 * Offer" on First steps opens. Three rows drawn from the categories the member starred (core `starterSheet`), each a title
 * and, where Beans show, its price from the community's guide; a tap opens the composer with that draft filled in
 * (tools/doors.ts `openStarterOffer`). "Something else" is the blank composer, and Cancel is always there.
 *
 * It is a door, not a form: nothing is posted, saved or sent here, and it never says so. The photo, the place and Post are
 * the composer's and the member's (market-photos-mandatory). It asks for no device permission and has no input, so there
 * is no keyboard to lift. Built from the sheets' shared parts like the picker and the tools' List sheet; the rows are
 * Home's own, so they hold at 320 dp with the text at 1.3x.
 */
export function StarterOffersSheet({ visible, sheet, colors, onPick, onOther, onClose }: {
    visible: boolean;
    /** The rows and words, in the member's language (core `starterSheet`); null while the sheet is shut. */
    sheet: StarterSheet | null;
    colors: AppColors;
    onPick: (row: StarterRow) => void;
    /** "Something else": the blank composer. */
    onOther: () => void;
    onClose: () => void;
}) {
    const insets = useSafeAreaInsets();
    const chevron = <MaterialCommunityIcons name="chevron-right" size={22} color={colors.text.secondary} />;
    return (
        <Modal visible={visible && !!sheet} animationType="slide" transparent onRequestClose={onClose} statusBarTranslucent>
            <View style={sheetStyles.backdrop}>
                <View style={[sheetStyles.sheet, { backgroundColor: colors.surface.card, paddingBottom: 12 + insets.bottom, marginTop: insets.top + 24 }]} testID="starter-offers-sheet">
                    <View style={sheetStyles.head}>
                        <Text style={[sheetStyles.title, { color: colors.text.heading }]} accessibilityRole="header" numberOfLines={3} testID="starter-offers-title">{sheet?.title ?? ''}</Text>
                        <Pressable onPress={onClose} style={sheetStyles.done} accessibilityRole="button" accessibilityLabel={t('Cancel')} testID="starter-offers-cancel">
                            <Text style={[sheetStyles.doneText, { color: colors.text.link }]}>{t('Cancel')}</Text>
                        </Pressable>
                    </View>
                    <ScrollView contentContainerStyle={sheetStyles.list}>
                        <Text style={[sheetStyles.note, { color: colors.text.secondary }]} testID="starter-offers-note">{sheet?.note ?? ''}</Text>
                        <View style={[starter.group, { borderColor: colors.border.default }]}>
                            {(sheet?.rows ?? []).map((row) => (
                                <View key={row.id} style={[starter.line, { borderBottomColor: colors.border.default }]}>
                                    <HomeRow
                                        colors={colors}
                                        text={row.title}
                                        lines={3}
                                        strong
                                        sub={row.price}
                                        a11y={row.label}
                                        onPress={() => onPick(row)}
                                        left={<Text style={[starter.icon, { color: colors.text.body }]} accessibilityElementsHidden importantForAccessibility="no">{row.emoji}</Text>}
                                        right={chevron}
                                        testID={`starter-offer-${row.id}`}
                                    />
                                </View>
                            ))}
                            {sheet ? (
                                <HomeRow
                                    colors={colors}
                                    text={sheet.other.title}
                                    lines={3}
                                    strong
                                    a11y={sheet.other.label}
                                    onPress={onOther}
                                    left={<Text style={[starter.icon, { color: colors.text.body }]} accessibilityElementsHidden importantForAccessibility="no">✏️</Text>}
                                    right={chevron}
                                    testID="starter-offer-other"
                                />
                            ) : null}
                        </View>
                    </ScrollView>
                </View>
            </View>
        </Modal>
    );
}

/** Exported for the layout checks at 320dp (utils/__tests__/home-layout-320.test.ts). */
export const starter = StyleSheet.create({
    group: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12 },
    line: { borderBottomWidth: StyleSheet.hairlineWidth },
    icon: { fontSize: 22, width: 32, textAlign: 'center', flexShrink: 0 },
});
