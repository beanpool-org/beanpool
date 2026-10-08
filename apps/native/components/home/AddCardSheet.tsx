import React from 'react';
import { View, Text, Pressable, Modal, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AppColors } from '../../constants/colors';
import type { PickerGroup, PickerRow } from '../../utils/home-cards';
import { HOME_TARGET_DP } from './HomeParts';
import { editHomeStyles } from './EditHomeSheet';

/** The picker's note, and the one it says when Home holds 24 cards (CARD-FRAME §1.2). */
export const ADD_CARD_NOTE = 'Pick a card to put on Home. You can move or remove it any time.';
export const ADD_CARD_FULL_NOTE = 'Home is full: remove a card to add one.';

/**
 * Add a card (scratch/home/CARD-FRAME-DESIGN-fable.md §1.2): every card type this node can show and this build draws, in
 * three groups (For you · Around you · Getting started), one row each with its name, one line of what it shows, and an
 * Add button. A one-of-a-kind card already on Home says "On Home" (plain words, not a target, never greyed as locked);
 * an instance type says "2 of 5 on Home" and loses its Add at its limit. A type with settings opens its settings sheet
 * on Add ({@link onAdd} decides). Built from Edit home's parts, so the floating button never floats over it.
 */
export function AddCardSheet({ visible, groups, full, colors, onAdd, onClose }: {
    visible: boolean;
    groups: readonly PickerGroup[];
    full: boolean;
    colors: AppColors;
    onAdd: (row: PickerRow) => void;
    onClose: () => void;
}) {
    const insets = useSafeAreaInsets();
    const row = (r: PickerRow, last: boolean) => (
        <View key={r.type} style={[addCardStyles.row, !last && { borderBottomColor: colors.border.default, borderBottomWidth: StyleSheet.hairlineWidth }]} testID={`add-card-${r.type}`}>
            <View style={addCardStyles.rowText}>
                <Text style={[addCardStyles.name, { color: colors.text.heading }]} numberOfLines={2}>{r.name}</Text>
                <Text style={[addCardStyles.line, { color: colors.text.secondary }]} numberOfLines={2}>{r.line}</Text>
                {!!r.count && <Text style={[addCardStyles.line, { color: colors.text.secondary }]} testID={`add-card-${r.type}-count`}>{r.count}</Text>}
                {!!r.status && <Text style={[addCardStyles.line, { color: colors.text.secondary }]} testID={`add-card-${r.type}-status`}>{r.status}</Text>}
            </View>
            {r.state === 'add' ? (
                <Pressable
                    onPress={() => onAdd(r)}
                    style={({ pressed }) => [addCardStyles.add, { backgroundColor: colors.brand.primary }, pressed && { opacity: 0.85 }]}
                    accessibilityRole="button"
                    accessibilityLabel={`Add ${r.name} to Home`}
                    testID={`add-card-${r.type}-add`}
                >
                    <Text style={[addCardStyles.addText, { color: colors.text.inverse }]}>Add</Text>
                </Pressable>
            ) : r.state === 'on-home' ? (
                <Text style={[addCardStyles.onHome, { color: colors.text.secondary }]} accessibilityLabel={`${r.name} is already on Home`} testID={`add-card-${r.type}-on-home`}>On Home</Text>
            ) : null}
        </View>
    );

    return (
        <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose} statusBarTranslucent>
            <View style={editHomeStyles.backdrop}>
                <View style={[editHomeStyles.sheet, { backgroundColor: colors.surface.card, paddingBottom: 12 + insets.bottom, marginTop: insets.top + 24 }]} testID="add-card-sheet">
                    <View style={editHomeStyles.head}>
                        <Text style={[editHomeStyles.title, { color: colors.text.heading }]} accessibilityRole="header">Add a card</Text>
                        <Pressable onPress={onClose} style={editHomeStyles.done} accessibilityRole="button" accessibilityLabel="Done adding cards" testID="add-card-done">
                            <Text style={[editHomeStyles.doneText, { color: colors.text.link }]}>Done</Text>
                        </Pressable>
                    </View>
                    <ScrollView contentContainerStyle={editHomeStyles.list}>
                        <Text style={[editHomeStyles.note, { color: colors.text.secondary }]} testID="add-card-note">{full ? ADD_CARD_FULL_NOTE : ADD_CARD_NOTE}</Text>
                        {groups.map(g => (
                            <View key={g.id}>
                                <Text style={[editHomeStyles.section, { color: colors.text.secondary }]} accessibilityRole="header" accessibilityLabel={g.name} testID={`add-card-group-${g.id}`}>{g.name}</Text>
                                <View style={[addCardStyles.group, { borderColor: colors.border.default }]}>
                                    {g.rows.map((r, i) => row(r, i === g.rows.length - 1))}
                                </View>
                            </View>
                        ))}
                    </ScrollView>
                </View>
            </View>
        </Modal>
    );
}

/** Exported for the layout checks at 320dp (utils/__tests__/home-layout-320.test.ts). */
export const addCardStyles = StyleSheet.create({
    group: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12 },
    row: { flexDirection: 'row', alignItems: 'center', minHeight: HOME_TARGET_DP + 8, gap: 8, paddingVertical: 6 },
    rowText: { flex: 1, minWidth: 0 },
    name: { fontSize: 15, fontWeight: '700' },
    line: { fontSize: 13, lineHeight: 18, marginTop: 1 },
    add: { minHeight: HOME_TARGET_DP, minWidth: HOME_TARGET_DP + 16, paddingHorizontal: 14, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    addText: { fontSize: 14, fontWeight: '700' },
    onHome: { fontSize: 13, fontWeight: '600', flexShrink: 0 },
});
