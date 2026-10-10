/**
 * "Roughly where are you?" (design DESIGN-global-sync-by-area §3.2): the signup step after the photo on a community
 * that syncs listings by area (app/profile-setup.tsx), and Settings → Your area (app/your-area.tsx).
 *
 * Use my location takes ONE reading, at low accuracy, and rounds it to its 0.1° area before the request is built
 * (utils/member-area.ts). Type a town is the event form's AddressSearch in the step's own words (no map, no pin; a
 * town or suburb); the pick is rounded the same way. Skip writes
 * nothing. A refusal or a failed save says so in one line and never blocks: Skip is always there, even while a reading
 * or the save waits, and leaving (Skip, Cancel, ← Back) drops whatever answers later. The reading and the save each
 * have a time limit (utils/member-area.ts) that ends in the same one line.
 *
 * Small screens: three stacked full-width controls, each at least 48 dp, and five short lines; holds at 320 dp, 1.3x.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import * as Location from 'expo-location';
import { AREA_TOWN_SEARCH_WORDS, type AddressResult } from '@beanpool/core';
import { AddressSearch } from './AddressSearch';
import { AREA_READING_TIMEOUT_MS, AREA_WORDS, areaWhyLine, withTimeLimit, writeMemberArea, type MemberArea } from '../utils/member-area';
import type { NodeFeatures } from '../utils/node-profile';
import { colors, palette } from '../constants/colors';

interface AreaPickerProps {
    /** The community's address; null when the phone has none (offline join), then only Skip does anything. */
    url: string | null;
    identity: { publicKey: string; privateKey: string } | null;
    features: NodeFeatures | null | undefined;
    /** Saved on the node: the area it stored, and the town's short name when one was typed. */
    onSaved: (area: MemberArea | null, placeName: string | null) => void;
    /** Skip for now (signup) or Cancel (Settings): writes nothing. */
    onSkip: () => void;
    skipLabel?: string;
}

