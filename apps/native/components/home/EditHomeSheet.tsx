import React, { useState } from 'react';
import { TIPS_ALL_SEEN } from '@beanpool/core';
import { View, Text, Pressable, Modal, ScrollView, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AppColors } from '../../constants/colors';
import {
    NOT_ON_ACCOUNT_LINE, SKY_NO_PLACE_LINE, canMoveCard, canRemoveCard, cardLabelName, cardOnNode, cardRowName, cardOrder, moveCard, resetLayout,
    type HomeAnswer, type HomeCardId, type HomeCardInstance, type HomeLayout, type HomeRole,
} from '../../utils/home-cards';
import { homeCardType } from '@beanpool/core';
import { HOME_TARGET_DP } from './HomeParts';
import { HomeCardMenu } from './HomeCardMenu';

/** Edit home's note (CARD-FRAME §1.3). */
export const EDIT_HOME_NOTE = "Needs you stays at the top, and your community's card at the bottom.";

/**
 * Edit home (CARD-FRAME §1.3): ＋ Add a card first, then the cards on Home in the member's order, each with ↑ ↓ and the
 * same "…" as the card (Settings… · Move up · Move down · Remove), then Reset to defaults (the newcomer's list). No
 * switches and no Hidden section: a card is on Home because it is in the list, and Add a card is where the rest are.
 * Nothing is dragged (fragile on old Android, poor with large text and a screen reader) and nothing is typed. Needs you
 * and the community's card are not in the list; a pinned card (Find your community, a member's first 30 days on the
 * global node) neither: the note says it stays near the top for now. Only cards this node can show are listed.
 */
