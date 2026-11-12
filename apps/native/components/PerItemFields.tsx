/**
 * The seller's two extra boxes for a listing priced for each one, on the phone's create form (app/new-listing.tsx) and its
 * edit form (app/post/[id].tsx): HOW MANY DO YOU HAVE?, and OR ALL OF THEM FOR (OPTIONAL) with its one live line, then the fee
 * line (DESIGN-per-item-price-fable.md §2.4, §2.5, slice P4). The price for one is the form's own Price box, which on Each
 * reads PRICE FOR ONE. Every sentence and every rule is @beanpool/core per-item-form.ts, which the web's forms read too.
 *
 * Colours are the existing roles (surface.app, border.default, text.*, feedback.danger), so dark mode comes with them. The
 * boxes are plain TextInputs inside the form's own ScrollView (never a Modal of their own, so no keyboard provider here).
 */
import React from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import {
    perItemFeeLine, perItemLines, perItemLotHint, perItemIsFree, upperCase,
    type PerItemField, type PerItemFormText,
} from '@beanpool/core';
import { useTheme } from '../app/ThemeContext';

export interface PerItemFieldsProps {
    text: PerItemFormText;
    onCount: (v: string) => void;
    onLot: (v: string) => void;
    /** The create form asks "HOW MANY DO YOU HAVE?"; the edit form "HOW MANY DO YOU HAVE LEFT?". */
    edit?: boolean;
    /** The box a refusal is about, marked, and its sentence under it. */
    refusal?: { field: PerItemField; text: string } | null;
    /** Edit: "3 are held for buyers now. They are not counted here." */
    heldNote?: string | null;
    /** Edit: "Your price for all of them was for 20. There are 17 left, so it is not showing. …" */
    lotForOtherLine?: string | null;
    /** Where the fee line goes: the create form draws its own (it keeps the tax-guide link on it). */
    showFeeLine?: boolean;
}

export function PerItemFields({ text, onCount, onLot, edit = false, refusal = null, heldNote = null, lotForOtherLine = null, showFeeLine = false }: PerItemFieldsProps) {
    const { colors } = useTheme();
    const s = React.useMemo(() => StyleSheet.create({
        label: { color: colors.text.secondary, fontSize: 12, fontWeight: '700', letterSpacing: 0.8, marginBottom: 2, marginTop: 6 },
        star: { color: colors.feedback.danger.fg, fontSize: 12 },
        input: { backgroundColor: colors.surface.app, borderRadius: 10, borderWidth: 1, borderColor: colors.border.default, paddingHorizontal: 12, paddingVertical: 10, minHeight: 44, color: colors.text.heading, fontSize: 15, fontWeight: '800' },
        inputBad: { borderColor: colors.feedback.danger.fg, borderWidth: 2 },
        line: { color: colors.text.secondary, fontSize: 13, lineHeight: 19, marginTop: 4 },
        bad: { color: colors.feedback.danger.fg, fontSize: 13, lineHeight: 19, marginTop: 4, fontWeight: '600' },
        wrap: { marginBottom: 6 },
    }), [colors]);
    const free = perItemIsFree(text);
    const bad = (field: PerItemField) => refusal?.field === field;
    // A refusal on this box says what the live line would (not less than one by one): said once, in red, under the box.
    // A price for all that was set for another number says so in its place (§2.5) rather than "leave this empty to sell one by one".
    const staleLine = lotForOtherLine && text.lot.trim() === '' ? lotForOtherLine : null;
    const hint = free || bad('lot') || staleLine ? null : perItemLotHint(text);
    const fee = showFeeLine ? perItemFeeLine(text) : null;
    return (
        <View style={s.wrap} testID="per-item-fields">
            <Text style={s.label}>{upperCase(edit ? perItemLines.howManyLeft() : perItemLines.howManyHave())} <Text style={s.star}>*</Text></Text>
            <TextInput
                accessibilityLabel={edit ? perItemLines.howManyLeft() : perItemLines.howManyHave()}
                testID="per-item-count"
                style={[s.input, bad('count') && s.inputBad]}
                value={text.count}
                onChangeText={onCount}
                placeholder="20"
                placeholderTextColor={colors.text.muted}
                keyboardType="number-pad"
                maxLength={4}
            />
            {bad('count') ? <Text style={s.bad} testID="per-item-refusal">{refusal!.text}</Text> : null}
            {heldNote ? <Text style={s.line} testID="per-item-held">{heldNote}</Text> : null}

            {/* A Free listing has no price for all of them, so its box is not drawn. */}
            {!free ? (<>
                <Text style={s.label}>{upperCase(perItemLines.orAllOfThemFor())}</Text>
                <TextInput
                    accessibilityLabel={perItemLines.orAllOfThemFor()}
                    testID="per-item-lot"
                    style={[s.input, bad('lot') && s.inputBad]}
                    value={text.lot}
                    onChangeText={onLot}
                    placeholder="5500"
                    placeholderTextColor={colors.text.muted}
                    keyboardType="numeric"
                    maxLength={10}
                />
                {bad('lot') ? <Text style={s.bad} testID="per-item-refusal">{refusal!.text}</Text> : null}
                {staleLine ? <Text style={s.line} testID="per-item-lot-other">{staleLine}</Text> : null}
                {hint ? <Text style={s.line} testID="per-item-hint">{hint.text}</Text> : null}
            </>) : null}
            {fee ? <Text style={s.line} testID="per-item-fee">{fee}</Text> : null}
        </View>
    );
}
