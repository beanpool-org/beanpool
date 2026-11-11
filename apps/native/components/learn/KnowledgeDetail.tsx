/**
 * A page of Local knowledge, read-only (DESIGN-local-knowledge-fable.md §3.2; slice K2 draws what a reader sees, K5 adds the
 * actions: "This helped", "Suggest a fix", the out-of-date mark, "Still right"). Top to bottom, the answer first, the photo under
 * it: Back · LOCAL KNOWLEDGE, the topic chip and 📌, the title, "Written in {language}" when it isn't the reader's, the amber
 * "This may be out of date." box, the body, "Where:", the photos (tap to see the same photo whole), SOURCES (each opens the
 * phone's browser, never inside the app), "Checked {month year}", then the writer's card or "Gathered with the assistant…",
 * the standing line, and Report. A shared link, a bell line and a Learn row all land here through post/[id].
 */
import React, { useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
    KNOWLEDGE_NAMES, currentLanguage, formatDate, inCapitalsOf, pinLive, t,
} from '@beanpool/core';
import { useStyles } from '../../app/ThemeContext';
import { useIdentity } from '../../app/IdentityContext';
import { AuthorCard, useMemberRating } from '../AuthorCard';
import { PhotoCarousel } from '../PhotoCarousel';
import { ReportReasonBox } from '../ReportReasonBox';
import { ChatPhotoViewer } from '../chat/ChatPhoto';
import { reportAbuse } from '../../utils/db';
import { reportedAlertBody } from '../../utils/reportReasons';
import { signedRequestWords } from '../signed-request-lines';
import { LANGUAGE_NAMES } from '../../utils/language-choice';
import type { KnowledgePage } from '../../utils/learn-copy';
import { ChipText } from './KnowledgeRowCard';
import { LEARN_LINES, monthYear, topicOf } from './learn-lines';

/**
 * Whether a source's address may be opened: http or https, a host, no user name or password (the node's own rule for a join
 * link, apps/server engine/posts.ts cleanEventLink, DESIGN-local-knowledge-fable.md §7 "A bad link"). The phone holds the same
 * line itself, so a node that sent anything else (a `javascript:` or `intent:` address, `https://name:pass@host`) gets no link.
 */
export function openableSource(url: unknown): url is string {
    if (typeof url !== 'string' || url.length > 500) return false;
    try {
        const u = new URL(url);
        return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.host && !u.username && !u.password;
    } catch {
        return false;
    }
}

/** The host a source link goes to, to show before the tap: "www.example.org", never the whole address. */
export function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

/** A route that names a page the phone and the node don't hold (taken down, or never here): a spinner while it looks, then one line and Back. */
export function KnowledgeMissing({ settled }: { settled: boolean }) {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const styles = useStyles(({ colors }) => StyleSheet.create({
        container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16, backgroundColor: colors.surface.app },
        text: { fontSize: 16, lineHeight: 24, textAlign: 'center', color: colors.text.secondary },
        button: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 20, borderRadius: 12, backgroundColor: colors.brand.fill },
        buttonText: { fontSize: 15, fontWeight: '800', color: colors.text.inverse },
    }));
    return (
        <View style={[styles.container, { paddingTop: insets.top }]} testID="knowledge-missing">
            {settled ? (
                <>
                    <Text style={styles.text}>{t(LEARN_LINES.notFound)}</Text>
                    <Pressable accessibilityRole="button" style={styles.button} onPress={() => { if (router.canGoBack()) router.back(); else router.replace('/learn' as any); }}>
                        <Text style={styles.buttonText}>{t(LEARN_LINES.back)}</Text>
                    </Pressable>
                </>
            ) : <ActivityIndicator size="large" />}
        </View>
    );
}