export function EditHomeSheet({
    visible, layout, node, role, pinned = [], drawnNow, colors, onChange, onClose, onAdd, onRemove, onSettings, onReset, tipsAllSeen, notOnAccount,
}: {
    visible: boolean;
    layout: HomeLayout | null;
    /** The node's profile and switches, from its answer (with its cards: a "Your way back in" it sent is offered). */
    node: Pick<HomeAnswer, 'profile' | 'features'> & { cards?: HomeAnswer['cards'] };
    /** The member's role there, for where only admins invite (utils/home-cards.ts `invitesForReader`). */
    role?: HomeRole;
    /** The cards pinned now (utils/home-cards.ts `pinnedCards`): neither removed nor moved, so not listed. */
    pinned?: readonly HomeCardId[];
    /** The cards on Home now; the others say they have nothing to show yet. */
    drawnNow: readonly HomeCardInstance[];
    colors: AppColors;
    /** A move or a Reset: the whole new layout. */
    onChange: (layout: HomeLayout) => void;
    onClose: () => void;
    /** ＋ Add a card: the screen closes this sheet and opens the picker. */
    onAdd: () => void;
    /** Remove (the screen announces it, and Tips keeps its record). */
    onRemove: (card: HomeCardInstance) => void;
    /** Settings… on a type that has them: the screen closes this sheet and opens the card's settings. */
    onSettings: (card: HomeCardInstance) => void;
    /** Reset to defaults was tapped (the screen starts Tips over when they were off): beside `onChange`'s new layout. */
    onReset?: () => void;
    /** Every tip this node shows is seen (the card went by itself): its line says so rather than "Nothing to show now". */
    tipsAllSeen?: boolean;
    /** A node from before the frame can't keep the member's cards on their account yet (§2.3): one line says so. */
    notOnAccount?: boolean;
}) {
    const insets = useSafeAreaInsets();
    const [menuFor, setMenuFor] = useState<HomeCardInstance | null>(null);
    const listed = cardOrder(layout, pinned).filter(c => canMoveCard(c.type, pinned) && cardOnNode(c.type, node, role));
    const findPinnedHere = pinned.includes('find') && cardOnNode('find', node, role);
    // A row's name: a saved search by its words (cardRowName), so two searches read as two rows.
    const name = (c: HomeCardInstance) => cardRowName(c, node.profile);
    // Labels name the card as the screen reader should hear it: a saved search by its words (cardLabelName).
    const said = (c: HomeCardInstance) => cardLabelName(c, node.profile);
    const apply = (next: HomeLayout | null) => { if (next) onChange(next); };
    const move = (c: HomeCardInstance, dir: 'up' | 'down') => apply(moveCard(layout, c.id, dir, listed, Date.now(), pinned));

    const row = (c: HomeCardInstance, at: number) => {
        const canUp = at > 0;
        const canDown = at < listed.length - 1;
        const idle = !drawnNow.some(d => d.id === c.id);
        return (
            <View key={c.id} style={[editHomeStyles.row, { borderBottomColor: colors.border.default }]} testID={`edit-home-${c.id}`}>
                <View style={editHomeStyles.rowText}>
                    <Text style={[editHomeStyles.name, { color: colors.text.heading }]} numberOfLines={2}>{name(c)}</Text>
                    {idle && <Text style={[editHomeStyles.sub, { color: colors.text.secondary }]}>{c.type === 'tips' && tipsAllSeen ? TIPS_ALL_SEEN : c.type === 'sky' ? SKY_NO_PLACE_LINE : 'Nothing to show now'}</Text>}
                </View>
                <Pressable
                    disabled={!canUp}
                    onPress={() => move(c, 'up')}
                    style={editHomeStyles.arrow}
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${said(c)} up`}
                    accessibilityState={{ disabled: !canUp }}
                    testID={`edit-home-${c.id}-up`}
                >
                    <MaterialCommunityIcons name="chevron-up" size={26} color={canUp ? colors.text.body : colors.border.strong} />
                </Pressable>
                <Pressable
                    disabled={!canDown}
                    onPress={() => move(c, 'down')}
                    style={editHomeStyles.arrow}
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${said(c)} down`}
                    accessibilityState={{ disabled: !canDown }}
                    testID={`edit-home-${c.id}-down`}
                >
                    <MaterialCommunityIcons name="chevron-down" size={26} color={canDown ? colors.text.body : colors.border.strong} />
                </Pressable>
                <Pressable
                    onPress={() => setMenuFor(c)}
                    style={editHomeStyles.arrow}
                    accessibilityRole="button"
                    accessibilityLabel={`Card options for ${said(c)}`}
                    testID={`edit-home-${c.id}-menu`}
                >
                    <MaterialCommunityIcons name="dots-horizontal" size={24} color={colors.text.body} />
                </Pressable>
            </View>
        );
    };

    const menuAt = menuFor ? listed.findIndex(c => c.id === menuFor.id) : -1;
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
                            {EDIT_HOME_NOTE}
                            {findPinnedHere ? ' Find your community stays near the top for your first 30 days.' : ''}
                        </Text>
                        {notOnAccount && (
                            <Text style={[editHomeStyles.note, { color: colors.text.body }]} testID="edit-home-not-on-account">{NOT_ON_ACCOUNT_LINE}</Text>
                        )}
                        <Pressable
                            onPress={onAdd}
                            style={[editHomeStyles.addRow, { backgroundColor: colors.brand.primary }]}
                            accessibilityRole="button"
                            accessibilityLabel="Add a card to Home"
                            testID="edit-home-add"
                        >
                            <Text style={[editHomeStyles.addText, { color: colors.text.inverse }]}>＋ Add a card</Text>
                        </Pressable>
                        {listed.map(row)}
                        <Pressable
                            onPress={() => { onReset?.(); onChange(resetLayout(layout, Date.now())); }}
                            style={[editHomeStyles.reset, { borderColor: colors.border.strong }]}
                            accessibilityRole="button"
                            accessibilityLabel="Reset Home to its default cards and order"
                            testID="edit-home-reset"
                        >
                            <Text style={[editHomeStyles.resetText, { color: colors.text.body }]}>Reset to defaults</Text>
                        </Pressable>
                    </ScrollView>
                </View>
                {/* Inside this sheet's modal, so it stands over it on both platforms. */}
                <HomeCardMenu
                    visible={!!menuFor}
                    name={menuFor ? name(menuFor) : ''}
                    label={menuFor ? said(menuFor) : undefined}
                    colors={colors}
                    canRemove={!!menuFor && canRemoveCard(menuFor.type, pinned)}
                    canUp={menuAt > 0}
                    canDown={menuAt >= 0 && menuAt < listed.length - 1}
                    onSettings={menuFor && homeCardType(menuFor.type)?.readSettings ? () => onSettings(menuFor) : undefined}
                    onRemove={() => { if (menuFor) onRemove(menuFor); }}
                    onUp={() => { if (menuFor) move(menuFor, 'up'); }}
                    onDown={() => { if (menuFor) move(menuFor, 'down'); }}
                    onClose={() => setMenuFor(null)}
                />
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
    addRow: { marginTop: 6, marginBottom: 6, minHeight: HOME_TARGET_DP, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
    addText: { fontSize: 15, fontWeight: '700' },
    reset: { marginTop: 20, minHeight: HOME_TARGET_DP, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
    resetText: { fontSize: 15, fontWeight: '700' },
});
