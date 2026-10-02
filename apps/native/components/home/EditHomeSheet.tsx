import React from 'react';
import { View, Text, Pressable, Modal, ScrollView, Switch, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AppColors } from '../../constants/colors';
import {
    HOME_CARD_NAMES, canMoveCard, cardOnNode, cardOrder, hideCard, isHidden, marketCaption, moveCard, resetLayout, showCard,
    type HomeAnswer, type HomeCardId, type HomeLayout, type HomeRole,
} from '../../utils/home-cards';
import { HOME_TARGET_DP } from './HomeParts';

/**
 * Edit home (design §4.1): every card with a switch and up/down arrows, the hidden ones greyed under "Hidden" so they come
 * back, and Reset to defaults. Nothing is dragged (fragile on old Android, poor with large text and a screen reader) and
 * nothing is typed. Needs you stays at the top and the community's card at the bottom: they are not in the list. Only the
 * cards this node can show are offered (utils/home-cards.ts `cardOnNode`): no money cards on the global node, and no Grow
 * your community where only the community's admins invite and the member is not one. A pinned card (Find your community,
 * a member's first 30 days on the global node) is not in the list either: the note says it stays at the top for now.
 */
export function EditHomeSheet({ visible, layout, node, role, pinned = [], drawnNow, colors, onChange, onClose }: {
    visible: boolean;
    layout: HomeLayout | null;
    /** The node's profile and switches, from its answer (with its cards: a "Your way back in" it sent is offered). */
    node: Pick<HomeAnswer, 'profile' | 'features'> & { cards?: HomeAnswer['cards'] };
    /** The member's role there, for where only admins invite (utils/home-cards.ts `invitesForReader`). */
    role?: HomeRole;
    /** The cards pinned now (utils/home-cards.ts `pinnedCards`): neither hidden nor moved, so not listed. */
    pinned?: readonly HomeCardId[];
    /** The cards on Home now; the others say they have nothing to show yet. */
    drawnNow: readonly HomeCardId[];
    colors: AppColors;
    onChange: (layout: HomeLayout) => void;
    onClose: () => void;
}) {
    const insets = useSafeAreaInsets();
    const listed = cardOrder(layout, pinned).filter(id => canMoveCard(id, pinned) && cardOnNode(id, node, role));
    const shown = listed.filter(id => !isHidden(layout, id, pinned));
    const hidden = listed.filter(id => isHidden(layout, id, pinned));
    const findPinnedHere = pinned.includes('find') && cardOnNode('find', node, role);
    const name = (id: HomeCardId) => (id === 'market' ? marketCaption(node.profile) : HOME_CARD_NAMES[id]);
    const apply = (next: HomeLayout | null) => { if (next) onChange(next); };

    const row = (id: HomeCardId, on: boolean) => {
        const at = shown.indexOf(id);
        const canUp = on && at > 0;
        const canDown = on && at >= 0 && at < shown.length - 1;
        const idle = on && !drawnNow.includes(id);
        return (
            <View key={id} style={[editHomeStyles.row, { borderBottomColor: colors.border.default }]} testID={`edit-home-${id}`}>
                <View style={editHomeStyles.rowText}>
                    <Text style={[editHomeStyles.name, { color: on ? colors.text.heading : colors.text.muted }]} numberOfLines={2}>{name(id)}</Text>
                    {idle && <Text style={[editHomeStyles.sub, { color: colors.text.secondary }]}>Nothing to show now</Text>}
                </View>
                {on && (
                    <>
                        <Pressable
                            disabled={!canUp}
                            onPress={() => apply(moveCard(layout, id, 'up', shown, Date.now(), pinned))}
                            style={editHomeStyles.arrow}
                            accessibilityRole="button"
                            accessibilityLabel={`Move ${name(id)} up`}
                            accessibilityState={{ disabled: !canUp }}
                            testID={`edit-home-${id}-up`}
                        >
                            <MaterialCommunityIcons name="chevron-up" size={26} color={canUp ? colors.text.body : colors.border.strong} />
                        </Pressable>
                        <Pressable
                            disabled={!canDown}
                            onPress={() => apply(moveCard(layout, id, 'down', shown, Date.now(), pinned))}
                            style={editHomeStyles.arrow}
                            accessibilityRole="button"
                            accessibilityLabel={`Move ${name(id)} down`}
                            accessibilityState={{ disabled: !canDown }}
                            testID={`edit-home-${id}-down`}
                        >
                            <MaterialCommunityIcons name="chevron-down" size={26} color={canDown ? colors.text.body : colors.border.strong} />
                        </Pressable>
                    </>
                )}
                <Switch
                    value={on}
                    onValueChange={v => apply(v ? showCard(layout, id, Date.now()) : hideCard(layout, id, Date.now(), pinned))}
                    accessibilityLabel={`Show ${name(id)} on Home`}
                    accessibilityState={{ checked: on }}
                    testID={`edit-home-${id}-switch`}
                />
            </View>
        );
    };

    return (
        <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose} statusBarTranslucent>
            <View style={editHomeStyles.backdrop}>
                <View style={[editHomeStyles.sheet, { backgroundColor: colors.surface.card, paddingBottom: 12 + insets.bottom, marginTop: insets.top + 24 }]}>
                    <View style={editHomeStyles.head}>
                        <Text style={[editHomeStyles.title, { color: colors.text.heading }]} accessibilityRole="header">Edit home</Text>
                        <Pressable onPress={onClose} style={editHomeStyles.done} accessibilityRole="button" accessibilityLabel="Done editing Home" testID="edit-home-done">
                            <Text style={[editHomeStyles.doneText, { color: colors.text.link }]}>Done</Text>
                        </Pressable>
                    </View>
                    <ScrollView contentContainerStyle={editHomeStyles.list}>
                        <Text style={[editHomeStyles.note, { color: colors.text.secondary }]}>
                            Needs you stays at the top, and your community's card at the bottom.
                            {findPinnedHere ? ' Find your community stays near the top for your first 30 days.' : ''}
                        </Text>
                        {shown.map(id => row(id, true))}
                        {hidden.length > 0 && (
                            <Text style={[editHomeStyles.section, { color: colors.text.secondary }]} accessibilityRole="header" accessibilityLabel="Hidden">Hidden</Text>
                        )}
                        {hidden.map(id => row(id, false))}
                        <Pressable
                            onPress={() => onChange(resetLayout(layout, Date.now()))}
                            style={[editHomeStyles.reset, { borderColor: colors.border.strong }]}
                            accessibilityRole="button"
                            accessibilityLabel="Reset Home to its default cards and order"
                            testID="edit-home-reset"
                        >
                            <Text style={[editHomeStyles.resetText, { color: colors.text.body }]}>Reset to defaults</Text>
                        </Pressable>
                    </ScrollView>
                </View>
            </View>
        </Modal>
    );
}

