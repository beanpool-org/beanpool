import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
    CREDIT_RAINBOW,
    creditBarPicture,
    creditLabelColours,
    creditMeterColours,
    creditNoteColours,
    creditStandingCard,
    type BrandSet,
    type CreditStandingAnswer,
} from '@beanpool/core';

/**
 * CreditBar (phone): the member's own credit card on the Ledger (DESIGN-credit-bar-amend-fable.md, slice R1; Marty, 14 Nov
 * 2026). The rainbow stays: same track, same dot (white with a dark ring in every look, F15), same label above it. Around
 * it: two sentences with the totals, the limit at the bar's left end, "+200" at its own place, a word or two under each
 * mark, the strip under the left half that shows what the line is made of (solid: earned by trading; outlined: someone
 * stands behind it), stripes over the part Offers have not opened, one note, and the parts line, always the whole line.
 *
 * Every figure and sentence comes from core's credit-standing.ts, the same as the web's card: nothing is composed here.
 * The Ledger wraps it in the one button (its label is `creditStandingCard().spoken`); the drawing is hidden from screen
 * readers. Colours: the rainbow is core's picture (CREDIT_RAINBOW); everything else a library role for the look (`set`).
 * Every money figure in `answer` is whole hundredths of a Bean, as the node sends it.
 */
