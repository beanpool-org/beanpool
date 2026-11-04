/**
 * The Market's style box on the phone (DESIGN-card-style-box-fable.md §1, slice P2; Marty, 4 Nov 2026: "make them look like
 * they came out of the same style box"). The numbers are core's (`@beanpool/core` market-card-shell.ts); this module turns
 * them into the phone's styles, with the colours from the central tokens (constants/colors.ts, light and dark). Every Market
 * card reads its shell, its picture slot and its chips from here, so an Offer, a Need and an event cannot drift apart.
 *
 *     NO SCREEN WRITES A RADIUS, A CHIP SIZE OR A CARD COLOUR OF ITS OWN.
 *
 * A list card takes its natural height from its lines (Marty, 4 Nov: "the big card doesnt need to conform to the same
 * size"): nothing here fixes it, the picture slot stretches to it.
 */
import { createElement } from 'react';
import { StyleSheet, Text, View, type TextStyle } from 'react-native';
import { MARKET_CARD_SHELL as SHELL, MARKET_CARD_TYPE, MARKET_CHIP, type CardType } from '@beanpool/core';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';

type Colors = ThemeContextType['colors'];

/** A piece of core's type scale as a Text style: size, weight, and the line height where the design fixes one. */
export function cardType({ size, weight, line }: CardType): TextStyle {
    const style: TextStyle = { fontSize: size, fontWeight: String(weight) as TextStyle['fontWeight'] };
    if (line !== undefined) style.lineHeight = line;
    return style;
}

/**
 * The chip set (§1.2): one chip, ten roles, each a core colour pair. OFFER / NEED are chip.ok / chip.need, EVENT and UPDATED
 * the event tile, POLL chip.poll, 📌 PINNED chip.accent, RECURRING / a category / a group's lock chip.quiet, money and
 * caution (CASH TOO, PULSE, a deal asked) chip.warn, a deal held chip.ok, CANCELLED chip.danger, 👤 YOU chip.info.
 */
export type CardChipRole = 'offer' | 'need' | 'event' | 'poll' | 'pinned' | 'quiet' | 'warn' | 'ok' | 'danger' | 'info';

export function chipTones(colors: Colors): Record<CardChipRole, { bg: string; fg: string }> {
    return {
        offer: colors.market.offer,
        need: colors.market.need,
        event: { bg: colors.tile.event.tint, fg: colors.tile.event.ink },
        poll: colors.market.poll,
        pinned: { bg: colors.accent.tint, fg: colors.accent.primary },
        quiet: colors.chip.quiet,
        warn: { bg: colors.feedback.warning.bg, fg: colors.feedback.warning.fg },
        ok: colors.market.offer,
        danger: { bg: colors.feedback.danger.bg, fg: colors.feedback.danger.fg },
        info: colors.chip.info,
    };
}

const LIST = MARKET_CARD_TYPE.list;
const SLOT = SHELL.photo.list.width;

/** The box's styles for one theme. `useCardShell()` is this, made once per theme. */
export function makeCardShell(colors: Colors) {
    const slot = {
        width: SLOT,
        minHeight: SLOT,
        alignSelf: 'stretch' as const,
        borderTopLeftRadius: SHELL.radius,
        borderBottomLeftRadius: SHELL.radius,
    };
    const styles = StyleSheet.create({
        /** The card: corners, the 1 dp border, the card ground, the one shadow, the gap under it. */
        card: {
            backgroundColor: colors.surface.card,
            borderRadius: SHELL.radius,
            borderWidth: SHELL.borderWidth,
            borderColor: colors.border.default,
            overflow: 'hidden',
            marginBottom: SHELL.gap.list,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: SHELL.shadow.offsetY },
            shadowOpacity: SHELL.shadow.opacity,
            shadowRadius: SHELL.shadow.blur,
            elevation: SHELL.shadow.elevation,
        },
        /** The list card: the picture slot on the left, the text column beside it, no padding round the picture. */
        list: { flexDirection: 'row', padding: 0 },
        /**
         * The list card's picture: 80 wide, flush under the card's left corners, the card's full height (stretched by the row,
         * 80 at least). Never a percentage height, which Yoga reads against the whole list (market-card-height-layout.test.ts).
         */
        listPhoto: slot,
        /** The same slot as a box, for the category tile that holds it until the photo has drawn. */
        listPhotoBox: { ...slot, overflow: 'hidden' },
        /** The text column: 12 all round. */
        listText: { flex: 1, minWidth: 0, padding: SHELL.textPadding, justifyContent: 'center' },
        /** A row of chips: they wrap, never shrink. */
        chipRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
        /** The one chip: padding 6 across, 2 down, corners 6. */
        chip: {
            flexShrink: 0,
            maxWidth: '100%',
            paddingHorizontal: MARKET_CHIP.paddingHorizontal,
            paddingVertical: MARKET_CHIP.paddingVertical,
            borderRadius: MARKET_CHIP.radius,
        },
        /** Its words: 10/800, one line. */
        chipText: cardType(MARKET_CHIP.type),
        /** The list card's lines (§1.3). */
        loud: { ...cardType(LIST.loud), color: colors.text.body },
        second: { ...cardType(LIST.second), color: colors.text.body },
        place: { ...cardType(LIST.place), color: colors.text.secondary },
        distance: { ...cardType(LIST.distance), color: colors.text.secondary },
        /** Going ✓ / Interested ✓, You're hosting this event: words, never a control, in the event's ink. */
        mark: { ...cardType(LIST.mark), color: colors.tile.event.ink },
    });
    return { ...styles, tones: chipTones(colors) };
}

export type CardShell = ReturnType<typeof makeCardShell>;

/** The box for the theme being drawn. */
export function useCardShell(): CardShell {
    return useStyles(({ colors }) => makeCardShell(colors));
}

/** One chip of the set: its role's ground and ink, the one size, one line. */
export function CardChip({ shell, role, label, testID }: { shell: CardShell; role: CardChipRole; label: string; testID?: string }) {
    const tone = shell.tones[role];
    return createElement(View, { testID, style: [shell.chip, { backgroundColor: tone.bg }] },
        createElement(Text, { style: [shell.chipText, { color: tone.fg }], numberOfLines: 1 }, label));
}
