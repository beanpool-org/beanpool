import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Share, TextInput } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, ErrorBoundary } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { useTheme, useStyles } from './ThemeContext';
import { useGuide } from '../utils/use-guide';
import {
    findGuidePage, manualSections, searchGuide, beanPoolSheetEntries, GUIDE_SLUGS, BEANPOOL_WEBSITE_URL,
    type GuidePage,
} from '../utils/guide';
import { openBeanPoolWebsite } from '../utils/beanpool-links';
import { anchorUrl as getAnchorUrl } from '../utils/node-post';
import { getSavedNodes, isGuestNode } from '../utils/nodes';
import { FEEDBACK_LIVE } from '@beanpool/core';

export { ErrorBoundary };

type IconName = keyof typeof MaterialCommunityIcons.glyphMap;

/** An icon per manual section; a section added later from the website gets the plain page icon. */
const SECTION_ICONS: Record<string, IconName> = {
    'getting-started': 'flag-outline',
    market: 'storefront-outline',
    map: 'map-outline',
    talk: 'chat-outline',
    pulse: 'broadcast',
    commons: 'account-group-outline',
    ledger: 'chart-bar',
    settings: 'cog-outline',
};

type CommunityStatus = 'checking' | 'online' | 'offline' | 'guest' | 'none';

const STATUS_TEXT: Record<CommunityStatus, string> = {
    checking: 'Checking the connection…',
    online: 'Connected',
    offline: "Can't reach it right now",
    guest: 'Visiting as a guest',
    none: 'Not connected. Tap to join a community.',
};