/** Exported for the layout checks at 320dp (utils/__tests__/home-layout-320.test.ts). */
export const editHomeStyles = StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
    sheet: { flexShrink: 1, borderTopLeftRadius: 18, borderTopRightRadius: 18 },
    head: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 4, minHeight: HOME_TARGET_DP + 8 },
    title: { flex: 1, fontSize: 20, fontWeight: '800' },
    done: { minHeight: HOME_TARGET_DP, minWidth: HOME_TARGET_DP, paddingHorizontal: 12, justifyContent: 'center', alignItems: 'center' },
    doneText: { fontSize: 16, fontWeight: '700' },
    list: { paddingHorizontal: 16, paddingBottom: 12 },
    note: { fontSize: 13, lineHeight: 18, marginBottom: 6 },
    section: { fontSize: 12, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', marginTop: 16, marginBottom: 2 },
    row: { flexDirection: 'row', alignItems: 'center', minHeight: HOME_TARGET_DP + 8, borderBottomWidth: StyleSheet.hairlineWidth, gap: 2 },
    rowText: { flex: 1, minWidth: 0, paddingVertical: 6 },
    name: { fontSize: 15, fontWeight: '600' },
    sub: { fontSize: 12, marginTop: 1 },
    arrow: { width: HOME_TARGET_DP, height: HOME_TARGET_DP, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    reset: { marginTop: 20, minHeight: HOME_TARGET_DP, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
    resetText: { fontSize: 15, fontWeight: '700' },
});