export function KnowledgeDetail({ page }: { page: KnowledgePage }) {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { identity } = useIdentity();
    const [viewerUri, setViewerUri] = useState<string | null>(null);
    const [reporting, setReporting] = useState(false);
    const styles = useStyles(({ colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        header: {
            flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingHorizontal: 8,
            borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border.default, backgroundColor: colors.surface.chrome,
        },
        back: { flexDirection: 'row', alignItems: 'center', minWidth: 44, minHeight: 44, paddingHorizontal: 8, gap: 4 },
        backArrow: { fontSize: 22, fontWeight: '600', color: colors.brand.primary, marginTop: -2 },
        backText: { fontSize: 16, fontWeight: '600', color: colors.brand.primary },
        kind: { flex: 1, textAlign: 'center', fontSize: 12, fontWeight: '800', letterSpacing: 1, color: colors.chip.learn.fg, marginRight: 44 },
        content: { padding: 16, paddingBottom: 48, gap: 12 },
        chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
        title: { fontSize: 24, fontWeight: '800', color: colors.text.heading },
        written: { fontSize: 13, color: colors.text.secondary },
        outdated: {
            borderWidth: 1, borderRadius: 12, padding: 12, gap: 2,
            backgroundColor: colors.feedback.warning.bg, borderColor: colors.feedback.warning.border,
        },
        outdatedHead: { fontSize: 15, fontWeight: '800', color: colors.feedback.warning.fg },
        outdatedNote: { fontSize: 14, color: colors.text.body },
        outdatedWhen: { fontSize: 12, color: colors.text.secondary },
        body: { fontSize: 16, lineHeight: 24, color: colors.text.body },
        where: { fontSize: 15, fontWeight: '700', color: colors.text.body },
        label: { fontSize: 11, fontWeight: '800', letterSpacing: 1, color: colors.text.secondary },
        source: {
            minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 12,
            borderRadius: 12, borderWidth: 1, backgroundColor: colors.surface.card, borderColor: colors.border.default,
        },
        sourceText: { flex: 1, minWidth: 0 },
        sourceLabel: { fontSize: 15, fontWeight: '700', color: colors.text.body },
        sourceHost: { fontSize: 12.5, color: colors.text.secondary },
        sourceOut: { fontSize: 16, fontWeight: '800', color: colors.chip.learn.fg },
        checked: { fontSize: 13, color: colors.text.secondary },
        gathered: { fontSize: 14, color: colors.text.body },
        standing: { fontSize: 12.5, color: colors.text.secondary },
        report: { minHeight: 48, justifyContent: 'center' },
        reportText: { fontSize: 14, fontWeight: '700', color: colors.feedback.danger.fg },
    }));
    const k = page.knowledge ?? {};
    const topic = topicOf(page.category);
    const pinned = pinLive({ pinnedUntil: page.pinnedUntil, status: 'active', active: true, type: 'knowledge' } as any);
    const rating = useMemberRating(k.gathered ? null : page.authorPublicKey);
    const readerLang = currentLanguage();
    const writtenIn = k.lang && k.lang !== readerLang ? (LANGUAGE_NAMES as Record<string, string>)[k.lang] ?? null : null;
    const photos = (page.photos ?? []).filter((p) => typeof p === 'string' && p !== '');
    const sources = (k.sources ?? []).filter((s) => s && openableSource(s.url));
    const leave = () => { if (router.canGoBack()) router.back(); else router.replace('/learn' as any); };

    return (
        <View style={[styles.container, { paddingTop: insets.top }]} testID="knowledge-page">
            <View style={styles.header}>
                <Pressable testID="knowledge-back" accessibilityRole="button" accessibilityLabel={t('Back')} onPress={leave} style={styles.back}>
                    <Text style={styles.backArrow}>‹</Text>
                    <Text style={styles.backText}>{t('Back')}</Text>
                </Pressable>
                <Text style={styles.kind} accessibilityRole="header">{inCapitalsOf(t(KNOWLEDGE_NAMES.kind))}</Text>
            </View>
            <ScrollView contentContainerStyle={styles.content}>
                <View style={styles.chips}>
                    <ChipText bg="learn">{t(LEARN_LINES.emojiTopic, { emoji: topic.emoji, topic: inCapitalsOf(t(topic.label)) })}</ChipText>
                    {pinned ? <ChipText bg="learn">{t(LEARN_LINES.pinned)}</ChipText> : null}
                </View>
                <Text style={styles.title} selectable>{page.title}</Text>
                {writtenIn ? <Text style={styles.written}>{t(LEARN_LINES.writtenIn, { language: writtenIn })}</Text> : null}
                {k.outdatedAt ? (
                    <View style={styles.outdated} testID="knowledge-outdated">
                        <Text style={styles.outdatedHead}>{t(LEARN_LINES.outdatedBox)}</Text>
                        {k.outdatedNote ? <Text style={styles.outdatedNote}>{k.outdatedNote}</Text> : null}
                        {monthYear(k.outdatedAt) ? <Text style={styles.outdatedWhen}>{t(LEARN_LINES.markedOn, { date: formatDate(new Date(k.outdatedAt), 'day-month-year') })}</Text> : null}
                    </View>
                ) : null}
                {/* Plain text, selectable so the phone's own Translate works; never markup, never links made out of the words. */}
                <Text style={styles.body} selectable>{page.description}</Text>
                {k.place ? <Text style={styles.where}>{t(LEARN_LINES.where, { place: k.place })}</Text> : null}
                {photos.length > 0 ? <PhotoCarousel photos={photos} height={220} borderRadius={14} onOpen={(_i, uri) => setViewerUri(uri)} /> : null}
                {sources.length > 0 ? (
                    <View style={{ gap: 8 }}>
                        <Text style={styles.label}>{t(LEARN_LINES.sources)}</Text>
                        {sources.map((s) => (
                            <Pressable
                                key={s.url}
                                accessibilityRole="link"
                                accessibilityLabel={t('{label}, opens in your browser', { label: s.label || hostOf(s.url) })}
                                onPress={() => { void Linking.openURL(s.url).catch(() => {}); }}
                                style={styles.source}
                                testID="knowledge-source"
                            >
                                <View style={styles.sourceText}>
                                    <Text style={styles.sourceLabel} numberOfLines={2}>{s.label || hostOf(s.url)}</Text>
                                    <Text style={styles.sourceHost} numberOfLines={1}>{hostOf(s.url)}</Text>
                                </View>
                                <Text style={styles.sourceOut}>↗</Text>
                            </Pressable>
                        ))}
                    </View>
                ) : null}
                {monthYear(k.checkedAt) ? <Text style={styles.checked}>{t(LEARN_LINES.checked, { date: monthYear(k.checkedAt) })}</Text> : null}
                {k.gathered ? (
                    <Text style={styles.gathered} testID="knowledge-gathered">{t(LEARN_LINES.gathered)}</Text>
                ) : page.authorPublicKey ? (
                    <AuthorCard
                        label={t(LEARN_LINES.writtenBy)}
                        pubkey={page.authorPublicKey}
                        callsign={page.authorCallsign ?? ''}
                        rating={rating}
                        onPress={() => router.push({ pathname: '/public-profile', params: { publicKey: page.authorPublicKey, callsign: page.authorCallsign ?? '' } })}
                    />
                ) : null}
                <Text style={styles.standing}>{t(LEARN_LINES.standing)}</Text>
                {identity && page.authorPublicKey !== identity.publicKey ? (
                    <View>
                        <Pressable accessibilityRole="button" accessibilityLabel={t('Report this page')} style={styles.report} onPress={() => setReporting((v) => !v)} testID="knowledge-report">
                            <Text style={styles.reportText}>{t(LEARN_LINES.report)}</Text>
                        </Pressable>
                        {reporting ? (
                            <ReportReasonBox
                                onCancel={() => setReporting(false)}
                                onSubmit={async (reason) => {
                                    try {
                                        const sent = await reportAbuse(identity.publicKey, page.authorPublicKey ?? '', reason, page.id);
                                        setReporting(false);
                                        Alert.alert(t(LEARN_LINES.reported), reportedAlertBody(sent?.wordsLeftOut, reason));
                                    } catch (e: any) {
                                        Alert.alert(t('Error'), signedRequestWords(e.message));
                                        throw e;
                                    }
                                }}
                            />
                        ) : null}
                    </View>
                ) : null}
            </ScrollView>
            {viewerUri ? <ChatPhotoViewer uri={viewerUri} onClose={() => setViewerUri(null)} /> : null}
        </View>
    );
}