export function AreaPicker({ url, identity, features, onSaved, onSkip, skipLabel = AREA_WORDS.skip }: AreaPickerProps) {
    const [busy, setBusy] = useState<'location' | 'town' | null>(null);
    const [showTown, setShowTown] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Skip, Cancel and leaving the step (← Back, the screen closing) move this on: a reading or an answer that comes
    // after is dropped, so nothing is sent and onSaved isn't called once the member has gone on (review B2).
    const generation = useRef(0);
    const saving = useRef<AbortController | null>(null);
    const drop = () => {
        generation.current += 1;
        saving.current?.abort();
        saving.current = null;
    };
    useEffect(() => drop, []);

    const save = async (point: { lat: number; lng: number }, placeName: string | null, kind: 'location' | 'town', gen: number) => {
        if (!url || !identity) { setBusy(null); setError("Couldn't reach the community. Skip for now and set it later in Settings."); return; }
        setBusy(kind);
        setError(null);
        const stop = new AbortController();
        saving.current = stop;
        const result = await writeMemberArea(url, identity, point, { signal: stop.signal });
        if (gen !== generation.current) return;
        saving.current = null;
        setBusy(null);
        if (result.ok) onSaved(result.area, placeName);
        else setError(result.error);
    };

    const useMyLocation = async () => {
        const gen = generation.current;
        setError(null);
        try {
            let { status } = await Location.getForegroundPermissionsAsync();
            if (status !== 'granted') status = (await Location.requestForegroundPermissionsAsync()).status;
            if (gen !== generation.current) return;
            if (status !== 'granted') {
                setError('Location is off for BeanPool. Type a town instead, or skip for now.');
                return;
            }
            setBusy('location');
            const loc = await withTimeLimit(Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low }), AREA_READING_TIMEOUT_MS);
            if (gen !== generation.current) return;
            if (!loc) throw new Error('no reading in time');
            await save({ lat: loc.coords.latitude, lng: loc.coords.longitude }, null, 'location', gen);
        } catch {
            if (gen !== generation.current) return;
            setBusy(null);
            setError("Couldn't read your location. Type a town instead, or skip for now.");
        }
    };

    const pickTown = (result: AddressResult) => {
        void save({ lat: result.lat, lng: result.lng }, result.shortName || result.displayName, 'town', generation.current);
    };

    const skip = () => {
        drop();
        setBusy(null);
        onSkip();
    };

    return (
        <View>
            <Text style={styles.title} accessibilityRole="header">{AREA_WORDS.title}</Text>
            <Text style={styles.body}>{areaWhyLine(features)}</Text>
            <Text style={styles.body}>{AREA_WORDS.privacy}</Text>

            <Pressable
                style={[styles.primaryBtn, busy !== null && styles.disabledBtn]}
                disabled={busy !== null}
                onPress={useMyLocation}
                accessibilityRole="button"
                accessibilityLabel={AREA_WORDS.useLocation}
                accessibilityState={{ disabled: busy !== null, busy: busy === 'location' }}
                testID="area-use-location"
            >
                {busy === 'location'
                    ? <ActivityIndicator color={colors.text.inverse} />
                    : <Text style={styles.primaryBtnText}>📍 {AREA_WORDS.useLocation}</Text>}
            </Pressable>

            <Pressable
                style={[styles.secondaryBtn, busy !== null && styles.disabledBtn]}
                disabled={busy !== null}
                onPress={() => { setError(null); setShowTown((v) => !v); }}
                accessibilityRole="button"
                accessibilityLabel={AREA_WORDS.typeTown}
                accessibilityState={{ disabled: busy !== null, expanded: showTown }}
                testID="area-type-town"
            >
                <Text style={styles.secondaryBtnText}>🔎 {AREA_WORDS.typeTown}</Text>
            </Pressable>
            {showTown && (
                <View style={styles.townBox} testID="area-town-search">
                    <AddressSearch onPick={pickTown} accent={palette.blue600} words={AREA_TOWN_SEARCH_WORDS} />
                    {busy === 'town' && <ActivityIndicator style={styles.townSpinner} color={palette.blue600} accessibilityLabel="Saving your area" />}
                </View>
            )}

            {error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}

            <Pressable
                style={styles.skipBtn}
                onPress={skip}
                accessibilityRole="button"
                accessibilityLabel={skipLabel}
                testID="area-skip"
            >
                <Text style={styles.skipText}>{skipLabel}</Text>
            </Pressable>

            <Text style={styles.footnote}>{AREA_WORDS.later}</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    title: { fontSize: 24, fontWeight: '800', color: colors.text.heading, marginBottom: 6 },
    body: { fontSize: 14, color: colors.text.secondary, marginBottom: 10, lineHeight: 20 },
    primaryBtn: { backgroundColor: palette.blue600, borderRadius: 12, padding: 14, minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 6, marginBottom: 10 },
    primaryBtnText: { color: colors.text.inverse, fontSize: 16, fontWeight: '700', textAlign: 'center' },
    secondaryBtn: {
        backgroundColor: colors.surface.subtle, borderRadius: 12, padding: 14, minHeight: 48, alignItems: 'center', justifyContent: 'center',
        marginBottom: 10, borderWidth: 1, borderColor: colors.border.strong,
    },
    secondaryBtnText: { color: colors.text.body, fontSize: 15, fontWeight: '600', textAlign: 'center' },
    disabledBtn: { opacity: 0.5 },
    townBox: { marginBottom: 10 },
    townSpinner: { marginTop: 8 },
    error: { color: palette.red600 || '#dc2626', fontSize: 13, marginBottom: 8, textAlign: 'center' },
    skipBtn: { minHeight: 48, padding: 12, alignItems: 'center', justifyContent: 'center' },
    skipText: { color: colors.text.secondary, fontSize: 15, fontWeight: '600', textDecorationLine: 'underline' },
    footnote: { fontSize: 13, color: colors.text.muted, textAlign: 'center', lineHeight: 18, marginTop: 4 },
});
