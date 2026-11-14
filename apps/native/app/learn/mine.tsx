/**
 * My suggestions (slice K4; DESIGN-local-knowledge-fable.md §3.4 as amended): a member's own suggestions of Local knowledge, from
 * Learn's line "1 of yours is waiting for an admin ›" and from the push that answers one. Waiting ones first, each with its title,
 * New or Fix, "Waiting since 3 Nov" and "Take it back" (asked first; one the node didn't take says why under its row, in the
 * form's words when the node said nothing); answered ones stay 30 days with "Added" (a tap opens the
 * page) or "Not added: {reason}" and the owner's or admin's own words. Nothing here names who answered (the node never says).
 */
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t, type KnowledgeDraftMine } from '@beanpool/core';
import { useStyles, useTheme } from '../ThemeContext';
import { LEARN_LINES } from '../../components/learn/learn-lines';
import { LEARN_WRITE, learnRefusal, mineRowStatus, refusalCode } from '../../components/learn/learn-write';
import { readMyDrafts } from '../../components/learn/useLearnWriter';
import { signedRequestWithMethod } from '../../utils/db';

type Mine = { waiting: KnowledgeDraftMine[]; answered: KnowledgeDraftMine[] };

export default function MySuggestionsScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { colors } = useTheme();
    // undefined: asking; null: the community couldn't be reached.
    const [mine, setMine] = useState<Mine | null | undefined>(undefined);
    // A "Take it back" the node didn't take (a standby's 503, no signal): said under that row, which stays.
    const [failed, setFailed] = useState<{ id: string; words: string } | null>(null);

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
        content: { padding: 16, paddingBottom: 48, gap: 10 },
        row: { padding: 12, gap: 4, borderRadius: 12, borderWidth: 1, borderColor: c.border.default, backgroundColor: c.surface.card },
        rowTitle: { fontSize: 16, fontWeight: '800', color: c.text.heading },
        meta: { fontSize: 13, color: c.text.secondary },
        words: { fontSize: 14, lineHeight: 20, color: c.text.body },
        takeBack: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
        takeBackText: { fontSize: 14, fontWeight: '800', color: c.chip.learn.fg },
        problem: { fontSize: 14, fontWeight: '700', color: c.feedback.danger.fg },
        empty: { fontSize: 15, color: c.text.body, textAlign: 'center', paddingVertical: 24 },
        action: { minHeight: 48, justifyContent: 'center', alignItems: 'center' },
        actionText: { fontSize: 15, fontWeight: '800', color: c.chip.learn.fg },
    }));

    const load = useCallback(() => { setFailed(null); readMyDrafts().then(setMine).catch(() => setMine(null)); }, []);
    useFocusEffect(load);

    const takeBack = (d: KnowledgeDraftMine) => {
        Alert.alert(t(LEARN_WRITE.takeBackAsk), undefined, [
            { text: t(LEARN_WRITE.keep), style: 'cancel' },
            {
                text: t(LEARN_WRITE.takeBack), style: 'destructive',
                onPress: () => {
                    setFailed(null);
                    signedRequestWithMethod('POST', `/api/knowledge/drafts/${encodeURIComponent(d.id)}/withdraw`, {}, { withStatus: true })
                        // Taken back, or answered meanwhile (404 `not_found`): either way the list is read again as the node has it.
                        .then(load, (e) => {
                            if (refusalCode(e) === 'not_found') load();
                            // Anything else left it waiting: the node's words when it answered, else "Couldn't send it…".
                            else setFailed({ id: d.id, words: learnRefusal(e) });
                        });
                },
            },
        ]);
    };

    const leave = () => { if (router.canGoBack()) router.back(); else router.replace('/learn'); };
    const row = (d: KnowledgeDraftMine) => {
        const added = d.state === 'approved' && !!d.postId;
        const kind = t(LEARN_WRITE.kindStatus, { kind: d.kind === 'fix' ? t(LEARN_WRITE.kindFix) : t(LEARN_WRITE.kindNew), status: mineRowStatus(d) });
        const inside = (
            <>
                <Text style={s.rowTitle}>{d.title}</Text>
                <Text style={s.meta}>{kind}</Text>
                {d.state === 'declined' && d.reasonWords ? <Text style={s.words}>{d.reasonWords}</Text> : null}
                {d.state === 'waiting' ? (
                    <Pressable testID={`learn-mine-take-back-${d.id}`} accessibilityRole="button" style={s.takeBack} onPress={() => takeBack(d)}>
                        <Text style={s.takeBackText}>{t(LEARN_WRITE.takeBack)}</Text>
                    </Pressable>
                ) : null}
                {failed?.id === d.id ? (
                    <Text style={s.problem} testID={`learn-mine-problem-${d.id}`} accessibilityLiveRegion="polite">{failed.words}</Text>
                ) : null}
            </>
        );
        // Only an "Added" row opens something, so only it is one element to a screen reader. Any other row is a plain View: a
        // Pressable is an accessibility element even without onPress, and on iOS that would fold "Take it back" into the row.
        return added ? (
            <Pressable key={d.id} testID={`learn-mine-row-${d.id}`} style={s.row} accessibilityRole="button"
                onPress={() => router.push({ pathname: '/post/[id]', params: { id: d.postId!, kind: 'knowledge' } })}>
                {inside}
            </Pressable>
        ) : (
            <View key={d.id} testID={`learn-mine-row-${d.id}`} style={s.row}>{inside}</View>
        );
    };

    return (
        <View style={[s.container, { paddingTop: insets.top }]} testID="learn-mine">
            <View style={s.header}>
                <Pressable testID="learn-mine-back" accessibilityRole="button" accessibilityLabel={t(LEARN_LINES.back)} onPress={leave} style={s.back}>
                    <Text style={s.backArrow}>‹</Text>
                    <Text style={s.backText}>{t(LEARN_LINES.back)}</Text>
                </Pressable>
                <Text style={s.title} accessibilityRole="header" numberOfLines={1}>{t(LEARN_WRITE.mineTitle)}</Text>
            </View>
            <ScrollView contentContainerStyle={s.content}>
                {mine === undefined ? (
                    <ActivityIndicator size="large" color={colors.brand.primary} style={{ padding: 48 }} />
                ) : mine === null ? (
                    <Text style={s.empty} testID="learn-mine-unreachable">{t(LEARN_WRITE.unreachable)}</Text>
                ) : mine.waiting.length + mine.answered.length === 0 ? (
                    <View>
                        <Text style={s.empty}>{t(LEARN_LINES.emptyTitle)}</Text>
                        <Pressable testID="learn-mine-suggest" accessibilityRole="button" style={s.action} onPress={() => router.push('/learn/new')}>
                            <Text style={s.actionText}>{t(LEARN_WRITE.suggestPlain)}</Text>
                        </Pressable>
                    </View>
                ) : (
                    <>
                        {mine.waiting.map(row)}
                        {mine.answered.map(row)}
                    </>
                )}
            </ScrollView>
        </View>
    );
}
