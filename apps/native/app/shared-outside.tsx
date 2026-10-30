import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, ErrorBoundary } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { PEEK_WORDS as W, formatDate, t, word, type PeekShare } from '@beanpool/core';
import { useStyles } from './ThemeContext';
import { fetchPeekShares, stopPeekShare } from '../utils/peek';

export { ErrorBoundary };

const SHARED_SCREEN_WORDS = {
    title: word('SHARED OUTSIDE'),
    intro: word('Each link opens one post for anyone who has it, without names or faces, until the date shown.'),
    unreadable: word("Couldn't read your links from your community. Check your connection and try again."),
} as const;

/**
 * Settings → Shared outside (front doors S6, scratch/fable-design/DESIGN-entry-points-fable.md §3.4): the links this
 * member shared outside the community that still open their post, each with when it stops, and Stop sharing. Read from
 * the member's own community (utils/peek.ts), so the phone and the web list the same links. Reached only where the
 * community lets members share outside ((tabs)/settings.tsx).
 */
export default function SharedOutsideScreen() {
    const insets = useSafeAreaInsets();
    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: theme === 'dark' ? colors.surface.card : colors.text.heading },
        backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
        backIcon: { color: colors.text.inverse },
        headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: 'bold', color: colors.brand.onDark, letterSpacing: 0.5 },
        scroll: { padding: 16, gap: 12 },
        intro: { fontSize: 15, color: colors.text.body, lineHeight: 21 },
        item: { backgroundColor: colors.surface.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, padding: 14, gap: 6 },
        itemTitle: { fontSize: 16, fontWeight: '800', color: colors.text.heading },
        itemSub: { fontSize: 14, color: colors.text.secondary },
        stop: { alignSelf: 'flex-start', minHeight: 44, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1, borderColor: colors.feedback.danger.fg, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
        stopText: { color: colors.feedback.danger.fg, fontSize: 15, fontWeight: '700', textAlign: 'center' },
        empty: { fontSize: 15, color: colors.text.secondary, lineHeight: 21 },
        refusal: { fontSize: 15, color: colors.feedback.warning.fg, lineHeight: 21 },
        secondary: { alignSelf: 'flex-start', minHeight: 48, paddingHorizontal: 18, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center' },
        secondaryText: { color: colors.text.body, fontSize: 16, fontWeight: '700', textAlign: 'center' },
    }));

    const [shares, setShares] = useState<PeekShare[] | 'loading' | 'failed'>('loading');
    const [stopping, setStopping] = useState<string | null>(null);
    const load = useCallback(() => {
        setShares('loading');
        fetchPeekShares().then(setShares, () => setShares('failed'));
    }, []);
    useEffect(() => { load(); }, [load]);

    const stop = (s: PeekShare) => {
        Alert.alert(t(W.stopSharing), t(W.stoppedNow), [
            { text: t('Cancel'), style: 'cancel' },
            {
                text: t(W.stopSharing), style: 'destructive',
                onPress: async () => {
                    setStopping(s.id);
                    try {
                        await stopPeekShare(s.id);
                        setShares(prev => (Array.isArray(prev) ? prev.filter(x => x.id !== s.id) : prev));
                    } catch (e: any) {
                        Alert.alert(t('Not changed'), e?.message || t('Please try again.'));
                    } finally {
                        setStopping(null);
                    }
                },
            },
        ]);
    };

    const leave = () => (router.canGoBack() ? router.back() : router.replace('/'));
    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <StatusBar style="light" />
            <View style={styles.header}>
                <Pressable onPress={leave} style={styles.backButton} accessibilityRole="button" accessibilityLabel={t('Back')}>
                    <MaterialCommunityIcons name="arrow-left" size={24} style={styles.backIcon} />
                </Pressable>
                <Text style={styles.headerTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} accessibilityRole="header">{t(SHARED_SCREEN_WORDS.title)}</Text>
                <View style={styles.backButton} />
            </View>
            <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: 24 + insets.bottom }]}>
                <Text style={styles.intro}>{t(SHARED_SCREEN_WORDS.intro)}</Text>
                {shares === 'loading' && <ActivityIndicator style={{ marginTop: 16 }} />}
                {shares === 'failed' && (
                    <>
                        <Text style={styles.refusal}>{t(SHARED_SCREEN_WORDS.unreadable)}</Text>
                        <Pressable style={styles.secondary} onPress={load} accessibilityRole="button">
                            <Text style={styles.secondaryText}>{t('Try again')}</Text>
                        </Pressable>
                    </>
                )}
                {Array.isArray(shares) && shares.length === 0 && <Text style={styles.empty} testID="shared-outside-none">{t(W.sharedOutsideNone)}</Text>}
                {Array.isArray(shares) && shares.map(s => (
                    <View key={s.id} style={styles.item} testID="shared-outside-item">
                        <Text style={styles.itemTitle}>{s.title ?? t(W.postGone)}</Text>
                        <Text style={styles.itemSub}>{t(W.worksUntil, { date: formatDate(new Date(s.expiresAt), 'day-month') })}</Text>
                        <Pressable style={[styles.stop, stopping === s.id && { opacity: 0.6 }]} onPress={() => stop(s)} disabled={stopping === s.id}
                            accessibilityRole="button" testID="shared-outside-stop">
                            <Text style={styles.stopText}>{t(W.stopSharing)}</Text>
                        </Pressable>
                    </View>
                ))}
            </ScrollView>
        </SafeAreaView>
    );
}
