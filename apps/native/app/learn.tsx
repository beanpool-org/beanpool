/**
 * Learn: the reference shelf of Local knowledge (DESIGN-local-knowledge-fable.md as amended, §A3 "the Learn screen"; slice K2,
 * read-only). Its own full screen with Back, like the calendar and the guide: not a Market pill and not a tab, so the header,
 * the logo and the map files are untouched. Grouped by topic (Emergencies first), never by date: up to three pages under each
 * topic with "See all", a search box at the top, the pinned pages first.
 *
 * Views, one screen: the FRONT (pinned, then a block per topic that holds something), ONE TOPIC (every page of it, from a topic
 * chip or "See all"), and a SEARCH (one flat list, best match first). Opened with `?q=` (the Market's one line) it opens on that
 * search; with `?topic=` on that topic.
 *
 * Read from the phone's own copy of the pages (`knowledge_posts`, filled by the sync), so the screen works with no network and
 * reads as the node's own front does; only a search asks the node too (`GET /api/knowledge/front?q=`, the full text search), and
 * falls back to the copy's plain match when it can't be reached. Where the community doesn't have Learn but shows previews (the
 * worldwide one), the same screen draws Example Valley's three sample pages and every action opens the sheet that leads to a local
 * community. Not here (later slices): "＋ Suggest knowledge" and the form (K4), "N to check ›" and "1 of yours is waiting ›"
 * (K3/K4), and the doors from Home (K7) and the Pulse (KP).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, DeviceEventEmitter, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
    KNOWLEDGE_NAMES, isKnowledgeTopic, t, type KnowledgeRow,
} from '@beanpool/core';
import { useStyles, useTheme } from './ThemeContext';
import { ExampleHeader } from '../components/showcase/LocalCommunityMark';
import { KnowledgeRowCard } from '../components/learn/KnowledgeRowCard';
import { LearnPreviewSheet } from '../components/learn/LearnPreviewSheet';
import { LEARN_LINES, topicOf } from '../components/learn/learn-lines';
import { getKnowledgePosts, signedGet } from '../utils/db';
import { learnFront, learnRows, learnSearch, type KnowledgePage } from '../utils/learn-copy';
import { samplePages } from '../components/showcase/sample-screens';
import { useLearnMode } from '../utils/use-learn-mode';

/** The pause after the last key before the node is asked to search. */
const LEARN_SEARCH_DELAY_MS = 300;

const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v) ?? '';

/** A topic's glyph, name and count: "🚰 Local services 6". */
const topicCount = (id: string, n: number): string => {
    const info = topicOf(id);
    return t(LEARN_LINES.topicCount, { emoji: info.emoji, topic: t(info.label), n });
};

