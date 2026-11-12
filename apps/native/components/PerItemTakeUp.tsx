/**
 * The buyer's "How many would you like?" for an Offer priced for each one, inside the item page's confirm box
 * (app/post/[id].tsx; DESIGN-per-item-price-fable.md §2.2, slice P3): Choose how many, with a stepper (− and + are 48 dp, the
 * count a box between them) and "300 Beans each · 20 left"; "All 20 for 5,500 Beans" while the price for all shows; the total
 * and what goes into trust; and why Confirm can't go yet. Every line and rule is @beanpool/core per-item-deal.ts
 * (itemTakeUpBox), which the web's box reads too; what Confirm sends is its `send`, never a figure worked out here.
 *
 * Colours are the existing roles (surface.app, border.default, brand.primary, text.*, feedback.danger), so dark mode comes
 * with them. A plain TextInput inside the page's ScrollView (never a Modal of its own, so no keyboard provider here).
 */
import React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { itemBoxPick, itemBoxStep, itemBoxTyped, type ItemBoxState, type ItemTakeUpBox } from '@beanpool/core';
import { useTheme } from '../app/ThemeContext';

export interface PerItemTakeUpProps {
    /** The listing as the page holds it (core perItemOf reads the phone's row). */
    listing: unknown;
    /** core itemTakeUpBox(listing, state, seller): every line the box shows. */
    box: ItemTakeUpBox;
    state: ItemBoxState;
    onState: (next: ItemBoxState) => void;
    /** The node's refusal of the last Confirm (core itemTakeUpRefusalIn), said until the count is changed. */
    nodeRefusal?: string | null;
    disabled?: boolean;
}

export function PerItemTakeUp({ listing, box, state, onState, nodeRefusal = null, disabled = false }: PerItemTakeUpProps) {
    const { colors } = useTheme();
    const s = React.useMemo(() => StyleSheet.create({
        choice: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 8, minHeight: 48 },
        // The ring in secondary ink, so an unticked choice is seen as one in light and dark (a border tone is too faint).
        dot: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.text.secondary, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
        dotOn: { borderColor: colors.brand.primary },
        dotFill: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.brand.primary },
        choiceText: { flex: 1, minWidth: 0 },
        label: { color: colors.text.heading, fontSize: 15, fontWeight: '700' },
        note: { color: colors.text.secondary, fontSize: 13, lineHeight: 19, marginTop: 2 },
        stepper: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
        step: { width: 48, height: 48, borderRadius: 10, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.app, alignItems: 'center', justifyContent: 'center' },
        stepOff: { opacity: 0.4 },
        stepText: { color: colors.text.heading, fontSize: 22, fontWeight: '800' },
        count: { flex: 1, minWidth: 56, maxWidth: 96, height: 48, borderRadius: 10, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.app, color: colors.text.heading, fontSize: 18, fontWeight: '800', textAlign: 'center' },
        total: { color: colors.text.heading, fontSize: 16, fontWeight: '800', marginTop: 10 },
        trust: { color: colors.text.secondary, fontSize: 13, lineHeight: 19, marginTop: 4 },
        refusal: { color: colors.feedback.danger.fg, fontSize: 13, lineHeight: 19, marginTop: 8, fontWeight: '600' },
    }), [colors]);
    const each = box.option === 'each';
    const off = disabled || box.max === 0;
    const refusal = nodeRefusal ?? box.refusal;
    return (
        <View testID="each-take-up" accessibilityRole="radiogroup" style={{ marginBottom: 12 }}>
            <Pressable accessibilityRole="radio" accessibilityState={{ checked: each, disabled: off }} disabled={off} testID="each-choose"
                style={s.choice} onPress={() => onState(itemBoxPick(listing, state, 'each'))}>
                <View style={[s.dot, each && s.dotOn]}>{each && <View style={s.dotFill} />}</View>
                <View style={s.choiceText}>
                    <Text style={s.label}>{box.chooseLabel}</Text>
                    <Text style={s.note} testID="each-line">{box.eachLine}</Text>
                </View>
            </Pressable>
            <View style={s.stepper}>
                <Pressable accessibilityRole="button" testID="each-less" disabled={off || !box.canLess} style={[s.step, (off || !box.canLess) && s.stepOff]}
                    onPress={() => onState(itemBoxStep(listing, state, -1))}>
                    <Text style={s.stepText}>−</Text>
                </Pressable>
                <TextInput testID="each-count" accessibilityLabel={box.chooseLabel} editable={!off} style={s.count} value={box.count}
                    keyboardType="number-pad" maxLength={4} selectTextOnFocus onChangeText={(v) => onState(itemBoxTyped(listing, v))} />
                <Pressable accessibilityRole="button" testID="each-more" disabled={off || !box.canMore} style={[s.step, (off || !box.canMore) && s.stepOff]}
                    onPress={() => onState(itemBoxStep(listing, state, 1))}>
                    <Text style={s.stepText}>+</Text>
                </Pressable>
            </View>
            {box.lot && (
                <Pressable accessibilityRole="radio" accessibilityState={{ checked: !each, disabled: off }} disabled={off} testID="each-all"
                    style={[s.choice, { marginTop: 6 }]} onPress={() => onState(itemBoxPick(listing, state, 'lot'))}>
                    <View style={[s.dot, !each && s.dotOn]}>{!each && <View style={s.dotFill} />}</View>
                    <View style={s.choiceText}>
                        <Text style={s.label}>{box.lot.label}</Text>
                        {!!box.lot.saving && <Text style={s.note}>{box.lot.saving}</Text>}
                    </View>
                </Pressable>
            )}
            {!!box.total && <Text style={s.total} testID="each-total">{box.total}</Text>}
            {!!box.trust && <Text style={s.trust} testID="each-trust">{box.trust}</Text>}
            {!!refusal && <Text style={s.refusal} testID="each-refusal" accessibilityLiveRegion="polite">{refusal}</Text>}
        </View>
    );
}
