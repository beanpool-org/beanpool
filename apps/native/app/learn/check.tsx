/**
 * To check (slice K4 part 2; DESIGN-local-knowledge-fable.md §5 as amended §A5): owners and admins see members' and
 * assistants' waiting Local knowledge suggestions and fixes here, longest waiting first, and under them the pages not
 * checked for a year. Reached from the bell, Home's Needs you, Home's Learn card ("N to check ›"), Learn's amber
 * "N to check ›" line, and a push notice (`screen: 'learn-check'`).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, DeviceEventEmitter, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t, type KnowledgeDraftToCheck } from '@beanpool/core';
import { useStyles, useTheme } from '../ThemeContext';
import { leaveScreen } from '../../utils/leave-screen';
import { anchorUrl } from '../../utils/node-post';
import { rowOnCommunity } from '../../utils/photo-address';
import { KnowledgeRowCard } from '../../components/learn/KnowledgeRowCard';
import { LEARN_LINES, topicOf } from '../../components/learn/learn-lines';
import {
    LEARN_CHECK_ANSWERED, LEARN_CHECK_WORDS, draftFromWords, draftKindWord, draftWaited, readLearnToCheck,
    type LearnCheckListData,
} from '../../components/learn/learn-check';

export default function LearnCheckListScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { colors } = useTheme();
    const [list, setList] = useState<LearnCheckListData | 'failed' | null>(null);
    const [nodeUrl, setNodeUrl] = useState<string | null>(null);
    const [said, setSaid] = useState<string | null>(null);
    const [tries, setTries] = useState(0);

    const s = useStyles(({ colors: c }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: c.surface.page },
        header: {
            flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingHorizontal: 8,
            borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border.default, backgroundColor: c.surface.chrome,
        },
        back: { flexDirection: 'row', alignItems: 'center', minWidth: 44, minHeight: 44, paddingHorizontal: 8, gap: 4 },
        backArrow: { fontSize: 22, fontWeight: '600', color: c.brand.primary, marginTop: -2 },
        backText: { fontSize: 16, fontWeight: '600', color: c.brand.primary },
        title: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '800', color: c.text.heading, marginRight: 44 },
        content: { padding: 16, paddingBottom: 48, gap: 12 },
        said: { fontSize: 14, fontWeight: '700', color: c.chip.learn.fg },
        sectionHead: { fontSize: 14, fontWeight: '800', color: c.text.heading, marginTop: 4 },
        list: { gap: 10 },
        row: {
            padding: 12, gap: 4, borderRadius: 12, borderWidth: 1,
            borderColor: c.border.default, backgroundColor: c.surface.card, minHeight: 48,
        },
        rowTitle: { fontSize: 16, fontWeight: '800', color: c.text.heading, flexShrink: 1 },
        metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
        metaStrong: { fontSize: 13, fontWeight: '700', color: c.text.secondary },
        meta: { fontSize: 13, color: c.text.secondary, flexShrink: 1 },
        empty: { fontSize: 15, color: c.text.secondary, paddingVertical: 16 },
        errorBox: {
            padding: 12, borderRadius: 12, borderWidth: 1, borderColor: c.feedback.danger.fg,
            backgroundColor: c.surface.card, gap: 10,
        },
        errorText: { fontSize: 14, color: c.feedback.danger.fg },
        retry: {
            alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: 14,
            borderRadius: 10, borderWidth: 1, borderColor: c.border.default, backgroundColor: c.surface.card,
        },
        retryText: { fontSize: 14, fontWeight: '700', color: c.text.heading },
    }));

    useEffect(() => {
        const sub = DeviceEventEmitter.addListener(LEARN_CHECK_ANSWERED, (msg: unknown) => {
            if (typeof msg === 'string' && msg) setSaid(msg);
        });
        return () => sub.remove();
    }, []);

    useFocusEffect(useCallback(() => {
        let live = true;
        const stop = new AbortController();
        Promise.all([readLearnToCheck(stop.signal), anchorUrl().catch(() => null)])
            .then(([data, url]) => {
                if (!live) return;
                setNodeUrl(url);
                setList(data);
            })
            .catch(() => {
                if (live) setList('failed');
            });
        return () => { live = false; stop.abort(); };
    }, [tries]));

    const leave = () => leaveScreen(router, 'learn/check');

    const openDraft = (d: KnowledgeDraftToCheck) => {
        setSaid(null);
        router.push({ pathname: '/learn/check/[id]', params: { id: d.id } });
    };

    const old = list && list !== 'failed' && list.unchecked.rows.length > 0 ? list.unchecked : null;

    return (
        <View style={[s.container, { paddingTop: insets.top }]} testID="learn-check">
            <View style={s.header}>
                <Pressable testID="learn-check-back" accessibilityRole="button" accessibilityLabel={t(LEARN_LINES.back)} onPress={leave} style={s.back}>
                    <Text style={s.backArrow}>‹</Text>
                    <Text style={s.backText}>{t(LEARN_LINES.back)}</Text>
                </Pressable>
                <Text style={s.title} accessibilityRole="header" numberOfLines={1}>{t(LEARN_CHECK_WORDS.title)}</Text>
            </View>
            <ScrollView contentContainerStyle={s.content}>
                {said ? (
                    <Text style={s.said} testID="learn-check-said" accessibilityLiveRegion="polite">{said}</Text>
                ) : null}

                {list === null ? (
                    <ActivityIndicator size="large" color={colors.brand.primary} style={{ padding: 48 }} testID="learn-check-loading" />
                ) : list === 'failed' ? (
                    <View style={s.errorBox} testID="learn-check-failed">
                        <Text style={s.errorText}>{t(LEARN_CHECK_WORDS.loadFailed)}</Text>
                        <Pressable testID="learn-check-retry" accessibilityRole="button" style={s.retry} onPress={() => { setList(null); setTries((n) => n + 1); }}>
                            <Text style={s.retryText}>{t(LEARN_CHECK_WORDS.tryAgain)}</Text>
                        </Pressable>
                    </View>
                ) : (
                    <>
                        {list.drafts.length === 0 ? (
                            <Text style={s.empty} testID="learn-check-empty">{t(LEARN_CHECK_WORDS.empty)}</Text>
                        ) : (
                            <View style={s.list} testID="learn-check-list">
                                <Text style={s.sectionHead} accessibilityRole="header">
                                    {t(LEARN_CHECK_WORDS.waitingCount, { n: list.total })}
                                </Text>
                                {list.drafts.map((d) => {
                                    const kind = draftKindWord(d.kind);
                                    const from = draftFromWords(d);
                                    const waited = draftWaited(d.createdAt);
                                    return (
                                        <Pressable
                                            key={d.id}
                                            testID={`learn-check-row-${d.id}`}
                                            accessibilityRole="button"
                                            accessibilityLabel={[d.title, kind, from, waited].join(', ')}
                                            style={s.row}
                                            onPress={() => openDraft(d)}
                                        >
                                            <Text style={s.rowTitle}><Text importantForAccessibility="no">{topicOf(d.topic).emoji}{' '}</Text>{d.title}</Text>
                                            <View style={s.metaRow}>
                                                <Text style={s.metaStrong}>{kind}</Text>
                                                <Text style={s.meta}>{from}</Text>
                                                <Text style={s.meta}>{waited}</Text>
                                            </View>
                                        </Pressable>
                                    );
                                })}
                            </View>
                        )}
                        {old ? (
                            <View style={[s.list, { marginTop: 12 }]} testID="learn-check-year">
                                <Text style={s.sectionHead} accessibilityRole="header">
                                    {t(LEARN_CHECK_WORDS.uncheckedYear, { n: old.total })}
                                </Text>
                                {old.rows.map((row) => (
                                    <KnowledgeRowCard
                                        key={row.id}
                                        row={rowOnCommunity(nodeUrl, row)}
                                        onPress={() => router.push({ pathname: '/post/[id]', params: { id: row.id, kind: 'knowledge' } })}
                                        testID={`learn-check-old-${row.id}`}
                                    />
                                ))}
                            </View>
                        ) : null}
                    </>
                )}
            </ScrollView>
        </View>
    );
}
