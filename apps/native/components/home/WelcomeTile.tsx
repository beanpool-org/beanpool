/**
 * The WELCOME TO BEANPOOL! tile at the top of Home (scratch/fable-design/DESIGN-onboarding-home-landing-fable.md §4.1 item 1,
 * §4.2, §4.4; Marty's picks of 21 Nov 2026, slice S5): what How it Works said in 363 words, as three things to know, with
 * "Show me around" (the one-minute tour that exists) and "Got it" (the tour record `skipped`, the one 1.4.7's Not now
 * writes). After seven days it folds to one band, "Welcome to BeanPool ›", with its ×; the band opens the tile again.
 *
 * The look is shapes, never pictures: an amber sun, a terracotta bean, a pale ring cut by the corner, two dots and a deeper
 * wave, each a View from the central tokens (packages/beanpool-core/src/brand-colours.ts). The fills are the same value in
 * every colour set (§4.4), so it is the same tile in light, Classic and Dark. Words sit only on the emerald ground (white,
 * 5.48:1) and on the gold button (charcoal); never on the amber or pale shapes, which stay in the corners.
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { WELCOME_TILE_WORDS, brandColours, t, type WelcomeTileIcon, type WelcomeTileLine } from '@beanpool/core';
import type { AppColors } from '../../constants/colors';
import { HOME_GUTTER_DP, HOME_TARGET_DP } from './HomeParts';

/** The pale ring and the facts' round badges: core's `chip.ok.tint` as the light set has it, on the tile in every set (§4.4). */
const PALE = brandColours('light').chip.ok.tint;

const ICONS: Record<WelcomeTileIcon, React.ComponentProps<typeof MaterialCommunityIcons>['name']> = {
    swap: 'swap-horizontal',
    scale: 'scale-balance',
    zero: 'circle-outline',
    meet: 'account-group-outline',
    none: 'map-marker-radius-outline',
};

/** At least 48 dp to tap (Home's rule, HomeParts HOME_TARGET_DP). */
const TARGET = HOME_TARGET_DP;

export interface WelcomeTileProps {
    shape: 'full' | 'band';
    /** "You're in Riverside." (core welcomeFacts); none when the community's name isn't known. */
    place: string | null;
    /** Whose invite brought them, until the community's own welcome carries the line (slice S7). */
    inviter: string | null;
    firstHere: boolean;
    lines: readonly WelcomeTileLine[];
    /** "Show me around", or "Pick up the tour at step 3 ›" for a tour part way. */
    tourLabel: string;
    colors: AppColors;
    onTour: () => void;
    onGotIt: () => void;
    onSayHello: () => void;
    /** Absent: the reader can't invite here, so "You're the first one here." stands alone. */
    onInvite?: () => void;
}

export function WelcomeTile(props: WelcomeTileProps) {
    const { shape, colors } = props;
    // The band opens the tile again in place, for this visit only: nothing is written by it.
    const [open, setOpen] = useState(false);
    const ground = colors.brand.fill;
    const on = colors.text.onBrand;
    if (shape === 'band' && !open) {
        return (
            <View style={[welcomeTileStyles.band, { backgroundColor: ground }]} testID="home-card-start">
                <Pressable
                    onPress={() => setOpen(true)}
                    style={({ pressed }) => [welcomeTileStyles.bandOpen, pressed && { backgroundColor: colors.brand.fillPressed }]}
                    accessibilityRole="button"
                    accessibilityLabel={t('Welcome to BeanPool')}
                    testID="home-welcome-band-open"
                >
                    <Text style={[welcomeTileStyles.bandText, { color: on }]} numberOfLines={2}>{t('Welcome to BeanPool ›')}</Text>
                </Pressable>
                <Pressable
                    onPress={props.onGotIt}
                    style={({ pressed }) => [welcomeTileStyles.bandX, pressed && { backgroundColor: colors.brand.fillPressed }]}
                    accessibilityRole="button"
                    accessibilityLabel={t('Put the welcome away')}
                    testID="home-welcome-band-x"
                >
                    <Text style={[welcomeTileStyles.bandXText, { color: on }]} importantForAccessibility="no">×</Text>
                </Pressable>
            </View>
        );
    }
    return <FullTile {...props} />;
}

