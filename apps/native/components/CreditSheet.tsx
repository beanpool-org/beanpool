/**
 * "Your Beans and your credit line" (phone): what a tap on the member's own credit card opens (DESIGN-credit-bar-amend-fable.md
 * §6, slice R2; Marty decided the amendment on 14 Nov 2026). It replaces the old "Credit Slider Info". One sheet, the same six
 * parts as the web's, every word and figure from core's creditSheet(): reading the bar (each mark's one line: on a phone there
 * is no room for them under the bar), the credit line part by part, earning, what can change it, the two fees, who can see
 * this. Nothing is composed here. A modal as the Ledger's others are: ✕ at 44 × 44, back closes it, the heading is read first.
 * Colours: the rainbow is core's picture; everything else a library role for the look (`set`) or the theme's tokens.
 */
import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import {
    CREDIT_RAINBOW,
    creditMeterColours,
    creditSheet,
    t,
    type BrandSet,
    type CreditSheetEarning,
    type CreditSheetRow,
    type CreditStandingAnswer,
} from '@beanpool/core';

/** The marks drawn as signs, not letters (never colour alone). */
const SIGN: Record<string, string> = { open: '✓', closed: '🔒', progress: '🌱' };

interface Props {
    visible: boolean;
    answer: CreditStandingAnswer;
    earning?: CreditSheetEarning;
    colors: any;
    set: BrandSet;
    onClose: () => void;
    /** "What people who give credit see ›": the member's own reading of it, on the Levels tab. None where it isn't drawn. */
    onGivers?: () => void;
    /** "More in the guide ›": the guide's credit-line page. */
    onGuide?: (slug: string) => void;
}

export function CreditSheet({ visible, answer, earning, colors, set, onClose, onGivers, onGuide }: Props) {
    if (!visible) return null;
    const sheet = creditSheet(answer, earning);
    const meter = creditMeterColours(set);
    const s = styles(colors);

    const mark = (row: CreditSheetRow) => {
        switch (row.mark) {
            case 'dot':
                return <View style={[s.dot, { backgroundColor: CREDIT_RAINBOW.dot, borderColor: CREDIT_RAINBOW.ring }]} />;
            case 'zero':
            case 'limit':
            case 'fee': {
                const ink = row.mark === 'zero' ? meter.zeroInk : row.mark === 'limit' ? meter.limitInk : meter.feeInk;
                return row.mark === 'zero'
                    ? <Text style={[s.figure, { color: ink }]}>⚖️ {row.figure}</Text>
                    : <Text style={[s.figure, { color: ink }]}>{row.figure || '·'}</Text>;
            }
            case 'strip':
                return (
                    <View style={s.pair}>
                        <View style={[s.block, { backgroundColor: meter.strip }]} />
                        <View style={[s.block, { borderWidth: 1.5, borderColor: meter.strip }]} />
                    </View>
                );
            case 'solid':
                return <View style={[s.blockWide, { backgroundColor: meter.strip }]} />;
            case 'outlined':
                return <View style={[s.blockWide, { borderWidth: 1.5, borderColor: meter.strip }]} />;
            case 'stripes':
                return (
                    <View style={[s.stripes, { borderColor: meter.strip }]}>
                        {[0, 1, 2, 3, 4, 5].map((i) => <View key={i} style={[s.stripe, { left: i * 6 - 4, backgroundColor: meter.strip }]} />)}
                    </View>
                );
            case 'colours':
            case 'left':
            case 'right': {
                // The rainbow, or one half of it: the same stops, drawn twice as wide with only that half showing.
                const half = row.mark !== 'colours';
                return (
                    <View style={[half ? s.half : s.rainbow, { overflow: 'hidden' }]}>
                        <LinearGradient
                            colors={[...CREDIT_RAINBOW.stops]}
                            locations={[...CREDIT_RAINBOW.at]}
                            start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }}
                            style={half ? { position: 'absolute', top: 0, bottom: 0, width: '200%', left: row.mark === 'left' ? 0 : '-100%' } : { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
                        />
                    </View>
                );
            }
            default:
                return row.mark && SIGN[row.mark] ? <Text style={[s.sign, { color: meter.quietInk }]}>{SIGN[row.mark]}</Text> : null;
        }
    };

    return (
        <Modal visible transparent animationType="fade" onRequestClose={onClose}>
            <Pressable style={s.backdrop} onPress={onClose}>
                <Pressable style={s.card} onPress={() => {}} testID="credit-sheet">
                    <View style={s.head}>
                        <Text style={s.title} accessibilityRole="header">{sheet.title}</Text>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={t('Close')}
                            onPress={onClose}
                            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                            style={s.close}
                        >
                            <Text style={{ fontSize: 16, color: colors.text.muted }}>✕</Text>
                        </Pressable>
                    </View>
                    <ScrollView showsVerticalScrollIndicator={false}>
                        {sheet.parts.map((part, i) => (
                            <View key={part.id} testID={`credit-sheet-part-${part.id}`} style={i > 0 ? s.partNext : undefined}>
                                <Text style={s.partTitle} accessibilityRole="header">{i + 1}. {part.title}</Text>
                                {part.rows.map((row, j) => (
                                    <View key={j} style={s.row}>
                                        {part.id !== 'who' && (
                                            <View style={s.markBox} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>{mark(row)}</View>
                                        )}
                                        <View style={{ flex: 1 }}>
                                            <Text style={[s.rowText, (row.mark === 'total' || row.kind) ? { fontWeight: '700' } : null]}>{row.text}</Text>
                                            {row.line ? <Text style={s.rowLine}>{row.line}</Text> : null}
                                        </View>
                                    </View>
                                ))}
                                {part.id === 'who' && (
                                    <View style={{ gap: 8, marginTop: 6 }}>
                                        {onGivers && (
                                            <Pressable accessibilityRole="button" onPress={onGivers} style={s.link} testID="credit-sheet-givers">
                                                <Text style={s.linkText}>{sheet.links.givers}</Text>
                                                <Text style={s.linkText}>›</Text>
                                            </Pressable>
                                        )}
                                        {onGuide && (
                                            <Pressable accessibilityRole="button" onPress={() => onGuide(sheet.links.guideSlug)} style={s.link} testID="credit-sheet-guide">
                                                <Text style={s.linkText}>{sheet.links.guide}</Text>
                                                <Text style={s.linkText}>›</Text>
                                            </Pressable>
                                        )}
                                    </View>
                                )}
                            </View>
                        ))}
                    </ScrollView>
                </Pressable>
            </Pressable>
        </Modal>
    );
}