export default function LearnScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { colors } = useTheme();
    const params = useLocalSearchParams<{ q?: string | string[]; topic?: string | string[] }>();
    const mode = useLearnMode();
    const [copy, setCopy] = useState<KnowledgePage[] | null>(null);
    const [query, setQuery] = useState(first(params.q));
    const [topic, setTopic] = useState<string | null>(isKnowledgeTopic(first(params.topic)) ? first(params.topic) : null);
    const [answer, setAnswer] = useState<{ words: string; rows: KnowledgeRow[] } | null>(null);
    const [cannotReach, setCannotReach] = useState(false);
    const [sheet, setSheet] = useState(false);
    const preview = mode === 'preview';

    const styles = useStyles(({ colors: c }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: c.surface.page },
        header: {
            flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingHorizontal: 8,
            borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border.default, backgroundColor: c.surface.chrome,
        },
        back: { flexDirection: 'row', alignItems: 'center', minWidth: 44, minHeight: 44, paddingHorizontal: 8, gap: 4 },
        backArrow: { fontSize: 22, fontWeight: '600', color: c.brand.primary, marginTop: -2 },
        backText: { fontSize: 16, fontWeight: '600', color: c.brand.primary },
        title: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '800', color: c.text.heading, marginRight: 44 },
        content: { padding: 16, paddingBottom: 48, gap: 14 },
        place: { fontSize: 14, color: c.text.secondary },
        search: {
            flexDirection: 'row', alignItems: 'center', minHeight: 48, borderRadius: 12, borderWidth: 1, paddingLeft: 12,
            backgroundColor: c.surface.card, borderColor: c.border.default,
        },
        searchInput: { flex: 1, minWidth: 0, fontSize: 16, color: c.text.body, paddingVertical: 10 },
        searchPlaceholder: { flex: 1, fontSize: 16, color: c.text.muted, paddingVertical: 10 },
        clear: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
        clearText: { fontSize: 16, color: c.text.secondary, fontWeight: '700' },
        chips: { flexDirection: 'row', gap: 8, paddingRight: 16 },
        chip: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: c.border.default, backgroundColor: c.surface.card },
        chipOn: { backgroundColor: c.chip.learn.bg, borderColor: c.chip.learn.fg },
        chipText: { fontSize: 14, fontWeight: '700', color: c.text.body },
        chipTextOn: { color: c.chip.learn.fg },
        blockHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 36 },
        blockTitle: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: '800', color: c.text.heading },
        seeAll: { minHeight: 44, justifyContent: 'center' },
        seeAllText: { fontSize: 14, fontWeight: '800', color: c.chip.learn.fg },
        pinnedHead: { fontSize: 12, fontWeight: '800', letterSpacing: 0.8, color: c.chip.learn.fg },
        block: { gap: 8 },
        empty: { fontSize: 15, color: c.text.body, textAlign: 'center', paddingVertical: 24 },
        emptyAction: { minHeight: 48, justifyContent: 'center', alignItems: 'center' },
        emptyActionText: { fontSize: 15, fontWeight: '800', color: c.chip.learn.fg },
        offline: { fontSize: 13, color: c.text.secondary },
        standing: { fontSize: 12.5, color: c.text.secondary, marginTop: 8 },
    }));

    // The phone's copy of the pages: read now, and again whenever a sync brings something.
    const load = useCallback(() => {
        getKnowledgePosts().then(setCopy).catch(() => setCopy((held) => held ?? []));
    }, []);
    useEffect(() => {
        load();
        const sub = DeviceEventEmitter.addListener('sync_data_updated', load);
        return () => sub.remove();
    }, [load]);

    const pages = useMemo<KnowledgePage[]>(() => (preview ? samplePages() : copy ?? []), [preview, copy]);
    const words = query.trim().slice(0, 100);
    const front = useMemo(() => learnFront(pages), [pages]);

    // A search asks the node too, after a pause (its full text search); the copy's plain match answers meanwhile and when the
    // node can't be reached.
    useEffect(() => {
        if (mode !== 'live' || !words) { setAnswer(null); setCannotReach(false); return; }
        const stop = new AbortController();
        const timer = setTimeout(() => {
            signedGet(`/api/knowledge/front?q=${encodeURIComponent(words)}`, { signal: stop.signal })
                .then(async (res) => {
                    if (!res.ok) throw new Error('unreachable');
                    const body = await res.json();
                    if (!Array.isArray(body?.rows)) throw new Error('unreadable');
                    if (stop.signal.aborted) return;
                    setAnswer({ words, rows: body.rows as KnowledgeRow[] });
                    setCannotReach(false);
                })
                .catch(() => { if (!stop.signal.aborted) { setAnswer(null); setCannotReach(true); } });
        }, LEARN_SEARCH_DELAY_MS);
        return () => { clearTimeout(timer); stop.abort(); };
    }, [mode, words]);

    const searchRows = useMemo<KnowledgeRow[]>(() => {
        if (!words) return [];
        return answer && answer.words === words ? answer.rows : learnSearch(pages, words).rows;
    }, [words, answer, pages]);

    const leave = () => { if (router.canGoBack()) router.back(); else router.replace('/(tabs)' as any); };
    const open = (id: string) => {
        if (preview) { setSheet(true); return; }
        router.push({ pathname: '/post/[id]', params: { id, kind: 'knowledge' } });
    };
    const card = (row: KnowledgeRow) => <KnowledgeRowCard key={row.id} row={row} onPress={() => open(row.id)} />;

    const header = (
        <View style={styles.header}>
            <Pressable testID="learn-back" accessibilityRole="button" accessibilityLabel={t(LEARN_LINES.back)} onPress={leave} style={styles.back}>
                <Text style={styles.backArrow}>‹</Text>
                <Text style={styles.backText}>{t(LEARN_LINES.back)}</Text>
            </Pressable>
            <Text style={styles.title} accessibilityRole="header">{t(KNOWLEDGE_NAMES.place)}</Text>
        </View>
    );

    if (mode === undefined || (mode === 'live' && copy === null)) {
        return (
            <View style={[styles.container, { paddingTop: insets.top }]} testID="learn-loading">
                {header}
                <View style={{ padding: 48, alignItems: 'center' }}>
                    <ActivityIndicator size="large" color={colors.brand.primary} />
                    <Text style={[styles.place, { marginTop: 12 }]}>{t(LEARN_LINES.loading)}</Text>
                </View>
            </View>
        );
    }
    // Off here and not previewed: Learn isn't part of this community (a link or a stale tab can still land on the screen).
    if (mode !== 'live' && mode !== 'preview') {
        return (
            <View style={[styles.container, { paddingTop: insets.top }]} testID="learn-off">
                {header}
                <Text style={[styles.empty, { padding: 24 }]}>{t(LEARN_LINES.off)}</Text>
            </View>
        );
    }

    const chosen = topic ? front.topics.find((x) => x.id === topic) : undefined;
    const topicRows = topic ? learnRows(pages).filter((r) => r.topic === topic) : [];

    return (
        <View style={[styles.container, { paddingTop: insets.top }]} testID="learn-screen">
            {header}
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                {preview ? <ExampleHeader text={t('Example Valley')} /> : null}
                <Text style={styles.place}>{t(LEARN_LINES.placeLine)}</Text>

                {preview ? (
                    <Pressable accessibilityRole="button" accessibilityLabel={t(LEARN_LINES.searchPlaceholder)} onPress={() => setSheet(true)} style={styles.search} testID="learn-search-preview">
                        <Text style={styles.searchPlaceholder}>{t(LEARN_LINES.searchPlaceholder)}</Text>
                    </Pressable>
                ) : (
                    <View style={styles.search}>
                        <TextInput
                            testID="learn-search"
                            style={styles.searchInput}
                            value={query}
                            onChangeText={setQuery}
                            placeholder={t(LEARN_LINES.searchPlaceholder)}
                            placeholderTextColor={colors.text.muted}
                            accessibilityLabel={t(LEARN_LINES.searchPlaceholder)}
                            returnKeyType="search"
                            autoCorrect={false}
                            maxLength={100}
                        />
                        {query ? (
                            <Pressable accessibilityRole="button" accessibilityLabel={t('Clear')} onPress={() => setQuery('')} style={styles.clear} testID="learn-search-clear">
                                <Text style={styles.clearText}>✕</Text>
                            </Pressable>
                        ) : null}
                    </View>
                )}

                {front.topics.length > 0 ? (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">
                        <Pressable accessibilityRole="button" accessibilityState={{ selected: !topic }} onPress={() => setTopic(null)}
                            style={[styles.chip, !topic && styles.chipOn]} testID="learn-topic-all">
                            <Text style={[styles.chipText, !topic && styles.chipTextOn]}>{t(LEARN_LINES.allTopics)}</Text>
                        </Pressable>
                        {front.topics.map((x) => {
                            const on = topic === x.id;
                            const info = topicOf(x.id);
                            return (
                                <Pressable key={x.id} accessibilityRole="button" accessibilityState={{ selected: on }}
                                    onPress={() => setTopic(on ? null : x.id)} style={[styles.chip, on && styles.chipOn]} testID={`learn-topic-${x.id}`}>
                                    <Text style={[styles.chipText, on && styles.chipTextOn]}>{topicCount(x.id, x.count)}</Text>
                                </Pressable>
                            );
                        })}
                    </ScrollView>
                ) : null}

                {words ? (
                    // SEARCH: one flat list, best match first; each row carries its topic chip.
                    <View style={styles.block} testID="learn-results">
                        {cannotReach ? <Text style={styles.offline} testID="learn-offline">{t(LEARN_LINES.offline)}</Text> : null}
                        {searchRows.length > 0 ? searchRows.map(card) : (
                            <View>
                                <Text style={styles.empty}>{t(LEARN_LINES.emptySearch, { words })}</Text>
                                {!preview ? (
                                    <Pressable accessibilityRole="button" style={styles.emptyAction} testID="learn-search-market"
                                        onPress={() => router.navigate({ pathname: '/(tabs)/market', params: { q: words } } as any)}>
                                        <Text style={styles.emptyActionText}>{t(LEARN_LINES.searchMarket, { words })}</Text>
                                    </Pressable>
                                ) : null}
                            </View>
                        )}
                    </View>
                ) : topic ? (
                    // ONE TOPIC: every page of it, in Learn's order.
                    <View style={styles.block} testID="learn-topic">
                        <Text style={styles.blockTitle}>{topicCount(topic, chosen?.count ?? 0)}</Text>
                        {topicRows.map(card)}
                    </View>
                ) : front.total === 0 ? (
                    <Text style={styles.empty} testID="learn-empty">{t(LEARN_LINES.emptyTitle)}</Text>
                ) : (
                    // FRONT: the pinned pages, then a block per topic that holds something.
                    <>
                        {front.pinned.length > 0 ? (
                            <View style={styles.block} testID="learn-pinned">
                                <Text style={styles.pinnedHead}>{t(LEARN_LINES.pinned)}</Text>
                                {front.pinned.map(card)}
                            </View>
                        ) : null}
                        {front.topics.map((x) => {
                            const info = topicOf(x.id);
                            return (
                                <View key={x.id} style={styles.block} testID={`learn-block-${x.id}`}>
                                    <View style={styles.blockHead}>
                                        <Text style={styles.blockTitle}>{topicCount(x.id, x.count)}</Text>
                                    </View>
                                    {x.rows.map(card)}
                                    {x.count > x.rows.length ? (
                                        <Pressable accessibilityRole="button" accessibilityLabel={t('See all {n} in {topic}', { n: x.count, topic: t(info.label) })}
                                            onPress={() => setTopic(x.id)} style={styles.seeAll} testID={`learn-see-all-${x.id}`}>
                                            <Text style={styles.seeAllText}>{t(LEARN_LINES.seeAll, { n: x.count })}</Text>
                                        </Pressable>
                                    ) : null}
                                </View>
                            );
                        })}
                    </>
                )}
                <Text style={styles.standing}>{t(LEARN_LINES.standing)}</Text>
            </ScrollView>
            <LearnPreviewSheet visible={sheet} onClose={() => setSheet(false)} />
        </View>
    );
}
