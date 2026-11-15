/**
 * The invite panel's bill fold (DESIGN-getting-paid-fable.md §4.5, slice B3): "Add a bill for them (optional)", folded. Open,
 * what it is for and how many Beans, the send sheet's own labels (core billLines), what the maker receives after the 1.5%
 * once the amount reads as one, and that nothing is taken by itself. Whoever joins with the invite is its payer; the node
 * checks every rule again. Shown only where bills are on, and never for an offline ticket (the panel refuses that).
 *
 * Every row is at least 48 dp and wraps at 320 dp with 1.3× text; an amount is never clipped.
 */
import React from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import { billLines, inviteBillFromForm, inviteBillLines } from '@beanpool/core';
import { useTheme, useStyles } from '../app/ThemeContext';

export interface InviteBillFoldProps {
    open: boolean;
    onOpen: (open: boolean) => void;
    whatFor: string;
    onWhatFor: (text: string) => void;
    beans: string;
    onBeans: (text: string) => void;
}

export function InviteBillFold({ open, onOpen, whatFor, onWhatFor, beans, onBeans }: InviteBillFoldProps) {
    const { colors } = useTheme();
    const styles = useStyles(({ colors }) => StyleSheet.create({
        container: { marginBottom: 16 },
        toggle: { minHeight: 48, justifyContent: 'center' },
        toggleText: { fontSize: 14, fontWeight: '700', color: colors.text.heading },
        label: { fontSize: 14, fontWeight: '700', color: colors.text.heading, marginBottom: 4 },
        input: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong, padding: 14, borderRadius: 12, fontSize: 15, fontWeight: '500', marginBottom: 12, color: colors.text.heading, minHeight: 48 },
        line: { fontSize: 13, color: colors.text.muted, marginBottom: 4 },
    }));
    const read = inviteBillFromForm(whatFor, beans);

    return (
        <View style={styles.container} testID="invite-bill-fold">
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.toggle} onPress={() => onOpen(!open)} testID="invite-bill-toggle">
                <Text style={styles.toggleText} maxFontSizeMultiplier={1.3}>{open ? '▾ ' : '▸ '}{inviteBillLines.fold()}</Text>
            </Pressable>
            {open && (
                <View>
                    <Text style={styles.label} maxFontSizeMultiplier={1.3}>{billLines.whatForLabel()}</Text>
                    <TextInput value={whatFor} onChangeText={onWhatFor} style={styles.input} maxLength={80}
                        placeholderTextColor={colors.text.muted} accessibilityLabel={billLines.whatForLabel()} testID="invite-bill-what-for" />
                    <Text style={styles.label} maxFontSizeMultiplier={1.3}>{billLines.amountLabel()}</Text>
                    <TextInput value={beans} onChangeText={onBeans} style={styles.input} keyboardType="decimal-pad"
                        placeholderTextColor={colors.text.muted} accessibilityLabel={billLines.amountLabel()} testID="invite-bill-beans" />
                    {read.bill && <Text style={styles.line} maxFontSizeMultiplier={1.3} testID="invite-bill-receive">{billLines.youReceive(read.bill.amount_c)}</Text>}
                    <Text style={styles.line} maxFontSizeMultiplier={1.3}>{inviteBillLines.theyChoose()}</Text>
                </View>
            )}
        </View>
    );
}
