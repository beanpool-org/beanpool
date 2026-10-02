import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, Pressable, View, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { DOOR_WORK_PARTS, doorWorkExpectedTries, makeDoorWorkChallenge } from '@beanpool/core';
import { solveOnPhone } from '../utils/door-work';
import { useTheme } from './ThemeContext';

/**
 * Door work on THIS phone: how long the 12-words door's work takes here at each level the door can ask for (two-doors
 * design §3.5 and §7.4: the level table is fixed from measurements on real phones, an old low-end Android above all).
 * Reached at `beanpool://door-work-probe`.
 *
 * It runs the app's own solver (utils/door-work.ts: expo-crypto's native SHA-256 over one reused 64 KB buffer, in short
 * batches) on challenges it makes itself, with a throwaway key: nothing is sent anywhere, and nothing is kept. While it
 * runs, a ticker asks for a turn every 100 ms, and the longest wait between turns is what "the screen stays responsive"
 * means in numbers. Each result is also logged (`[DOOR WORK PROBE]`), for `adb logcat`.
 */

interface LevelResult {
    level: number;
    totalMs: number;
    tries: number;
    partMs: number[];
    estimateMs: number | null;
    longestPauseMs: number;
}

const TICK_MS = 100;

export default function DoorWorkProbe(): React.JSX.Element {
    const { colors } = useTheme();
    const [running, setRunning] = useState<number | null>(null);
    const [results, setResults] = useState<LevelResult[]>([]);
    const [error, setError] = useState<string | null>(null);
    const stopRef = useRef(false);
    useEffect(() => () => { stopRef.current = true; }, []);

    async function measure(levels: number[]) {
        if (running !== null) return;
        setError(null);
        stopRef.current = false;
        for (const level of levels) {
            if (stopRef.current) break;
            setRunning(level);
            // A turn for the screen every 100 ms: the longest gap between turns, minus the 100, is how long it waited.
            let last = Date.now();
            let longest = 0;
            const ticker = setInterval(() => {
                const now = Date.now();
                longest = Math.max(longest, now - last - TICK_MS);
                last = now;
            }, TICK_MS);
            try {
                const challenge = makeDoorWorkChallenge({
                    workKey: randomBytes(32), level, key: bytesToHex(randomBytes(32)), door: 'words',
                });
                const started = Date.now();
                const partEnds: number[] = [];
                let estimateMs: number | null = null;
                const solved = await solveOnPhone(challenge, {
                    onPart: () => { partEnds.push(Date.now()); },
                    onEstimate: (ms) => { estimateMs = ms; },
                    cancelled: () => stopRef.current,
                });
                if (!solved) break;
                const partMs = partEnds.map((t, i) => t - (i === 0 ? started : partEnds[i - 1]));
                const result: LevelResult = { level, totalMs: solved.ms, tries: solved.tries, partMs, estimateMs, longestPauseMs: Math.max(0, longest) };
                console.log(`[DOOR WORK PROBE] level ${level}: total ${solved.ms} ms, ${solved.tries} tries `
                    + `(${(solved.ms / solved.tries).toFixed(3)} ms a try; ${doorWorkExpectedTries(level)} expected), `
                    + `parts [${partMs.join(', ')}] ms, estimate from the first part ${estimateMs ?? 'none'} ms, `
                    + `longest pause for the screen ${result.longestPauseMs} ms`);
                setResults(r => [...r.filter(x => x.level !== level), result].sort((a, b) => a.level - b.level));
            } catch (e) {
                setError(`The solver could not run on this phone: ${(e as Error)?.message ?? e}`);
                break;
            } finally {
                clearInterval(ticker);
            }
        }
        setRunning(null);
    }

    const s = styles(colors);
    return (
        <SafeAreaView style={s.page} edges={['top', 'left', 'right', 'bottom']}>
            <Stack.Screen options={{ title: 'Door work on this phone' }} />
            <ScrollView contentContainerStyle={s.scroll}>
                <Text style={s.title} accessibilityRole="header">Door work on this phone</Text>
                <Text style={s.body}>
                    How long setting up a 12-words account takes on this phone, at each level the global community can ask
                    for. Nothing is sent anywhere, and nothing is kept.
                </Text>
                <Pressable style={[s.button, running !== null && s.disabled]} onPress={() => measure([0, 1, 2, 3])} disabled={running !== null} accessibilityRole="button">
                    <Text style={s.buttonText}>Measure levels 0 to 3</Text>
                </Pressable>
                <Pressable style={[s.secondary, running !== null && s.disabled]} onPress={() => measure([4, 5])} disabled={running !== null} accessibilityRole="button">
                    <Text style={s.secondaryText}>Measure levels 4 and 5 (slow)</Text>
                </Pressable>
                {running !== null && (
                    <View style={s.busy} accessibilityLiveRegion="polite">
                        <ActivityIndicator color={colors.brand.primary} />
                        <Text style={s.small}>Measuring level {running}…</Text>
                    </View>
                )}
                {error && <Text style={s.error}>{error}</Text>}
                {results.map(r => (
                    <View key={r.level} style={s.result} accessible accessibilityLabel={`Level ${r.level}: ${(r.totalMs / 1000).toFixed(1)} seconds`}>
                        <Text style={s.resultTitle}>Level {r.level}: {(r.totalMs / 1000).toFixed(2)} s</Text>
                        <Text style={s.small}>
                            {r.tries} tries, {(r.totalMs / r.tries).toFixed(3)} ms a try ({doorWorkExpectedTries(r.level)} expected on average)
                        </Text>
                        <Text style={s.small}>Each of the {DOOR_WORK_PARTS} parts, ms: {r.partMs.join(', ')}</Text>
                        <Text style={s.small}>Estimate from the first part: {r.estimateMs === null ? 'none' : `${(r.estimateMs / 1000).toFixed(2)} s`}</Text>
                        <Text style={s.small}>Longest the screen waited for a turn: {r.longestPauseMs} ms</Text>
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
        secondary: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, alignItems: 'center', justifyContent: 'center', padding: 12, marginBottom: 8 },
        secondaryText: { color: colors.text.body, fontSize: 15, fontWeight: '700', textAlign: 'center' },
        disabled: { opacity: 0.5 },
        busy: { flexDirection: 'row', alignItems: 'center', marginVertical: 8 },
        small: { fontSize: 13, color: colors.text.secondary, lineHeight: 19, marginLeft: 0, flexShrink: 1 },
        error: { fontSize: 14, color: colors.feedback.danger.fg, marginVertical: 8 },
        result: { borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card, borderRadius: 12, padding: 12, marginTop: 8 },
        resultTitle: { fontSize: 16, fontWeight: '800', color: colors.text.heading, marginBottom: 4 },
    });
}
