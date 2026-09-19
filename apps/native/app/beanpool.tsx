import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Linking, Share, Platform, DeviceEventEmitter } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, ErrorBoundary } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { useTheme, useStyles } from './ThemeContext';
import { useGuide } from '../utils/use-guide';
import { findGuidePage, GUIDE_SLUGS, type GuidePage } from '../utils/guide';
import { useCommunities, type CommunityStatus } from '../utils/use-communities';
import appConfig from '../app.json';
import { FEEDBACK_LIVE } from '@beanpool/core';

export { ErrorBoundary };

const PUBLIC_SITE = 'https://beanpool.org';

// The heading's status line for the community in use. Guest and "no community" each carry the next step.
const STATUS_TEXT: Record<CommunityStatus | 'none', string> = {
    checking: 'Checking the connection…',
    online: 'Connected. You are a member here.',
    offline: "Can't reach it right now",
    guest: 'Visiting as a guest',
    none: 'Not connected to a community yet',
};

function syncedAgo(at: number | null): string | null {
    if (!at) return null;
    const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
    if (s < 60) return `synced ${s}s ago`;
    if (s < 3600) return `synced ${Math.floor(s / 60)}m ago`;
    return `synced ${Math.floor(s / 3600)}h ago`;
}

// The BeanPool sheet — the one sheet for the community and for help. The header's bean opens it, and so does
// Settings → "Help & how it works". Top to bottom: the community in use (name and status), your communities to
// switch between, then the guides and the BeanPool project. Guides render from useGuide (bundled, cached or
// newer from beanpool.org) and never wait on the network; the community part fills in as nodes answer.
export default function BeanPoolSheet() {
    const { theme, colors } = useTheme();
    const insets = useSafeAreaInsets();
    const { guide, source } = useGuide();
    const communities = useCommunities();
    const status: CommunityStatus | 'none' = communities.active === null ? 'none'
        : communities.current?.status ?? 'checking';

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
        community: { paddingHorizontal: 4, paddingTop: 4 },
        communityName: { fontSize: 24, fontWeight: '800', color: colors.text.heading, letterSpacing: -0.3 },
        rowCurrent: { backgroundColor: colors.accent.tint },
        rowPressed: { backgroundColor: colors.surface.subtle },
        guestTag: { fontSize: 12, fontWeight: '600', color: colors.feedback.warning.fg, flexShrink: 0 },
        cta: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', minHeight: 48, paddingHorizontal: 16, borderRadius: 24, borderWidth: 1, marginTop: 12 },
        ctaGuest: { backgroundColor: colors.feedback.warning.bg, borderColor: colors.feedback.warning.border },
        ctaNone: { backgroundColor: colors.feedback.danger.bg, borderColor: colors.feedback.danger.border },
        ctaText: { fontSize: 15, fontWeight: '700' },
        foot: { fontSize: 12, color: colors.text.muted, textAlign: 'center', marginTop: 24, lineHeight: 18 },
    }));

    const dotFor = (st: CommunityStatus | 'none') => st === 'online' ? colors.feedback.success.solid
        : st === 'guest' ? colors.feedback.warning.solid
        : st === 'checking' ? colors.text.muted
        : colors.feedback.danger.solid;
    const { current } = communities;
    const synced = status === 'online' ? syncedAgo(communities.lastSync) : null;
    // Where a guest joins and a phone with no community connects: the same places the header's pill goes.
    const join = () => {
        DeviceEventEmitter.emit('set_people_view', { view: 'invites' });
        router.navigate({ pathname: '/(tabs)/people', params: { view: 'invites' } });
    };
    const connect = () => router.navigate({ pathname: '/(tabs)/settings', params: { section: 'advanced' } });

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
                {/* The community in use: its name heads the sheet (the header row no longer shows it). */}
                <View style={styles.community}>
                    <Text style={styles.communityName} numberOfLines={2} accessibilityRole="header">
                        {current?.name ?? (status === 'none' ? 'No community yet' : ' ')}
                    </Text>
                    <View style={styles.statusRow} accessible accessibilityLabel={`${STATUS_TEXT[status]}${synced ? `, ${synced}` : ''}`}>
                        <View style={[styles.dot, { backgroundColor: dotFor(status) }]} />
                        <Text style={[styles.rowSub, { marginTop: 0, flex: 1 }]} numberOfLines={2}>
                            {STATUS_TEXT[status]}{synced ? ` · ${synced}` : ''}
                        </Text>
                    </View>
                    {(status === 'guest' || status === 'none') && (
                        <Pressable
                            style={[styles.cta, status === 'guest' ? styles.ctaGuest : styles.ctaNone]}
                            onPress={status === 'guest' ? join : connect}
                            accessibilityRole="button"
                            accessibilityLabel={status === 'guest' ? 'Join this community' : 'Connect to a community'}
                        >
                            <MaterialCommunityIcons name={status === 'guest' ? 'account-alert-outline' : 'link-variant'} size={20}
                                color={status === 'guest' ? colors.feedback.warning.fg : colors.feedback.danger.fg} />
                            <Text style={[styles.ctaText, { color: status === 'guest' ? colors.feedback.warning.fg : colors.feedback.danger.fg }]}>
                                {status === 'guest' ? 'Join this community' : 'Connect to a community'}
                            </Text>
                        </Pressable>
                    )}
                </View>

                <Text style={styles.sectionLabel}>YOUR COMMUNITIES</Text>
                <View style={styles.group}>
                    {communities.rows.map((r, i) => {
                        const isCurrent = r.url === communities.active;
                        return (
                            <Pressable
                                key={r.url}
                                style={({ pressed }) => [styles.row, i > 0 && styles.rowDivider, isCurrent && styles.rowCurrent, pressed && styles.rowPressed]}
                                onPress={() => communities.switchTo(r.url)}
                                onLongPress={() => communities.remove(r)}
                                delayLongPress={500}
                                disabled={communities.switching}
                                accessibilityRole="button"
                                accessibilityState={{ selected: isCurrent }}
                                accessibilityLabel={`${r.name}, ${STATUS_TEXT[r.status]}${isCurrent ? ', in use' : ''}`}
                                accessibilityHint={isCurrent ? undefined : 'Switches to this community. Long press to remove it.'}
                            >
                                <View style={[styles.dot, { backgroundColor: dotFor(r.status) }]} />
                                <View style={styles.rowText}>
                                    <Text style={[styles.rowTitle, isCurrent && { color: colors.accent.primary }]} numberOfLines={1}>{r.name}</Text>
                                    <Text style={styles.rowSub} numberOfLines={1}>{r.url.replace(/^https?:\/\//, '')}</Text>
                                </View>
                                {isCurrent
                                    ? <MaterialCommunityIcons name="check" size={22} color={colors.accent.primary} style={styles.chevron} />
                                    : r.status === 'guest' && <Text style={styles.guestTag}>Guest</Text>}
                            </Pressable>
                        );
                    })}
                    <Pressable
                        style={({ pressed }) => [styles.row, communities.rows.length > 0 && styles.rowDivider, pressed && styles.rowPressed]}
                        onPress={connect}
                        accessibilityRole="button"
                        accessibilityLabel="Add a community"
                        accessibilityHint="Opens Settings, where you can connect to another community"
                    >
                        <MaterialCommunityIcons name="plus-circle-outline" size={24} color={colors.brand.primary} />
                        <View style={styles.rowText}>
                            <Text style={styles.rowTitle}>Add a community</Text>
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
                    BeanPool v{appConfig.expo.version} ({Platform.OS === 'ios' ? appConfig.expo.ios.buildNumber : appConfig.expo.android.versionCode}){'\n'}
                    Guide version {guide.version}{source === 'bundled' ? ' · built into the app' : ' · updated from beanpool.org'}{'\n'}Works without a connection.
                </Text>
            </ScrollView>
        </SafeAreaView>
    );
}
