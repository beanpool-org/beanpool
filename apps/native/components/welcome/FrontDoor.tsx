/**
 * The front door: the first screen on a phone with no invite on it (DESIGN-onboarding-home-landing-fable.md §3.1 A, slice S1;
 * the iPhone tile from DESIGN-ios-invite-paste-fable.md §4.1; Marty, 21 Nov 2026: "Yes, all of Fable's picks"). One screen in
 * place of "Used BeanPool before?" and the doors: which of three people are you.
 *
 * - A colour block with shapes on top (§4.4: `commit.fill` ground and `commit.on` words; a `gold.fill` sun, a `cta.fill` bean,
 *   a pale `chip.ok.tint` ring, a deeper `commit.hover` wave), so the first thing seen is not a paragraph. The shapes sit in
 *   the corners and carry no words; the fills are the same in every colour set, so light and dark draw the same block.
 * - **I have an invite**, the main button. On an iPhone with iOS 16 or later that holds copied text, the tile instead: our
 *   words over Apple's own paste button with its icon only (`cta.fill` / `cta.on`, large corners, full width, 52 dp, nothing
 *   drawn over it), "Tap to open it", and "Scan or type it instead ›" (utils/invite-arrival.ts says which).
 * - **No invite? Look around**: the global community as a visitor, as Explore did; the line under it when that door can't be
 *   used right now stays exactly as it was, shown only then.
 * - **I've used BeanPool before**: the ways back.
 * - **More ways in ›**: a sheet with "Ask a community to join" and "Claim a server you installed".
 *
 * Nothing waits on anything: every button works whatever the global community has said, offline included.
 */
import { useMemo, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { brandColours } from '@beanpool/core';
import type { AppColors } from '../../constants/colors';
import { useWords } from '../LanguageProvider';
import type { GlobalDoorState } from '../../utils/global-entry';
import { useAfterDismiss } from '../../utils/screen-presented';

/** The block's shapes: one value in every colour set (§4.4), so the light set's are the block's in dark too. */
const SHAPES = brandColours('light');
/** The mark, never translated in any language (scripts/words/GLOSSARY.csv: BeanPool, untranslatable). */
const MARK = 'BeanPool';

export function FrontDoor({ colors, door, exploring = false, appleTile, onInvite, onApplePaste, onScanOrType, onLookAround, onUsedBefore, onAskToJoin, onClaim }: {
    /** The screen's colours (utils/onboarding-colors.ts). */
    colors: AppColors;
    /** What the global community's door said this app start (utils/global-door-offer.ts). */
    door: GlobalDoorState;
    /** Look around is asking the global community (slice S12); a second tap waits. */
    exploring?: boolean;
    /** Draw Apple's icon-only paste button in the invite tile (utils/invite-arrival.ts `inviteDoor`). */
    appleTile: boolean;
    /** Our own "I have an invite". */
    onInvite(): void;
    /** Apple's button handed over what was copied: the screen keeps it only if it is an invite. */
    onApplePaste(text: string): void;
    /** "Scan or type it instead ›" under the tile: the Your invite screen. */
    onScanOrType(): void;
    onLookAround(): void;
    onUsedBefore(): void;
    onAskToJoin(): void;
    onClaim(): void;
}) {
    const { t } = useWords();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const [sheet, setSheet] = useState(false);
    // On iOS a screen pushed while the sheet is still closing is refused: go once it has gone (utils/screen-presented.ts).
    const afterClose = useAfterDismiss<() => void>((go) => go());
    const choose = (go: () => void) => {
        setSheet(false);
        if (Platform.OS === 'ios') afterClose.hold(go);
        else go();
    };
    const line = exploring ? t('Connecting to the global community…')
        : door === 'unreachable' ? t("Can't reach the global community right now. Try again, or join with an invite.")
        : door === 'closed' ? t('Not taking new members right now.')
        : door === 'preview' ? t('This community is in a private preview. Ask its owner for an invite.')
        : null;
    return (
        <View style={styles.door} testID="front-door">
            <View style={styles.block}>
                <View style={styles.shapes} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                    <View style={styles.wave} />
                    <View style={styles.ring} />
                    <View style={styles.sun} />
                    <View style={styles.bean} />
                </View>
                <Text style={styles.name} accessibilityRole="header">{MARK}</Text>
                <Text style={styles.line}>{t('Trade skills, goods and favours with your neighbours.')}</Text>
            </View>

            {appleTile ? (
                <View style={styles.tile} testID="front-door-invite-tile">
                    <Text style={styles.tileTitle}>{t('I have an invite')}</Text>
                    {/* Apple's own button: read with no pop-up, its icon alone. Nothing is drawn over it (Apple checks). */}
                    <Clipboard.ClipboardPasteButton
                        onPress={(data) => { if (data.type === 'text') onApplePaste(data.text); }}
                        acceptedContentTypes={['plain-text', 'url']}
                        displayMode="iconOnly"
                        backgroundColor={colors.action.cta}
                        foregroundColor={colors.text.onBrand}
                        cornerStyle="large"
                        style={styles.appleButton}
                    />
                    <Text style={styles.tileUnder}>{t('Tap to open it')}</Text>
                    <Pressable style={styles.tileLink} onPress={onScanOrType} accessibilityRole="button" testID="front-door-scan-or-type">
                        <Text style={styles.linkText}>{t('Scan or type it instead ›')}</Text>
                    </Pressable>
                </View>
            ) : (
                <Pressable style={styles.mainBtn} onPress={onInvite} accessibilityRole="button" testID="front-door-invite">
                    <Text style={styles.mainBtnText}>{t('I have an invite')}</Text>
                </Pressable>
            )}

            <Pressable style={styles.quietBtn} onPress={onLookAround} disabled={exploring} accessibilityRole="button" accessibilityHint={line ?? undefined} accessibilityState={{ busy: exploring, disabled: exploring }} testID="front-door-look-around">
                <Text style={styles.quietBtnText}>{t('No invite? Look around')}</Text>
            </Pressable>
            {line && <Text style={styles.doorLine} accessibilityLiveRegion="polite">{line}</Text>}
            <Pressable style={styles.quietBtn} onPress={onUsedBefore} accessibilityRole="button" testID="front-door-used-before">
                <Text style={styles.quietBtnText}>{t("I've used BeanPool before")}</Text>
            </Pressable>

            <Pressable style={styles.moreLink} onPress={() => setSheet(true)} accessibilityRole="button" testID="front-door-more">
                <Text style={styles.linkText}>{t('More ways in ›')}</Text>
            </Pressable>

            <Modal visible={sheet} transparent animationType="fade" onRequestClose={() => setSheet(false)} onDismiss={afterClose.release}>
                <Pressable style={styles.backdrop} onPress={() => setSheet(false)} accessibilityRole="button" accessibilityLabel={t('Cancel')}>
                    <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()} testID="front-door-more-sheet">
                        <Pressable style={styles.sheetRow} onPress={() => choose(onAskToJoin)} accessibilityRole="button" testID="welcome-ask-to-join">
                            <Text style={styles.sheetRowText}>{t('Ask a community to join')}</Text>
                        </Pressable>
                        <Pressable style={styles.sheetRow} onPress={() => choose(onClaim)} accessibilityRole="button" testID="welcome-claim-server">
                            <Text style={styles.sheetRowText}>{t('Claim a server you installed')}</Text>
                        </Pressable>
                        <Pressable style={styles.sheetCancel} onPress={() => setSheet(false)} accessibilityRole="button">
                            <Text style={styles.quietBtnText}>{t('Cancel')}</Text>
                        </Pressable>
                    </Pressable>
                </Pressable>
            </Modal>
        </View>
    );
}

