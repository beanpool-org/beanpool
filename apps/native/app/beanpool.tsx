import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Linking, Share } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, ErrorBoundary } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { useTheme, useStyles } from './ThemeContext';
import { useGuide } from '../utils/use-guide';
import { findGuidePage, GUIDE_SLUGS, type GuidePage } from '../utils/guide';
import { anchorUrl as getAnchorUrl } from '../utils/node-post';
import { getSavedNodes, isGuestNode } from '../utils/nodes';
import { FEEDBACK_LIVE } from '@beanpool/core';

export { ErrorBoundary };

const PUBLIC_SITE = 'https://beanpool.org';

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
// will also open it from the electric bean. Guides render from useGuide (bundled, cached or newer from
// beanpool.org) and never wait on the network.
export default function BeanPoolSheet() {
    const { theme, colors } = useTheme();
    const insets = useSafeAreaInsets();
    const { guide, source } = useGuide();
    const community = useCommunity();

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.app },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: theme === 'dark' ? colors.surface.card : colors.text.heading },
        backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
        headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: 'bold', color: colors.brand.primary, letterSpacing: 0.5, textTransform: 'uppercase' },
        scroll: { padding: 16 },
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
        foot: { fontSize: 12, color: colors.text.muted, textAlign: 'center', marginTop: 24, lineHeight: 18 },
    }));

    const dotColor = community.status === 'online' ? colors.feedback.success.solid
        : community.status === 'guest' ? colors.feedback.warning.solid
        : community.status === 'checking' ? colors.text.muted
        : colors.feedback.danger.solid;

    const openGuide = (slug: string) => router.push({ pathname: '/guide/[slug]', params: { slug } });

    const known = new Set<string>(Object.values(GUIDE_SLUGS));
    const extraGuides = guide.guides.filter(g => !known.has(g.slug));

    const GuideRow = ({ page, icon, first }: { page: GuidePage | null; icon: keyof typeof MaterialCommunityIcons.glyphMap; first?: boolean }) => page ? (
        <Pressable
            style={[styles.row, !first && styles.rowDivider]}
            onPress={() => openGuide(page.slug)}
            accessibilityRole="button"
            accessibilityLabel={page.title}
            accessibilityHint={page.summary}
        >
            <MaterialCommunityIcons name={icon} size={24} color={colors.brand.primary} />
            <View style={styles.rowText}>
                <Text style={styles.rowTitle}>{page.title}</Text>
                <Text style={styles.rowSub} numberOfLines={2}>{page.summary}</Text>
            </View>
            <MaterialCommunityIcons name="chevron-right" size={22} color={colors.text.muted} style={styles.chevron} />
        </Pressable>
    ) : null;

    const page = (slug: string) => findGuidePage(guide, slug);

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

            <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}>
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
                    <GuideRow page={page(GUIDE_SLUGS.howItWorks)} icon="book-open-variant" first />
                    <GuideRow page={page(GUIDE_SLUGS.rules)} icon="scale-balance" />
                    <GuideRow page={page(GUIDE_SLUGS.faq)} icon="help-circle-outline" />
                    {extraGuides.map(g => <GuideRow key={g.slug} page={g} icon="file-document-outline" />)}
                </View>

                <Text style={styles.sectionLabel}>THE BEANPOOL PROJECT</Text>
                <View style={styles.group}>
                    {/* Hidden until the feedback Worker is live (FEEDBACK_LIVE, @beanpool/core feedback.ts). */}
                    {FEEDBACK_LIVE && (
                        <Pressable
                            style={styles.row}
                            onPress={() => router.push('/suggest-change')}
                            accessibilityRole="button"
                            accessibilityLabel="Suggest a change to BeanPool"
                        >
                            <MaterialCommunityIcons name="message-draw" size={24} color={colors.brand.primary} />
                            <View style={styles.rowText}>
                                <Text style={styles.rowTitle}>Suggest a change</Text>
                                <Text style={styles.rowSub} numberOfLines={2}>Ideas and problems go to the BeanPool project team</Text>
                            </View>
                            <MaterialCommunityIcons name="chevron-right" size={22} color={colors.text.muted} style={styles.chevron} />
                        </Pressable>
                    )}
                    <GuideRow page={page(GUIDE_SLUGS.whatsNew)} icon="new-box" first={!FEEDBACK_LIVE} />
                    <View style={[styles.row, styles.rowDivider]}>
                        <Pressable
                            style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 }}
                            onPress={() => Linking.openURL(PUBLIC_SITE).catch(() => {})}
                            accessibilityRole="link"
                            accessibilityLabel="Open beanpool.org"
                        >
                            <MaterialCommunityIcons name="web" size={24} color={colors.brand.primary} />
                            <View style={styles.rowText}>
                                <Text style={styles.rowTitle}>beanpool.org</Text>
                                <Text style={styles.rowSub} numberOfLines={2}>The public website, to share with friends</Text>
                            </View>
                        </Pressable>
                        <Pressable
                            style={styles.shareBtn}
                            onPress={() => Share.share({ message: `BeanPool: trade with your neighbours using beans. ${PUBLIC_SITE}` }).catch(() => {})}
                            accessibilityRole="button"
                            accessibilityLabel="Share beanpool.org"
                        >
                            <Text style={styles.shareText}>Share</Text>
                        </Pressable>
                    </View>
                </View>

                <Text style={styles.foot}>
                    Guide version {guide.version}{source === 'bundled' ? ' · built into the app' : ' · updated from beanpool.org'}{'\n'}Works without a connection.
                </Text>
            </ScrollView>
        </SafeAreaView>
    );
}
