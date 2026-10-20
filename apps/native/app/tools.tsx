/**
 * The Tools screen (scratch/tools/DESIGN-tool-template-fable.md §1.5, round 2 §8; slice T0.2): `/tools`, from the Commons
 * tab's Tools row (and, with slice S4′, Home's "Your shop and tools"). The title, the resilience sentence, then the three
 * shelves from core's `toolsOnShelf` (Stock · Trade · Books): every tool this build has that this community can have,
 * each a row with its emoji, its name and its state line (the manifest's `row()` on the document on this phone). "More
 * tools" appears for a shop of a kind (S1), with the tools that aren't for it. Nothing here names a tool; nothing is
 * shown locked. The two doors are each tool's own (tools/frame.tsx), since only a tool knows what its Add is.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t, toolsMore, type HomeNodeFacts, type ToolManifest } from '@beanpool/core';
import { useIdentity } from './IdentityContext';
import { useTheme } from './ThemeContext';
import { useNodeProfile } from '../utils/use-node-profile';
import { HOME_TARGET_DP, homeStyles } from '../components/home/HomeParts';
import { phoneTools } from '../tools/index';
import { readToolDoc } from '../tools/store';
import { SHELF_HEADINGS, memberShelves, openTool, safeLine } from '../tools/frame';
import { ToolEmpty, ToolRow } from '../tools/ui';

export default function ToolsScreen() {
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();
    const { identity } = useIdentity();
    const nodeProfile = useNodeProfile();
    const s = homeStyles(colors);
    const tools = phoneTools();
    const manifests = tools.map((x) => x.manifest);
    const facts: HomeNodeFacts = { profile: nodeProfile?.profile ?? 'local', features: (nodeProfile?.features ?? {}) as HomeNodeFacts['features'] };
    const shelves = memberShelves(facts, manifests);
    const more = toolsMore(null, 'member', facts, manifests);
    const [states, setStates] = useState<Record<string, string | null>>({});

    // Each row's state line from the document on this phone, read again whenever the screen comes back.
    useFocusEffect(useCallback(() => {
        const owner = identity?.publicKey;
        if (!owner) return;
        let gone = false;
        void Promise.all(manifests.map(async (m) => {
            const { doc } = await readToolDoc(owner, m).catch(() => ({ doc: m.doc.empty() }));
            const line = safeLine(() => m.row(doc, Date.now()));
            return [m.id, line ? t(line.key, line.values) : null] as const;
        })).then((pairs) => { if (!gone) setStates(Object.fromEntries(pairs)); });
        return () => { gone = true; };
    }, [identity?.publicKey, manifests.map((m) => m.id).join(',')]));

    const rows = (list: ToolManifest[]) => list.map((m) => (
        <ToolRow key={m.id} icon={m.icon} title={t(m.name)} state={states[m.id] ?? t(m.line)} onPress={() => openTool(m.id)} testID={`tools-row-${m.id}`} />
    ));

    return (
        <View style={[styles.page, { backgroundColor: colors.surface.page, paddingTop: insets.top }]} testID="tools-screen">
            <View style={[styles.header, { backgroundColor: colors.surface.card, borderBottomColor: colors.border.default }]}>
                <Pressable onPress={() => router.back()} style={styles.back} accessibilityRole="button" accessibilityLabel={t('Back')} testID="tools-back">
                    <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text.heading} />
                </Pressable>
                <Text style={[styles.title, { color: colors.text.heading }]} accessibilityRole="header" numberOfLines={2}>{t('Tools')}</Text>
            </View>
            <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: 24 + insets.bottom }]}>
                <Text style={[styles.lead, { color: colors.text.secondary }]}>{t('Things you can do on your own, that make your community stronger.')}</Text>
                {shelves.map(({ shelf, tools: list }) => (
                    <View key={shelf} style={s.card} testID={`tools-shelf-${shelf}`}>
                        <View style={s.captionRow}>
                            <Text style={s.caption} accessibilityRole="header" numberOfLines={2}>{t(SHELF_HEADINGS[shelf])}</Text>
                        </View>
                        {rows(list)}
                    </View>
                ))}
                {more.length > 0 ? (
                    <View style={s.card} testID="tools-shelf-more">
                        <View style={s.captionRow}>
                            <Text style={s.caption} accessibilityRole="header" numberOfLines={2}>{t('More tools')}</Text>
                        </View>
                        {rows(more)}
                    </View>
                ) : null}
                {shelves.length === 0 && more.length === 0 ? (
                    <ToolEmpty icon="🧰" text={t('No tools here yet. They come with updates of the app.')} testID="tools-empty" />
                ) : null}
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    page: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: 4, borderBottomWidth: 1 },
    back: { width: HOME_TARGET_DP, height: HOME_TARGET_DP, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    title: { flex: 1, fontSize: 20, fontWeight: '800', paddingRight: 12 },
    scroll: { paddingTop: 12 },
    lead: { fontSize: 15, lineHeight: 21, paddingHorizontal: 16, marginBottom: 12 },
});
