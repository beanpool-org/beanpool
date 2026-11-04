/**
 * Lights-out H2: the one banner while the phone is on the hall laptop (scratch/fable-design/DESIGN-lights-out-plain-ip-fable.md
 * §2.5, §3.5), driven by the node's own switch (`lightsOut` in its health), never by guessing at the internet.
 *
 *   - On the hall laptop: "No internet. You're on the hall laptop." and, when the node knows it, "The record is as of
 *     Tue 3 Nov, 14:02. Trades made since then on the old server are not here." The notice colours (feedback.warning).
 *   - The laptop gone and the phone's own address answering again: "byron.beanpool.org answers again. Go back to it?" with
 *     Go back (the one card; nothing moves until the member taps).
 *   - Gone home by itself when the owner switched lights-out off: "The internet is back: you're on byron.beanpool.org
 *     again.", until the member taps OK.
 *
 * Nothing at all on a phone that never opened the hall door: utils/hall.ts hallTick reads the phone's own memory and asks
 * no node. The lines wrap (no line limit, no fixed height): at 320 dp and 1.3x text they take as many lines as they need.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import { t } from '@beanpool/core';
import { useTheme } from '../app/ThemeContext';
import type { AppColors } from '../constants/colors';
import { dismissBackHome, goHome, hallBannerLines, hallDepsWith, hallTick, type HallView } from '../utils/hall';

/** How often the banner looks again while the app is open. Reads the phone's memory only, unless it is in a hall. */
const TICK_MS = 60_000;

export interface HallBannerViewProps {
    view: HallView;
    colors: AppColors;
    busy?: boolean;
    onGoHome?: () => void;
    onDismiss?: () => void;
}

/** The banner as drawn, for one view (pure: the container below and the render test both use it). */
export function HallBannerView({ view, colors, busy, onGoHome, onDismiss }: HallBannerViewProps) {
    const { title, detail } = hallBannerLines(view);
    const tone = view.kind === 'in-hall' ? colors.feedback.warning : colors.feedback.info;
    const textStyle = { color: tone.fg, fontSize: 14, lineHeight: 20, flexShrink: 1 } as const;
    return (
        <View
            testID="hall-banner"
            accessibilityRole="summary"
            style={{ backgroundColor: tone.bg, borderBottomWidth: 1, borderColor: tone.border, paddingHorizontal: 16, paddingVertical: 8 }}
        >
            <Text testID="hall-banner-title" style={{ ...textStyle, fontWeight: '700' }}>{title}</Text>
            {detail ? <Text testID="hall-banner-detail" style={textStyle}>{detail}</Text> : null}
            {view.kind === 'home-answers' ? (
                <Pressable
                    testID="hall-banner-go-home"
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={onGoHome}
                    style={{ alignSelf: 'flex-start', marginTop: 6, paddingHorizontal: 14, paddingVertical: 8, minHeight: 44, justifyContent: 'center', borderRadius: 8, backgroundColor: colors.brand.fill, opacity: busy ? 0.6 : 1 }}
                >
                    <Text style={{ color: colors.text.onBrand, fontSize: 14, fontWeight: '700' }}>{t('Go back')}</Text>
                </Pressable>
            ) : null}
            {view.kind === 'back-home' ? (
                <Pressable
                    testID="hall-banner-dismiss"
                    accessibilityRole="button"
                    onPress={onDismiss}
                    style={{ alignSelf: 'flex-start', marginTop: 4, paddingVertical: 8, minHeight: 44, justifyContent: 'center' }}
                >
                    <Text style={{ color: tone.fg, fontSize: 14, fontWeight: '700' }}>{t('OK')}</Text>
                </Pressable>
            ) : null}
        </View>
    );
}

/** The banner under the header (app/(tabs)/_layout.tsx): looks at start, on each return to the app, and each minute. */
export function HallBanner() {
    const { colors } = useTheme();
    const [view, setView] = useState<HallView | null>(null);
    const [busy, setBusy] = useState(false);
    const looking = useRef(false);

    const look = useCallback(async () => {
        if (looking.current) return;
        looking.current = true;
        try {
            setView(await hallTick(await hallDepsWith()));
        } catch {
            // The banner keeps what it showed; the next look tries again.
        } finally {
            looking.current = false;
        }
    }, []);

    useEffect(() => {
        void look();
        const timer = setInterval(() => { if (AppState.currentState === 'active') void look(); }, TICK_MS);
        const sub = AppState.addEventListener('change', (s) => { if (s === 'active') void look(); });
        return () => { clearInterval(timer); sub.remove(); };
    }, [look]);

    if (!view) return null;
    return (
        <HallBannerView
            view={view}
            colors={colors}
            busy={busy}
            onGoHome={async () => {
                setBusy(true);
                try {
                    await goHome(await hallDepsWith());
                } catch {
                    // Nothing moved (the carry says so); the card stays for another tap.
                } finally {
                    setBusy(false);
                    void look();
                }
            }}
            onDismiss={() => { dismissBackHome(); setView(null); }}
        />
    );
}
