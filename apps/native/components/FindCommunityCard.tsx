import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { router } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme, useStyles } from '../app/ThemeContext';
import { useIdentity } from '../app/IdentityContext';
import {
    fetchGlobalHome, findCommunityCardCopy, communityLabel, communityFacts, watchPlace,
    type Fetched, type GlobalHome, type Point,
} from '../utils/community-directory';
import { rememberedKnocks, readKnockStatus, cardKnockLines, type KnockStatusResult, type RememberedKnock } from '../utils/knock';

/**
 * "Find your community" (design §3.1): on top of the worldwide community's Market, the way out to a local one.
 * One request to the global node for everything it shows (`/api/global/home`), plus the answers to this phone's
 * own knocks, read from the communities it asked. Three actions: communities near you, start one, or be told
 * when one starts here. Built as a card so the home dashboard can host it later (D5).
 */
export function FindCommunityCard({ point }: { point: Point | null }) {
    const { colors } = useTheme();
    const { identity } = useIdentity();
    const [home, setHome] = useState<Fetched<GlobalHome> | null>(null);
    const [asked, setAsked] = useState<RememberedKnock[]>([]);
    const [statuses, setStatuses] = useState<Record<string, KnockStatusResult | null>>({});
    const [watchNote, setWatchNote] = useState<string | null>(null);

    const styles = useStyles(({ colors }) => StyleSheet.create({
        card: { marginHorizontal: 16, marginBottom: 10, borderRadius: 14, borderWidth: 1, borderColor: colors.brand.primary, backgroundColor: colors.brand.tint, padding: 14 },
        title: { fontSize: 16, fontWeight: '800', color: colors.text.heading },
        body: { fontSize: 14, color: colors.text.body, lineHeight: 20, marginTop: 4 },
        line: { fontSize: 14, color: colors.text.body, lineHeight: 20, marginTop: 6, fontWeight: '600' },
        nearest: { fontSize: 13, color: colors.text.secondary, marginTop: 2, lineHeight: 18 },
        actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
        action: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 12, borderRadius: 22, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, flexShrink: 1 },
        actionMain: { backgroundColor: colors.brand.primary, borderColor: colors.brand.primary },
        actionText: { fontSize: 14, fontWeight: '700', color: colors.text.body, flexShrink: 1 },
        actionTextMain: { color: colors.text.inverse },
    }));

    const pointKey = point ? `${point.lat.toFixed(2)},${point.lng.toFixed(2)}` : '';
    useEffect(() => {
        let alive = true;
        fetchGlobalHome(point, identity).then(r => { if (alive) setHome(r); });
        return () => { alive = false; };
        // The point moves a hair between fixes; the card asks again only when it moves ~1 km (pointKey).
    }, [pointKey, identity?.publicKey]);

    useEffect(() => {
        if (!identity) return;
        let alive = true;
        rememberedKnocks(identity.publicKey).then(list => {
            if (!alive) return;
            setAsked(list);
            // Only the communities this phone asked.
            list.forEach(k => readKnockStatus(k.url, identity).then(r => { if (alive) setStatuses(s => ({ ...s, [k.url]: r })); }));
        });
        return () => { alive = false; };
    }, [identity?.publicKey]);

    const copy = findCommunityCardCopy(home, !!point);
    const lines = cardKnockLines(asked, statuses);
    const nearest = home?.ok ? home.value.communities.slice(1, 3) : [];
    const watching = home?.ok && (home.value.watches?.length ?? 0) > 0;

    const tellMe = async () => {
        if (!point || !identity) { router.push('/find-community'); return; }
        const r = await watchPlace(identity, point);
        setWatchNote(r.ok ? "Done. You'll be told when a community starts near here." : r.message);
    };

    return (
        <View style={styles.card} accessibilityRole="summary">
            <Text style={styles.title} accessibilityRole="header">{copy.title}</Text>
            <Text style={styles.body}>{copy.body}</Text>
            {nearest.map(c => (
                <Text key={c.key} style={styles.nearest} numberOfLines={1}>
                    {communityLabel(c)}{communityFacts(c) ? ` · ${communityFacts(c)}` : ''}
                </Text>
            ))}
            {lines.map(l => (
                <Text key={l.url} style={styles.line}>{l.invited ? '🎉 ' : '⏳ '}{l.text}</Text>
            ))}
            {!!watchNote && <Text style={styles.line} accessibilityLiveRegion="polite">{watchNote}</Text>}
            <View style={styles.actions}>
                <Pressable style={[styles.action, styles.actionMain]} onPress={() => router.push('/find-community')} accessibilityRole="button">
                    <MaterialCommunityIcons name="map-marker-radius-outline" size={18} color={colors.text.inverse} />
                    <Text style={[styles.actionText, styles.actionTextMain]}>Communities near you</Text>
                </Pressable>
                <Pressable style={styles.action} onPress={() => router.push('/start-community')} accessibilityRole="button">
                    <MaterialCommunityIcons name="home-plus-outline" size={18} color={colors.brand.primary} />
                    <Text style={styles.actionText}>Start a community</Text>
                </Pressable>
                {!watching && (
                    <Pressable style={styles.action} onPress={tellMe} accessibilityRole="button">
                        <MaterialCommunityIcons name="bell-ring-outline" size={18} color={colors.brand.primary} />
                        <Text style={styles.actionText}>Tell me when one starts here</Text>
                    </Pressable>
                )}
            </View>
        </View>
    );
}