function hostOf(url: string): string {
    try { return new URL(url).host || url; } catch { return url.replace(/^https?:\/\//, '').replace(/\/.*$/, ''); }
}

/** The community this phone is using: its name, and whether its server answers. Never blocks the sheet. */
function useCommunity(): { name: string | null; status: CommunityStatus } {
    const [name, setName] = useState<string | null>(null);
    const [status, setStatus] = useState<CommunityStatus>('checking');
    useEffect(() => {
        let alive = true;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        (async () => {
            const url = await getAnchorUrl().catch(() => null);
            if (!url) { if (alive) setStatus('none'); return; }
            const nodes = await getSavedNodes().catch(() => []);
            if (alive) setName(nodes.find(n => n.url === url)?.alias || hostOf(url));
            if (await isGuestNode(url).catch(() => false)) { if (alive) setStatus('guest'); return; }
            const ok = await fetch(`${url}/api/community/health`, { signal: controller.signal })
                .then(r => r.ok).catch(() => false);
            if (alive) setStatus(ok ? 'online' : 'offline');
        })();
        return () => { alive = false; clearTimeout(timer); controller.abort(); };
    }, []);
    return { name, status };
}

// "BeanPool: help and how it works" — the members' sheet. Opened from Settings → BeanPool today; the header redesign
// will also open it from the electric bean. Everything renders from useGuide (bundled, cached or newer from
// beanpool.org) and never waits on the network. The search runs on the phone, over the text it already has.
export default function BeanPoolSheet() {
    const { theme, colors } = useTheme();
    const insets = useSafeAreaInsets();
    const { guide, source } = useGuide();
    const community = useCommunity();
    const [query, setQuery] = useState('');
    const results = useMemo(() => searchGuide(guide, query), [guide, query]);
    const searching = query.trim().length >= 2;

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.app },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: theme === 'dark' ? colors.surface.card : colors.text.heading },
        backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
        headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: 'bold', color: colors.brand.primary, letterSpacing: 0.5, textTransform: 'uppercase' },
        scroll: { padding: 16 },
        searchBox: { flexDirection: 'row', alignItems: 'center', minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, paddingLeft: 12 },
        searchInput: { flex: 1, minWidth: 0, minHeight: 48, fontSize: 16, color: colors.text.body, paddingVertical: 8, paddingHorizontal: 8 },
        clearBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
        sectionLabel: { fontSize: 12, fontWeight: 'bold', color: colors.text.secondary, letterSpacing: 1, marginTop: 20, marginBottom: 8, marginLeft: 4 },
        group: { backgroundColor: colors.surface.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, overflow: 'hidden' },
        row: { flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingVertical: 12, paddingHorizontal: 14, gap: 12 },
        rowDivider: { borderTopWidth: 1, borderTopColor: colors.border.default },
        rowText: { flex: 1, minWidth: 0 },
        rowTitle: { fontSize: 16, fontWeight: '600', color: colors.text.heading },
        rowSub: { fontSize: 13, color: colors.text.secondary, marginTop: 2, lineHeight: 18 },
        chevron: { flexShrink: 0 },
        statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
        dot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
        shareBtn: { minWidth: 48, minHeight: 48, paddingHorizontal: 12, borderRadius: 24, borderWidth: 1, borderColor: colors.border.strong, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
        shareText: { fontSize: 14, fontWeight: '600', color: colors.text.body },
        empty: { fontSize: 15, color: colors.text.body, lineHeight: 22, padding: 16 },
        foot: { fontSize: 12, color: colors.text.muted, textAlign: 'center', marginTop: 24, lineHeight: 18 },
    }));

    const dotColor = community.status === 'online' ? colors.feedback.success.solid
        : community.status === 'guest' ? colors.feedback.warning.solid
        : community.status === 'checking' ? colors.text.muted
        : colors.feedback.danger.solid;

    const openGuide = (slug: string) => router.push({ pathname: '/guide/[slug]', params: { slug } });
    const page = (slug: string) => findGuidePage(guide, slug);

    const Row = ({ icon, title, sub, onPress, first, label, hint }: {
        icon: IconName; title: string; sub?: string; onPress: () => void; first?: boolean; label?: string; hint?: string;
    }) => (
        <Pressable
            style={[styles.row, !first && styles.rowDivider]}
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={label ?? title}
            accessibilityHint={hint ?? sub}
        >
            <MaterialCommunityIcons name={icon} size={24} color={colors.brand.primary} />
            <View style={styles.rowText}>
                <Text style={styles.rowTitle} numberOfLines={2}>{title}</Text>
                {!!sub && <Text style={styles.rowSub} numberOfLines={2}>{sub}</Text>}
            </View>
            <MaterialCommunityIcons name="chevron-right" size={22} color={colors.text.muted} style={styles.chevron} />
        </Pressable>
    );

    const GuideRow = ({ p, icon, first }: { p: GuidePage | null; icon: IconName; first?: boolean }) =>
        p ? <Row icon={icon} title={p.title} sub={p.summary} first={first} onPress={() => openGuide(p.slug)} /> : null;

    const projectRows = beanPoolSheetEntries(FEEDBACK_LIVE);

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
            <View style={styles.header}>
                <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Back">
                    <MaterialCommunityIcons name="arrow-left" size={26} color={colors.text.inverse} />
                </Pressable>
                <Text style={styles.headerTitle} numberOfLines={1} accessibilityRole="header">BeanPool</Text>
                <View style={{ width: 48 }} />
            </View>

            <ScrollView
                contentContainerStyle={[styles.scroll, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
            >
                <View style={styles.searchBox}>
                    <MaterialCommunityIcons name="magnify" size={22} color={colors.text.muted} />
                    <TextInput
                        value={query}
                        onChangeText={setQuery}
                        placeholder="Search the guide"
                        placeholderTextColor={colors.text.muted}
                        style={styles.searchInput}
                        returnKeyType="search"
                        autoCorrect={false}
                        accessibilityLabel="Search the guide"
                    />
                    {query.length > 0 && (
                        <Pressable style={styles.clearBtn} onPress={() => setQuery('')} accessibilityRole="button" accessibilityLabel="Clear the search">
                            <MaterialCommunityIcons name="close-circle" size={20} color={colors.text.muted} />
                        </Pressable>
                    )}
                </View>

                {searching ? (
                    <>
                        <Text style={styles.sectionLabel} accessibilityLiveRegion="polite">
                            {results.length === 0 ? 'NOTHING FOUND' : `${results.length} ${results.length === 1 ? 'PAGE' : 'PAGES'}`}
                        </Text>
                        <View style={styles.group}>
                            {results.length === 0 ? (
                                <Text style={styles.empty}>No page has all of those words. Try one word, like "gift" or "vote".</Text>
                            ) : results.map((r, i) => (
                                <Row key={r.page.slug} icon="file-document-outline" title={r.page.title} sub={r.snippet} first={i === 0} onPress={() => openGuide(r.page.slug)} />
                            ))}
                        </View>
                    </>
                ) : (
                    <>
                        <Text style={styles.sectionLabel}>YOUR COMMUNITY</Text>
                        <View style={styles.group}>
                            <Pressable
                                style={styles.row}
                                onPress={() => router.navigate({ pathname: '/(tabs)/settings', params: { section: 'advanced' } })}
                                accessibilityRole="button"
                                accessibilityLabel={`Your community: ${community.name ?? 'none'}. ${STATUS_TEXT[community.status]}`}
                                accessibilityHint="Opens your communities, where you can switch or add one"
                            >
                                <MaterialCommunityIcons name="home-group" size={24} color={colors.brand.primary} />
                                <View style={styles.rowText}>
                                    <Text style={styles.rowTitle} numberOfLines={1}>{community.name ?? 'No community yet'}</Text>
                                    <View style={styles.statusRow}>
                                        <View style={[styles.dot, { backgroundColor: dotColor }]} />
                                        <Text style={[styles.rowSub, { marginTop: 0, flex: 1 }]} numberOfLines={2}>{STATUS_TEXT[community.status]}</Text>
                                    </View>
                                </View>
                                <MaterialCommunityIcons name="chevron-right" size={22} color={colors.text.muted} style={styles.chevron} />
                            </Pressable>
                        </View>

                        <Text style={styles.sectionLabel}>GUIDES</Text>
                        <View style={styles.group}>
                            <GuideRow p={page(GUIDE_SLUGS.howItWorks)} icon="book-open-variant" first />
                            <GuideRow p={page(GUIDE_SLUGS.rules)} icon="scale-balance" />
                            <GuideRow p={page(GUIDE_SLUGS.faq)} icon="help-circle-outline" />
                        </View>

                        <Text style={styles.sectionLabel}>HOW TO USE THE APP</Text>
                        <View style={styles.group}>
                            {manualSections(guide).map((s, i) => (
                                <Row
                                    key={s.id}
                                    icon={SECTION_ICONS[s.id] ?? 'file-document-outline'}
                                    title={s.title}
                                    sub={s.summary}
                                    first={i === 0}
                                    onPress={() => router.push({ pathname: '/guide/section/[id]', params: { id: s.id } })}
                                />
                            ))}
                        </View>

                        <Text style={styles.sectionLabel}>THE BEANPOOL PROJECT</Text>
                        <View style={styles.group}>
                            {projectRows.map((entry, i) => {
                                if (entry === 'suggest') {
                                    // Only while FEEDBACK_LIVE (@beanpool/core feedback.ts): the same screen Settings opens.
                                    return <Row key={entry} icon="message-draw" title="Suggest a change" sub="Ideas and problems go to the BeanPool project team" label="Suggest a change to BeanPool" first={i === 0} onPress={() => router.push('/suggest-change')} />;
                                }
                                if (entry === 'whats-new') {
                                    const p = page(GUIDE_SLUGS.whatsNew);
                                    return p ? <Row key={entry} icon="new-box" title={p.title} sub={p.summary} first={i === 0} onPress={() => openGuide(p.slug)} /> : null;
                                }
                                return (
                                    <View key={entry} style={[styles.row, i > 0 && styles.rowDivider]}>
                                        <Pressable
                                            style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 }}
                                            onPress={() => { void openBeanPoolWebsite(); }}
                                            accessibilityRole="link"
                                            accessibilityLabel="beanpool.org, opens in your browser"
                                        >
                                            <MaterialCommunityIcons name="web" size={24} color={colors.brand.primary} />
                                            <View style={styles.rowText}>
                                                <Text style={styles.rowTitle}>beanpool.org</Text>
                                                <Text style={styles.rowSub} numberOfLines={2}>The public website, to share with friends</Text>
                                            </View>
                                        </Pressable>
                                        <Pressable
                                            style={styles.shareBtn}
                                            onPress={() => Share.share({ message: `BeanPool: trade with your neighbours using beans. ${BEANPOOL_WEBSITE_URL}` }).catch(() => {})}
                                            accessibilityRole="button"
                                            accessibilityLabel="Share beanpool.org"
                                        >
                                            <Text style={styles.shareText}>Share</Text>
                                        </Pressable>
                                    </View>
                                );
                            })}
                        </View>

                        <Text style={styles.foot}>
                            Guide version {guide.version}{source === 'bundled' ? ' · built into the app' : ' · updated from beanpool.org'}{'\n'}Works without a connection.
                        </Text>
                    </>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}
