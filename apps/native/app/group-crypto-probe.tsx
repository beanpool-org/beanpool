import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, ErrorBoundary } from 'expo-router';

export { ErrorBoundary };
import type { GroupCryptoBenchStep } from '../utils/group-crypto-bench';
import { useTheme } from './ThemeContext';

/**
 * Group-chat locks on THIS phone: how long a 20- and a 200-member rotation, opening one's own wrap, and sealing and opening
 * a 1 KB line and a 100 KB photo take here (group-chat design §15, §17 slice 0; Marty's pick 9 adds
 * react-native-quick-crypto on native only if a 200-member rotation takes over about 5 s on an old phone). Reached at
 * `beanpool://group-crypto-probe` in a development build. Each step is also logged (`[GROUP CRYPTO PROBE]`), for
 * `adb logcat`.
 *
 * ## Why the __DEV__ guard
 *
 * expo-router routes every file under `app/`, so this screen exists in a production build too. The measuring code
 * (utils/group-crypto-bench.ts) is loaded only inside a __DEV__ branch, which a production bundle drops, and the screen
 * says so instead of running.
 */
export default function GroupCryptoProbe(): React.JSX.Element {
    const { colors } = useTheme();
    const [running, setRunning] = useState(false);
    const [steps, setSteps] = useState<GroupCryptoBenchStep[]>([]);
    const [error, setError] = useState<string | null>(null);
    const s = styles(colors);

    if (!__DEV__) {
        return (
            <SafeAreaView style={s.page} edges={['top', 'left', 'right', 'bottom']}>
                <Stack.Screen options={{ title: 'Not available' }} />
                <Text style={s.body}>This screen is a development diagnostic.</Text>
            </SafeAreaView>
        );
    }

    async function measure() {
        if (running) return;
        setRunning(true);
        setError(null);
        setSteps([]);
        // Loaded here and only here, inside __DEV__: a production bundle never holds the measuring code.
        const { runGroupCryptoBench } = require('../utils/group-crypto-bench') as typeof import('../utils/group-crypto-bench');
        console.log('[GROUP CRYPTO PROBE] start', JSON.stringify({ hermes: typeof (globalThis as { HermesInternal?: unknown }).HermesInternal === 'object' }));
        try {
            await runGroupCryptoBench({
                onStep: async (step) => {
                    console.log(`[GROUP CRYPTO PROBE] ${JSON.stringify(step)}`);
                    setSteps((prev) => [...prev, step]);
                    await new Promise((r) => setTimeout(r, 50));
                },
            });
            console.log('[GROUP CRYPTO PROBE] done');
        } catch (e) {
            setError(`The measurement stopped: ${(e as Error)?.message ?? e}`);
            console.log(`[GROUP CRYPTO PROBE] error ${(e as Error)?.message ?? e}`);
        } finally {
            setRunning(false);
        }
    }

    return (
        <SafeAreaView style={s.page} edges={['top', 'left', 'right', 'bottom']}>
            <Stack.Screen options={{ title: 'Group-chat locks on this phone' }} />
            <ScrollView contentContainerStyle={s.scroll}>
                <Text style={s.title} accessibilityRole="header">Group-chat locks on this phone</Text>
                <Text style={s.body}>
                    How long locking a group chat takes here, on throwaway keys. Nothing is sent anywhere, and nothing is kept.
                </Text>
                <Pressable style={[s.button, running && s.disabled]} onPress={measure} disabled={running} accessibilityRole="button">
                    <Text style={s.buttonText}>Measure</Text>
                </Pressable>
                {running && (
                    <View style={s.busy} accessibilityLiveRegion="polite">
                        <ActivityIndicator color={colors.brand.primary} />
                        <Text style={s.small}>Measuring…</Text>
                    </View>
                )}
                {error && <Text style={s.error}>{error}</Text>}
                {steps.map((r) => (
                    <View key={r.name} style={s.result}>
                        <Text style={s.resultTitle}>{r.name}</Text>
                        <Text style={s.small}>First run {r.firstMs} ms; median of the next {r.runs - 1}: {r.medianMs} ms</Text>
                    </View>
                ))}
            </ScrollView>
        </SafeAreaView>
    );
}

function styles(colors: ReturnType<typeof useTheme>['colors']) {
    return StyleSheet.create({
        page: { flex: 1, backgroundColor: colors.surface.page },
        scroll: { padding: 16 },
        title: { fontSize: 20, fontWeight: '800', color: colors.text.heading, marginBottom: 8 },
        body: { fontSize: 15, color: colors.text.body, lineHeight: 22, marginBottom: 12 },
        button: { minHeight: 48, borderRadius: 12, backgroundColor: colors.brand.primary, alignItems: 'center', justifyContent: 'center', padding: 12, marginBottom: 8 },
        buttonText: { color: colors.text.inverse, fontSize: 16, fontWeight: '800', textAlign: 'center' },
        disabled: { opacity: 0.5 },
        busy: { flexDirection: 'row', alignItems: 'center', marginVertical: 8 },
        small: { fontSize: 13, color: colors.text.secondary, lineHeight: 19, flexShrink: 1 },
        error: { fontSize: 14, color: colors.feedback.danger.fg, marginVertical: 8 },
        result: { borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card, borderRadius: 12, padding: 12, marginTop: 8 },
        resultTitle: { fontSize: 15, fontWeight: '700', color: colors.text.heading, marginBottom: 4 },
    });
}