function FullTile({ place, inviter, firstHere, lines, tourLabel, colors, onTour, onGotIt, onSayHello, onInvite }: WelcomeTileProps) {
    const ground = colors.brand.fill;
    const deep = colors.brand.fillPressed;
    const on = colors.text.onBrand;
    const gold = colors.feedback.warning.solid;
    const link = (text: string, onPress: () => void, testID: string, a11y?: string) => (
        <Pressable onPress={onPress} style={welcomeTileStyles.link} accessibilityRole="button" accessibilityLabel={a11y ?? text} testID={testID}>
            <Text style={[welcomeTileStyles.linkText, { color: on }]}>{text}</Text>
        </Pressable>
    );
    return (
        <View style={[welcomeTileStyles.tile, { backgroundColor: ground }]} testID="home-card-start" accessibilityLabel={t('Welcome to BeanPool')}>
            {/* The shapes, behind everything and out of the reader's way. */}
            <View pointerEvents="none" importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
                <View style={[welcomeTileStyles.wave, { backgroundColor: deep }]} />
                <View style={[welcomeTileStyles.sun, { backgroundColor: gold }]} />
                <View style={[welcomeTileStyles.bean, { backgroundColor: colors.action.cta }]} />
                <View style={[welcomeTileStyles.ring, { borderColor: PALE }]} />
                <View style={[welcomeTileStyles.dot1, { backgroundColor: PALE }]} />
                <View style={[welcomeTileStyles.dot2, { backgroundColor: gold }]} />
            </View>
            <Text style={[welcomeTileStyles.title, { color: on }]} accessibilityRole="header" testID="home-welcome-title">{t(WELCOME_TILE_WORDS.title)}</Text>
            {!!place && <Text style={[welcomeTileStyles.place, { color: on }]} testID="home-start-words">{place}</Text>}
            {firstHere ? (
                <View style={welcomeTileStyles.row}>
                    <Text style={[welcomeTileStyles.small, { color: on }]} testID="home-start-first">{t("You're the first one here.")}</Text>
                    {onInvite && link(t('Invite someone ›'), onInvite, 'home-start-invite')}
                </View>
            ) : inviter ? (
                <View style={welcomeTileStyles.row}>
                    <Text style={[welcomeTileStyles.small, { color: on }]} testID="home-start-inviter">{t('{name} invited you.', { name: inviter })}</Text>
                    {link(t('Say hello ›'), onSayHello, 'home-start-hello', t('Say hello to {name}', { name: inviter }))}
                </View>
            ) : null}
            <View style={welcomeTileStyles.facts}>
                {lines.map((l, i) => (
                    <View key={i} style={welcomeTileStyles.fact} testID={`home-welcome-fact-${l.icon}`}>
                        <View style={[welcomeTileStyles.badge, { backgroundColor: PALE }]} importantForAccessibility="no-hide-descendants">
                            <MaterialCommunityIcons name={ICONS[l.icon]} size={20} color={deep} />
                        </View>
                        <Text style={[welcomeTileStyles.factText, { color: on }]}>{l.text}</Text>
                    </View>
                ))}
            </View>
            {/* Side by side where they fit, stacked at 320 dp and 1.3× text. */}
            <View style={welcomeTileStyles.buttons}>
                <Pressable
                    onPress={onTour}
                    style={({ pressed }) => [welcomeTileStyles.button, { backgroundColor: gold }, pressed && { opacity: 0.85 }]}
                    accessibilityRole="button"
                    testID="home-start-look"
                >
                    <Text style={[welcomeTileStyles.buttonText, { color: colors.text.onGold }]}>{tourLabel}</Text>
                </Pressable>
                <Pressable
                    onPress={onGotIt}
                    style={({ pressed }) => [welcomeTileStyles.button, welcomeTileStyles.ghost, { borderColor: on }, pressed && { backgroundColor: deep }]}
                    accessibilityRole="button"
                    testID="home-start-skip"
                >
                    <Text style={[welcomeTileStyles.buttonText, { color: on }]}>{t(WELCOME_TILE_WORDS.gotIt)}</Text>
                </Pressable>
            </View>
        </View>
    );
}

/**
 * First steps' progress ring (§4.1 item 4): a ring that fills by the lines done, drawn from two half-discs that turn behind
 * two clips (Views only, no picture). `hole`: the card's ground, which makes the disc a ring.
 */
