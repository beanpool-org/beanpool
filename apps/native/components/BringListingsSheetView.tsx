/**
 * The Bring my listings sheet as drawn (utils/bring-listings.ts; components/BringListingsSheet.tsx runs it): the offer,
 * the run, and what came of it. Apart from the run, so e2e/bring-listings-320.mjs draws each state at 320 dp with
 * nothing of the phone's storage or network behind it.
 *
 * One column at 320 dp and 1.3× text. The words scroll and the buttons sit in a footer outside them, above the system
 * bars (utils/bottom-sheet-layout.ts): a long list of lines never pushes the way out off the screen. A tap on the dimmed
 * part closes nothing: "Not now" is a choice, and Back makes the same one. Every state has a way out, the run too: twenty
 * listings on a poor connection can take many minutes, and the run goes on behind it.
 */
import React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '@beanpool/core';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { bottomSheetLayout } from '../utils/bottom-sheet-layout';
import { BRING_WORDS, bringLineWords, type BringLine } from '../utils/bring-listings';

export type BringStep =
    | { step: 'offer'; name: string; count: number; noPrice: boolean }
    | { step: 'bringing'; done: number; total: number }
    | { step: 'done'; name: string; brought: number; lines: BringLine[]; kept: boolean };

export function BringListingsSheetView({ view, onBring, onNotNow, onClose }: {
    view: BringStep;
    onBring: () => void;
    onNotNow: () => void;
    onClose: () => void;
}) {
    const styles = useStyles(makeStyles);
    const { height } = useWindowDimensions();
    const layout = bottomSheetLayout(height, useSafeAreaInsets());
    // Back does what the sheet's own way out does.
    const back = view.step === 'offer' ? onNotNow : onClose;

    return (
        <Modal visible transparent animationType="fade" onRequestClose={back}>
            <View style={styles.backdrop}>
                <View style={[styles.sheet, { maxHeight: layout.maxHeight }]} accessibilityViewIsModal testID="bring-listings-sheet">
                    <ScrollView style={styles.body} contentContainerStyle={styles.bodyInner}>
                        {view.step === 'offer' && (
                            <>
                                <Text style={styles.title} accessibilityRole="header">{BRING_WORDS.title(view.name)}</Text>
                                <Text style={styles.line}>{BRING_WORDS.body(view.count)}</Text>
                                {view.noPrice && <Text style={styles.note}>{BRING_WORDS.noPrice()}</Text>}
                            </>
                        )}
                        {view.step === 'bringing' && (
                            <View style={styles.running}>
                                <ActivityIndicator />
                                <Text style={styles.line} accessibilityLiveRegion="polite">{BRING_WORDS.bringing(view.done, view.total)}</Text>
                            </View>
                        )}
                        {view.step === 'done' && (
                            <>
                                <Text style={styles.title} accessibilityRole="header" accessibilityLiveRegion="polite">{BRING_WORDS.done(view.brought, view.name)}</Text>
                                {view.lines.map((line, i) => (
                                    <Text key={i} style={styles.line} testID="bring-listings-line">{bringLineWords(line, view.name)}</Text>
                                ))}
                                {view.kept && <Text style={styles.note}>{BRING_WORDS.kept()}</Text>}
                            </>
                        )}
                    </ScrollView>
                    <View style={[styles.footer, { paddingBottom: layout.footerPaddingBottom }]}>
                        {view.step === 'offer' && (
                            <>
                                <Pressable style={styles.primary} accessibilityRole="button" onPress={onBring} testID="bring-listings-yes">
                                    <Text style={styles.primaryText}>{BRING_WORDS.bring(view.count)}</Text>
                                </Pressable>
                                <Pressable style={styles.secondary} accessibilityRole="button" onPress={onNotNow} testID="bring-listings-not-now">
                                    <Text style={styles.secondaryText}>{t('Not now')}</Text>
                                </Pressable>
                            </>
                        )}
                        {view.step === 'bringing' && (
                            <Pressable style={styles.secondary} accessibilityRole="button" onPress={onClose} testID="bring-listings-hide">
                                <Text style={styles.secondaryText}>{t('Close')}</Text>
                            </Pressable>
                        )}
                        {view.step === 'done' && (
                            <Pressable style={styles.primary} accessibilityRole="button" onPress={onClose} testID="bring-listings-done">
                                <Text style={styles.primaryText}>{t('OK')}</Text>
                            </Pressable>
                        )}
                    </View>
                </View>
            </View>
        </Modal>
    );
}

const makeStyles = ({ colors }: ThemeContextType) => StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.5)', justifyContent: 'flex-end' },
    sheet: { backgroundColor: colors.surface.card, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
    body: { flexShrink: 1 },
    bodyInner: { padding: 20, paddingBottom: 8, gap: 10 },
    title: { fontSize: 18, fontWeight: '800', color: colors.text.body },
    line: { fontSize: 15, lineHeight: 21, color: colors.text.body },
    note: { fontSize: 13, lineHeight: 18, color: colors.text.secondary },
    running: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
    footer: { paddingHorizontal: 20, paddingTop: 8, gap: 10 },
    primary: {
        minHeight: 48, backgroundColor: colors.brand.fill, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16,
        alignItems: 'center', justifyContent: 'center',
    },
    primaryText: { color: colors.text.onBrand, fontSize: 16, fontWeight: '800', textAlign: 'center' },
    secondary: {
        minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, paddingVertical: 12, paddingHorizontal: 16,
        alignItems: 'center', justifyContent: 'center',
    },
    secondaryText: { color: colors.text.body, fontSize: 15, fontWeight: '700', textAlign: 'center' },
});