const styles = (colors: any) => StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 16 },
    card: { width: '100%', maxWidth: 560, maxHeight: '88%', backgroundColor: colors.surface.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: colors.border.default },
    head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 },
    title: { flex: 1, fontSize: 16, lineHeight: 21, fontWeight: '800', color: colors.text.heading },
    close: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    partNext: { marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.border.default },
    partTitle: { fontSize: 14, lineHeight: 19, fontWeight: '800', color: colors.text.heading, marginBottom: 8 },
    row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 8 },
    markBox: { width: 48, minHeight: 18, alignItems: 'center', justifyContent: 'center' },
    rowText: { fontSize: 13.5, lineHeight: 19, color: colors.text.body },
    rowLine: { marginTop: 2, fontSize: 12, lineHeight: 16, color: colors.text.secondary },
    dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 3 },
    figure: { fontSize: 12, lineHeight: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
    pair: { flexDirection: 'row', gap: 4 },
    block: { width: 16, height: 10, borderRadius: 2 },
    blockWide: { width: 20, height: 10, borderRadius: 2 },
    stripes: { width: 32, height: 10, borderRadius: 2, borderWidth: 1, overflow: 'hidden' },
    stripe: { position: 'absolute', top: -6, width: 2, height: 22, transform: [{ rotate: '45deg' }] },
    rainbow: { width: 40, height: 10, borderRadius: 5 },
    half: { width: 24, height: 10, borderRadius: 5 },
    sign: { fontSize: 14, lineHeight: 18, fontWeight: '800' },
    link: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.subtle },
    linkText: { fontSize: 14, fontWeight: '700', color: colors.text.heading, flexShrink: 1 },
});
