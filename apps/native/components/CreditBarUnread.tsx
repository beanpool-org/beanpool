import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { CREDIT_RAINBOW, CREDIT_STANDING_WORDS, t } from '@beanpool/core';

/**
 * CreditBarUnread (phone): the credit card's place on the Ledger before the member's own line is in (round 2 of #3134).
 * Nothing is drawn from an answer that isn't there: an empty answer reads as "no credit line yet", which is untrue for most
 * members, so the card waits for the real one (never a false state: onboarding-no-hard-gates).
 *
 * - Reading: the card's shape only (two quiet bars where the sentences go, the rainbow faded with no dot, no figure, no
 *   mark), and "Loading…" for a screen reader.
 * - Couldn't be read: core's one sentence (CREDIT_STANDING_WORDS.unread) and Try again.
 *
 * The web's twin is apps/pwa/src/components/CreditBarUnread.tsx.
 */
export function CreditBarUnread({ failed, onRetry, colors }: { failed: boolean; onRetry?: () => void; colors: any }) {
    const s = styles(colors);
    if (failed) {
        return (
            <View testID="credit-card-unread">
                <Text style={s.sentence} accessibilityRole="alert">{t(CREDIT_STANDING_WORDS.unread)}</Text>
                {onRetry && (
                    <Pressable accessibilityRole="button" onPress={onRetry} style={s.retry} testID="credit-card-retry">
                        <Text style={s.retryText}>{t('Try again')}</Text>
                    </Pressable>
                )}
            </View>
        );
    }
    return (
        <View testID="credit-card-reading" accessible accessibilityLabel={t('Loading…')} accessibilityState={{ busy: true }}>
            <View style={[s.bar, { width: '40%', height: 16 }]} />
            <View style={[s.bar, { width: '80%', height: 12, marginTop: 8 }]} />
            <View style={s.drawing}>
                <View style={s.track}>
                    <LinearGradient
                        colors={[...CREDIT_RAINBOW.stops]}
                        locations={[...CREDIT_RAINBOW.at]}
                        start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }}
                        style={[StyleSheet.absoluteFill, { borderRadius: 9 }]}
                    />
                </View>
                <View style={[s.bar, { width: '100%', height: 12, marginTop: 17 }]} />
            </View>
        </View>
    );
}

const styles = (colors: any) => StyleSheet.create({
    sentence: { fontSize: 13.5, lineHeight: 18, color: colors.text.body },
    retry: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
    retryText: { fontSize: 13, fontWeight: '800', color: colors.feedback.info.fg, textDecorationLine: 'underline' },
    bar: { borderRadius: 4, backgroundColor: colors.surface.subtle },
    drawing: { marginTop: 8, paddingTop: 28 },
    track: { height: 15, borderRadius: 9, opacity: 0.4, overflow: 'hidden' },
});
