import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Share, TextInput, Platform, DeviceEventEmitter } from 'react-native';
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
import { useCommunities, type CommunityRow, type CommunityStatus } from '../utils/use-communities';
import { useGlobalEntry } from '../utils/use-global-entry';
import { useGlobalDoor } from '../utils/use-global-door-open';
import { isGlobalCommunity } from '../utils/global-join-existing';
import { GLOBAL_NODE_URL } from '../utils/global-node-url';
import { globalEntryLine } from '../utils/global-entry-line';
import { useIdentity } from './IdentityContext';
import appConfig from '../app.json';
import { FEEDBACK_LIVE, t } from '@beanpool/core';

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
// newer from beanpool.org) and never wait on the network; the community part fills in as nodes answer. The guide
// search runs on the phone, over the text it already has.
export default function BeanPoolSheet() {
    const { theme, colors } = useTheme();
    const insets = useSafeAreaInsets();
    const { guide, source } = useGuide();
    const communities = useCommunities();
    const status: CommunityStatus | 'none' = communities.active === null ? 'none'
        : communities.current?.status ?? 'checking';
    const [query, setQuery] = useState('');
    const results = useMemo(() => searchGuide(guide, query), [guide, query]);
    const searching = query.trim().length >= 2;

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
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
        community: { paddingHorizontal: 4, paddingTop: 4 },
        communityName: { fontSize: 24, fontWeight: '800', color: colors.text.heading, letterSpacing: -0.3 },
        rowCurrent: { backgroundColor: colors.accent.tint },
        rowSubCurrent: { color: colors.text.body }, // text.secondary is 4.22 on the dark sage tint
        rowPressed: { backgroundColor: colors.surface.subtle },
        guestTag: { fontSize: 12, fontWeight: '600', color: colors.feedback.warning.fg, flexShrink: 0 },
        cta: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', minHeight: 48, paddingHorizontal: 16, borderRadius: 24, borderWidth: 1, marginTop: 12 },
        ctaGuest: { backgroundColor: colors.feedback.warning.bg, borderColor: colors.feedback.warning.border },
        ctaNone: { backgroundColor: colors.feedback.danger.bg, borderColor: colors.feedback.danger.border },
        ctaText: { fontSize: 15, fontWeight: '700' },
        empty: { fontSize: 15, color: colors.text.body, lineHeight: 22, padding: 16 },
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

    // The global community's row (DESIGN-global-entry §B.3, decisions 1 and 8): under YOUR COMMUNITIES there is always
    // exactly one, never hidden, never hideable. Its shape comes from the list: the saved row where the phone has one (its
    // dot, "in use", long press to remove it from the list, after which this row is the Join row), else a row of its own
    // after the others. What it says and does comes from the one rule (utils/global-entry.ts), read from what the global
    // community itself answered about this key, never from the list: a member's row switches to it; otherwise its second
    // line says where the door stands (Join with this account; checking; can't reach it; not taking members; a private
    // preview; this account closed there). No-domain-lock-in: every state but member and join is "the global community
    // isn't available from here right now", and nothing else on the sheet waits on it.
    const { identity } = useIdentity();
    const globalDoor = useGlobalDoor(!!identity);
    const globalEntry = useGlobalEntry(!!identity, globalDoor.state);
    const globalSaved = communities.rows.find(r => isGlobalCommunity(r.url)) ?? null;
    const globalUrl = globalSaved?.url ?? GLOBAL_NODE_URL;
    const globalHost = globalUrl.replace(/^https?:\/\//, '');
    const globalLine = globalEntryLine(globalEntry, { host: globalHost, wordsDoor: globalDoor.wordsDoor, saved: !!globalSaved })
        ?? t('Explore BeanPool worldwide');
    // A member's row switches to it, and where the door is open the row is Join (what its line says), saved or not. A
    // saved row otherwise keeps what any saved row does (switch to it); an unsaved one opens the door screen's own page for
    // a door that can't be used (it asks again, with Try again), asks again itself when nothing answered, and otherwise
    // waits.
    const switchToGlobal = () => communities.switchTo(globalUrl);
    const openDoor = () => router.push('/join-global');
    const globalTap: (() => void) | undefined = globalEntry === 'member' ? switchToGlobal
        : globalEntry === 'join' ? openDoor
        : globalEntry === 'noAccount' ? () => router.navigate('/welcome')
        : globalSaved ? switchToGlobal
        : globalEntry === 'unreachable' ? globalDoor.retry
        : globalEntry === 'closed' || globalEntry === 'preview' ? openDoor
        : undefined;
    const globalHint = globalSaved && globalTap === switchToGlobal ? t('Switches to this community. Long press to remove it.') : undefined;

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

    // The global community's row: the saved row's shape when the phone has one, else its own (earth, chevron). Its second
    // line up to two at 320 dp and 1.3× (DESIGN-global-entry §B.3).
    const GlobalRow = ({ saved, first }: { saved: CommunityRow | null; first: boolean }) => {
        const isCurrent = !!saved && saved.url === communities.active;
        return (
            <Pressable
                style={({ pressed }) => [styles.row, !first && styles.rowDivider, isCurrent && styles.rowCurrent, pressed && styles.rowPressed]}
                onPress={globalTap}
                onLongPress={saved ? () => communities.remove(saved) : undefined}
                delayLongPress={500}
                disabled={!globalTap || communities.switching}
                accessibilityRole="button"
                accessibilityState={{ selected: isCurrent, disabled: !globalTap }}
                accessibilityLabel={t('Global community, {state}', { state: globalLine })}
                accessibilityHint={globalHint}
                testID="global-community-row"
            >
                {globalEntry === 'member' && saved
                    ? <View style={[styles.dot, { backgroundColor: dotFor(saved.status) }]} />
                    : <MaterialCommunityIcons name="earth" size={24} color={colors.brand.primary} />}
                <View style={styles.rowText}>
                    {/* One line in English; a longer language's name ("Pandaigdigang komunidad") takes a second rather than being cut. */}
                    <Text style={[styles.rowTitle, isCurrent && { color: colors.accent.primary }]} numberOfLines={2}>{saved?.name ?? t('Global community')}</Text>
                    {/* Two lines at most, as the rows beside it; TalkBack reads all of it (the label), and a sentence the floor
                        cuts (the preview's) is whole on the page the row opens. */}
                    <Text style={[styles.rowSub, isCurrent && styles.rowSubCurrent]} numberOfLines={2}>{globalLine}</Text>
                </View>
                {isCurrent
                    ? <MaterialCommunityIcons name="check" size={22} color={colors.accent.primary} style={styles.chevron} />
                    : saved?.status === 'guest' ? <Text style={styles.guestTag}>{t('Guest')}</Text>
                    : globalTap && !saved ? <MaterialCommunityIcons name="chevron-right" size={22} color={colors.text.muted} style={styles.chevron} />
                    : null}
            </Pressable>
        );
    };

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
                        if (r === globalSaved) return <GlobalRow key={r.url} saved={r} first={i === 0} />;
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
                                    <Text style={[styles.rowSub, isCurrent && styles.rowSubCurrent]} numberOfLines={1}>{r.url.replace(/^https?:\/\//, '')}</Text>
                                </View>
                                {isCurrent
                                    ? <MaterialCommunityIcons name="check" size={22} color={colors.accent.primary} style={styles.chevron} />
                                    : r.status === 'guest' && <Text style={styles.guestTag}>Guest</Text>}
                            </Pressable>
                        );
                    })}
                    {!globalSaved && <GlobalRow saved={null} first={communities.rows.length === 0} />}
                    <Pressable
                        style={({ pressed }) => [styles.row, styles.rowDivider, pressed && styles.rowPressed]}
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

                <View style={[styles.searchBox, { marginTop: 20 }]}>
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
                            BeanPool v{appConfig.expo.version} ({Platform.OS === 'ios' ? appConfig.expo.ios.buildNumber : appConfig.expo.android.versionCode}){'\n'}
                            Guide version {guide.version}{source === 'bundled' ? ' · built into the app' : ' · updated from beanpool.org'}{'\n'}Works without a connection.
                        </Text>
                    </>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}