export function ProgressRing({ done, of, ink, track, hole, size = 40, stroke = 6 }: {
    done: number; of: number; ink: string; track: string; hole: string; size?: number; stroke?: number;
}) {
    const share = of > 0 ? Math.max(0, Math.min(1, done / of)) : 0;
    const half = size / 2;
    const right = Math.min(share, 0.5) * 360;
    const left = Math.max(0, share - 0.5) * 360;
    const disc = { width: size, height: size } as const;
    return (
        <View style={{ width: size, height: size }} importantForAccessibility="no-hide-descendants" testID="home-steps-ring">
            <View style={[disc, { position: 'absolute', borderRadius: half, borderWidth: stroke, borderColor: track }]} />
            {share > 0 && (
                <View style={{ position: 'absolute', left: half, width: half, height: size, overflow: 'hidden' }}>
                    <View style={[disc, { position: 'absolute', left: -half, transform: [{ rotate: `${right}deg` }] }]}>
                        <View style={{ width: half, height: size, backgroundColor: ink, borderTopLeftRadius: half, borderBottomLeftRadius: half }} />
                    </View>
                </View>
            )}
            {share > 0.5 && (
                <View style={{ position: 'absolute', left: 0, width: half, height: size, overflow: 'hidden' }}>
                    <View style={[disc, { position: 'absolute', left: 0, transform: [{ rotate: `${left}deg` }] }]}>
                        <View style={{ position: 'absolute', left: half, width: half, height: size, backgroundColor: ink, borderTopRightRadius: half, borderBottomRightRadius: half }} />
                    </View>
                </View>
            )}
            <View style={{ position: 'absolute', left: stroke, top: stroke, width: size - 2 * stroke, height: size - 2 * stroke, borderRadius: half - stroke, backgroundColor: hole }} />
        </View>
    );
}

export const welcomeTileStyles = StyleSheet.create({
    tile: { marginHorizontal: HOME_GUTTER_DP, borderRadius: 22, overflow: 'hidden', paddingTop: 86, paddingHorizontal: 16, paddingBottom: 16, marginBottom: 10 },
    // The top of a circle much wider than the tile: a gentle arc behind the buttons.
    wave: { position: 'absolute', width: 720, height: 720, borderRadius: 360, left: -216, bottom: -640 },
    sun: { position: 'absolute', width: 128, height: 128, top: -50, right: -36, borderRadius: 64 },
    bean: { position: 'absolute', width: 78, height: 50, top: 22, right: 86, borderTopLeftRadius: 40, borderTopRightRadius: 26, borderBottomRightRadius: 34, borderBottomLeftRadius: 24, transform: [{ rotate: '-24deg' }] },
    ring: { position: 'absolute', width: 54, height: 54, top: 18, left: -20, borderRadius: 27, borderWidth: 10 },
    dot1: { position: 'absolute', width: 14, height: 14, top: 20, left: 58, borderRadius: 7 },
    dot2: { position: 'absolute', width: 10, height: 10, top: 52, left: 88, borderRadius: 5 },
    title: { fontSize: 28, lineHeight: 30, fontWeight: '900', textTransform: 'uppercase' },
    place: { fontSize: 16, lineHeight: 22, fontWeight: '700', marginTop: 8 },
    row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8 },
    small: { fontSize: 15, lineHeight: 21 },
    link: { minHeight: TARGET, justifyContent: 'center' },
    linkText: { fontSize: 15, fontWeight: '700', textDecorationLine: 'underline' },
    facts: { marginTop: 14, marginBottom: 16, rowGap: 12 },
    fact: { flexDirection: 'row', alignItems: 'flex-start', columnGap: 12 },
    badge: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
    factText: { flex: 1, fontSize: 16, lineHeight: 22, fontWeight: '600', paddingTop: 5 },
    buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
    button: { flexGrow: 1, flexBasis: 130, minHeight: TARGET, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
    ghost: { borderWidth: 2 },
    buttonText: { fontSize: 16, fontWeight: '800', textAlign: 'center' },
    band: { marginHorizontal: HOME_GUTTER_DP, flexDirection: 'row', alignItems: 'center', borderRadius: 16, marginBottom: 10, overflow: 'hidden' },
    bandOpen: { flex: 1, minHeight: TARGET, justifyContent: 'center', paddingLeft: 16, paddingRight: 8, paddingVertical: 8 },
    bandText: { fontSize: 16, lineHeight: 21, fontWeight: '800' },
    bandX: { minWidth: TARGET, minHeight: TARGET, alignItems: 'center', justifyContent: 'center' },
    bandXText: { fontSize: 22, fontWeight: '700' },
});