export function CreditBar({ answer, colors, set }: { answer: CreditStandingAnswer; colors: any; set: BrandSet }) {
    const card = creditStandingCard(answer);
    const pic = creditBarPicture(answer);
    const meter = creditMeterColours(set);
    const label = creditLabelColours(pic.tone, meter);
    const note = card.note ? { ...card.note, ...creditNoteColours(card.note.tone, meter) } : null;
    const { limit, zero, fee } = pic.marks;
    const [barW, setBarW] = useState(0);
    const [tag, setTag] = useState({ w: 0, h: 22 });
    // The label sits over the dot, kept inside the card at either end; its pointer stays over the dot.
    const dotX = (pic.dot / 100) * barW;
    const tagLeft = barW > 0 ? Math.max(0, Math.min(barW - tag.w, dotX - tag.w / 2)) : 0;
    const pointerLeft = Math.max(6, Math.min(tag.w - 14, dotX - tagLeft - 4));
    const stripesW = pic.stripes ? (pic.stripes.width / 100) * barW : 0;
    const s = styles(colors);
    return (
        <View>
            <View style={s.headRow}>
                <Text style={s.headline} testID="credit-headline">{card.headline}</Text>
                <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                    <MaterialCommunityIcons name="information-outline" size={20} color={colors.text.secondary} />
                </View>
            </View>
            <Text style={s.sentence} testID="credit-sentence">{card.sentence}</Text>

            {/* The drawing: hidden from screen readers, whose label (the button's) says it all. */}
            <View
                style={[s.drawing, { paddingTop: tag.h + 7 }]}
                importantForAccessibility="no-hide-descendants"
                accessibilityElementsHidden
                testID="credit-drawing"
                onLayout={(e) => setBarW(e.nativeEvent.layout.width)}
            >
                <View style={s.track}>
                    <LinearGradient
                        colors={[...CREDIT_RAINBOW.stops]}
                        locations={[...CREDIT_RAINBOW.at]}
                        start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }}
                        style={[StyleSheet.absoluteFill, { borderRadius: 9 }]}
                    />
                    {pic.stripes && (
                        <View testID="credit-stripes" style={[s.stripes, { left: `${pic.stripes.from}%`, width: `${pic.stripes.width}%` }]}>
                            {Array.from({ length: Math.ceil(stripesW / 7) + 3 }, (_, i) => (
                                <View key={i} style={[s.stripe, { left: i * 7 - 10 }]} />
                            ))}
                        </View>
                    )}
                    <View style={s.zero} />
                    <View style={[s.dot, { left: `${pic.dot}%` }]} />
                </View>

                <View
                    style={[s.tag, { left: tagLeft, backgroundColor: label.fill }]}
                    onLayout={(e) => setTag({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
                    testID="credit-bar-bubble"
                >
                    <Text style={[s.tagText, { color: label.on }]} testID="credit-bar-label">{pic.label}</Text>
                    <View style={[s.pointer, { left: pointerLeft, borderTopColor: label.fill }]} />
                </View>

                {/* The strip under the left half, to scale; the +200 stem under the right. */}
                <View style={s.strip} testID="credit-strip">
                    {pic.blocks.map((b, i) => (
                        <View key={i} testID={`credit-block-${b.kind}`} style={[s.blockSlot, { left: `${b.from}%`, width: `${b.width}%` }]}>
                            <View style={[s.block, b.solid ? { backgroundColor: meter.strip } : { borderWidth: 1.5, borderColor: meter.strip }]} />
                        </View>
                    ))}
                    <View style={[s.stem, { left: `${fee.at}%`, backgroundColor: meter.feeInk }]} />
                </View>

                {/* The figures at their marks and a word or two under each, in three columns that grow with the text. */}
                <View style={s.marks}>
                    <View style={s.markLeft}>
                        {limit.figure ? <Text style={[s.figure, { color: meter.limitInk }]}>{limit.figure}</Text> : null}
                        <Text style={s.words}>{limit.words}</Text>
                    </View>
                    <View style={s.markMid}>
                        <Text style={[s.figure, { color: meter.zeroInk }]}>⚖️ {zero.figure}</Text>
                        <Text style={[s.words, { textAlign: 'center' }]}>{zero.words}</Text>
                    </View>
                    <View style={s.markRight}>
                        <Text style={[s.figure, { color: meter.feeInk }]}>{fee.figure}</Text>
                        <Text style={s.words}>{fee.words}</Text>
                    </View>
                </View>
            </View>

            {note && (
                <View style={[s.note, { backgroundColor: note.tint }]} testID="credit-note">
                    <Text style={[s.noteMark, { color: note.ink }]}>{note.icon}</Text>
                    <Text style={[s.noteText, { color: note.ink }]}>{note.text}</Text>
                </View>
            )}
            {card.parts && <Text style={s.parts} testID="credit-parts">{card.parts}</Text>}
        </View>
    );
}

const styles = (colors: any) => StyleSheet.create({
    headRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
    headline: { flex: 1, fontSize: 16, lineHeight: 20, fontWeight: '800', color: colors.text.heading },
    sentence: { marginTop: 3, fontSize: 13.5, lineHeight: 18, color: colors.text.body },
    drawing: { position: 'relative', marginTop: 8 },
    track: { height: 15, borderRadius: 9 },
    stripes: { position: 'absolute', top: 0, bottom: 0, overflow: 'hidden', borderRightWidth: 2, borderRightColor: colors.surface.card },
    stripe: { position: 'absolute', top: -8, width: 3, height: 32, backgroundColor: colors.surface.card, transform: [{ rotate: '45deg' }] },
    zero: { position: 'absolute', left: '50%', marginLeft: -1, top: -3, bottom: -3, width: 2, backgroundColor: CREDIT_RAINBOW.zeroLine },
    dot: {
        position: 'absolute', top: '50%', marginTop: -9, marginLeft: -9, width: 18, height: 18, borderRadius: 9,
        backgroundColor: CREDIT_RAINBOW.dot, borderWidth: 4, borderColor: CREDIT_RAINBOW.ring, zIndex: 2,
    },
    tag: { position: 'absolute', top: 0, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 7, zIndex: 3 },
    tagText: { fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
    pointer: {
        position: 'absolute', bottom: -5, width: 0, height: 0,
        borderLeftWidth: 4, borderRightWidth: 4, borderTopWidth: 5, borderLeftColor: 'transparent', borderRightColor: 'transparent',
    },
    strip: { position: 'relative', height: 9, marginTop: 5 },
    blockSlot: { position: 'absolute', top: 0, bottom: 0, paddingHorizontal: 1 },
    block: { flex: 1, borderRadius: 2 },
    stem: { position: 'absolute', top: -5, height: 14, width: 2, marginLeft: -1 },
    marks: { flexDirection: 'row', marginTop: 3 },
    markLeft: { width: '36%', paddingRight: 4 },
    markMid: { width: '28%', alignItems: 'center', paddingHorizontal: 2 },
    markRight: { width: '36%', paddingLeft: 2 },
    figure: { fontSize: 12, lineHeight: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
    words: { fontSize: 12, lineHeight: 15, color: colors.text.secondary },
    note: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginTop: 10, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 9 },
    noteMark: { fontSize: 12.5, lineHeight: 17, fontWeight: '800', minWidth: 14, textAlign: 'center' },
    noteText: { flex: 1, fontSize: 12.5, lineHeight: 17 },
    parts: { marginTop: 10, paddingTop: 9, borderTopWidth: 1, borderTopColor: colors.border.default, fontSize: 12.5, lineHeight: 19, color: colors.text.body },
});