function makeStyles(colors: AppColors) {
    return StyleSheet.create({
        door: { width: '100%', alignItems: 'stretch', marginTop: 8 },
        // The colour block: the brand green under white words (5.48:1), shapes in its corners, words never on a shape.
        block: { backgroundColor: colors.brand.fill, borderRadius: 24, overflow: 'hidden', paddingTop: 72, paddingBottom: 28, paddingHorizontal: 22, marginBottom: 20 },
        shapes: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
        wave: { position: 'absolute', width: 260, height: 260, borderRadius: 130, left: -150, bottom: -190, backgroundColor: SHAPES.commit.hover },
        ring: { position: 'absolute', width: 96, height: 96, borderRadius: 48, borderWidth: 10, borderColor: SHAPES.chip.ok.tint, left: -34, top: -38 },
        sun: { position: 'absolute', width: 64, height: 64, borderRadius: 32, right: 18, top: 14, backgroundColor: SHAPES.gold.fill },
        bean: { position: 'absolute', width: 54, height: 30, borderRadius: 15, right: -14, top: 62, backgroundColor: SHAPES.cta.fill, transform: [{ rotate: '-24deg' }] },
        name: { color: colors.text.onBrand, fontSize: 34, fontWeight: '800', marginBottom: 8 },
        line: { color: colors.text.onBrand, fontSize: 17, lineHeight: 24, fontWeight: '600' },
        // The main button: the call to action's terracotta under white words (4.9:1), 52 dp at least; the label wraps.
        mainBtn: { backgroundColor: colors.action.cta, minHeight: 52, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
        mainBtnText: { color: colors.text.onBrand, fontSize: 18, fontWeight: '700', textAlign: 'center' },
        tile: { width: '100%', alignItems: 'center', marginBottom: 12 },
        tileTitle: { color: colors.text.heading, fontSize: 18, fontWeight: '700', textAlign: 'center', marginBottom: 10 },
        appleButton: { width: '100%', height: 52 },
        tileUnder: { color: colors.text.secondary, fontSize: 15, textAlign: 'center', marginTop: 8 },
        tileLink: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
        // The two quiet buttons: an outline, no fill, 52 dp; words in the heading ink on the page.
        quietBtn: { minHeight: 52, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 14, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
        quietBtnText: { color: colors.text.heading, fontSize: 17, fontWeight: '700', textAlign: 'center' },
        doorLine: { fontSize: 15, color: colors.text.secondary, textAlign: 'center', lineHeight: 21, marginTop: -4, marginBottom: 12 },
        moreLink: { alignSelf: 'center', minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
        // The brand green as words (`ink.brand`: emerald-700 in light, emerald-400 in dark).
        linkText: { color: colors.brand.primary, fontSize: 16, fontWeight: '700', textAlign: 'center' },
        backdrop: { flex: 1, backgroundColor: colors.overlay.scrim, justifyContent: 'flex-end' },
        sheet: { backgroundColor: colors.surface.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 16, paddingBottom: 28 },
        sheetRow: { minHeight: 52, justifyContent: 'center', paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: colors.border.default },
        sheetRowText: { color: colors.text.heading, fontSize: 17, fontWeight: '600' },
        sheetCancel: { minHeight: 52, justifyContent: 'center', alignItems: 'center', marginTop: 8 },
    });
}
