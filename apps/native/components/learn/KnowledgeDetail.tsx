/**
 * A page of Local knowledge, read-only (DESIGN-local-knowledge-fable.md §3.2; slice K2 draws what a reader sees, K5 adds the
 * actions: "This helped", "Suggest a fix", the out-of-date mark, "Still right"). Top to bottom, the answer first, the photo under
 * it: Back · LOCAL KNOWLEDGE, the topic chip and 📌, the title, "Written in {language}" when it isn't the reader's, the amber
 * "This may be out of date." box, the body, "Where:", the photos (tap to see the same photo whole), SOURCES (each opens the
 * phone's browser, never inside the app), "Checked {month year}", then the writer's card or "Gathered with the assistant…",
 * the standing line, and Report. A shared link, a bell line and a Learn row all land here through post/[id]. Learn's tags (16 Nov
 * 2026): under "Where:", the page's own tags, each opening Learn on a search for it.
 *
 * Keeping it right (slice K5 B, §3.2 items 9-11): under the standing line "👍 This helped" and "Helped {n}", "Something changed?
 * Suggest a fix" (app/learn/new.tsx?fix=…: it waits for an owner or admin), and the writer's, owner's and admin's tools: "Edit",
 * "Still right", "Mark as out of date" with a note, "Clear the mark" (learn-keep.ts pageActions; the web's are the same). Only
 * on a live Learn, to a member with a key. The node's refusal shows in its own words (learnRefusal), never a success it didn't give.
 */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
    KNOWLEDGE_LIMITS, KNOWLEDGE_NAMES, KNOWLEDGE_TAG_WORDS, KNOWLEDGE_THANK, LOCAL_GUIDE_WORDS, currentLanguage, formatCount, formatDate, inCapitalsOf,
    knowledgeThankNote, knowledgeThankOffered, pinLive, t,
} from '@beanpool/core';
import { useStyles, useTheme } from '../../app/ThemeContext';
import { useIdentity } from '../../app/IdentityContext';
import { AuthorCard, useMemberRating } from '../AuthorCard';
import { PhotoCarousel } from '../PhotoCarousel';
import { PostTagChips } from '../PostTagChips';
import { ReportReasonBox } from '../ReportReasonBox';
import { ChatPhotoViewer } from '../chat/ChatPhoto';
import { reportAbuse, signedGet, signedRequestWithMethod } from '../../utils/db';
// The page has a text field (the out-of-date note), so its alerts close the keyboard first (utils/keyboard-alert.ts).
import { Alert } from '../../utils/keyboard-alert';
import { useLearnMode } from '../../utils/use-learn-mode';
import { reportedAlertBody } from '../../utils/reportReasons';
import { signedRequestWords } from '../signed-request-lines';
import { LANGUAGE_NAMES } from '../../utils/language-choice';
import type { KnowledgePage } from '../../utils/learn-copy';
import { ChipText } from './KnowledgeRowCard';
import { LEARN_LINES, monthYear, topicOf } from './learn-lines';
import { LEARN_KEEP, pageActions } from './learn-keep';
import { learnRefusal } from './learn-write';
import { useLearnWriter } from './useLearnWriter';

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

/**
 * `beansLive`: Beans are live for this member here (not off, not the worldwide preview), which the route reads
 * (app/post/[id].tsx): only then is "🫘 Thank {name}" offered (K8).
 */
export function KnowledgeDetail({ page: held, beansLive = false }: { page: KnowledgePage; beansLive?: boolean }) {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { identity } = useIdentity();
    const { colors } = useTheme();
    const [viewerUri, setViewerUri] = useState<string | null>(null);
    const [reporting, setReporting] = useState(false);
    // Keeping it right (K5): the node's answer to an action, shown until the copy catches up (a new `held` drops it); this
    // member's tap and its count; "Still right" done; the out-of-date note being written (null: shut); the node's refusal.
    const [answered, setAnswered] = useState<KnowledgePage | null>(null);
    const [helped, setHelped] = useState<{ n: number; mine: boolean } | null>(null);
    const [stillRight, setStillRight] = useState(false);
    const [marking, setMarking] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [refusal, setRefusal] = useState<string | null>(null);
    // The copy has caught up once it holds this change or a later one; a sync that brings nothing newer keeps the answer.
    const caughtUp = !!answered && !!held.updatedAt && !!answered.updatedAt && held.updatedAt >= answered.updatedAt;
    const page = answered && answered.id === held.id && !caughtUp ? answered : held;
    const live = useLearnMode() === 'live';
    const { checks } = useLearnWriter(live, false);
    const own = !!identity?.publicKey && page.authorPublicKey === identity.publicKey;
    const acts = pageActions({ signedIn: !!identity?.publicKey, live, own, checks, outdated: !!page.knowledge?.outdatedAt });
    // Thank (K8, §2.10): where Beans are live for this member, on a page with a writer that isn't theirs and wasn't gathered with
    // the assistant. It opens the Ledger's Send form; whether they can send yet is the form's to say, in today's words.
    const thank = knowledgeThankOffered({ signedIn: !!identity?.publicKey, live, beansLive, own, gathered: !!page.knowledge?.gathered, writer: page.authorPublicKey });
    // The writer's Local guide badge (K8): only a signed read of the page by id says, worked out now (the copy never holds one).
    const [writerGuide, setWriterGuide] = useState(false);
    const reads = !!identity?.publicKey && live;
    // Whether this member tapped before: only a signed read of the page by id says (never the copy, never a list).
    useEffect(() => {
        setHelped(null); setStillRight(false); setMarking(null); setRefusal(null); setWriterGuide(false);
        if (!reads) return undefined;
        let gone = false;
        signedGet(`/api/marketplace/posts?type=knowledge&id=${encodeURIComponent(held.id)}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((rows) => {
                const k = Array.isArray(rows) ? rows.find((r: any) => r?.id === held.id)?.knowledge : null;
                if (gone || !k) return;
                if (acts.helped && typeof k.helpedByMe === 'boolean') setHelped({ n: typeof k.helped === 'number' ? k.helped : 0, mine: k.helpedByMe });
                setWriterGuide(k.writerLocalGuide === true);
            })
            .catch(() => { /* offline: the count is the copy's, and a tap asks the node */ });
        return () => { gone = true; };
    }, [held.id, acts.helped, reads]);
    /** One action, signed: the node's answer redraws the page; its refusal is shown in its own words, and nothing else changes. */
    const act = async (method: string, path: string, body?: unknown, after?: (answer: any) => void) => {
        if (busy) return;
        setBusy(true);
        setRefusal(null);
        try {
            const answer = await signedRequestWithMethod(method, path, body, { withStatus: true });
            if (answer?.post?.knowledge) setAnswered(answer.post);
            after?.(answer);
        } catch (e) {
            setRefusal(learnRefusal(e));
        } finally {
            setBusy(false);
        }
    };
    const at = `/api/knowledge/posts/${encodeURIComponent(page.id)}`;
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
        row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
        tool: {
            minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 12, borderWidth: 1,
            borderColor: colors.border.default, backgroundColor: colors.surface.card,
        },
        toolOn: { backgroundColor: colors.chip.learn.bg, borderColor: colors.chip.learn.fg },
        thank: { alignSelf: 'flex-start' },
        toolText: { fontSize: 15, fontWeight: '800', color: colors.text.body },
        toolTextOn: { color: colors.chip.learn.fg },
        count: { fontSize: 14, fontWeight: '700', color: colors.text.secondary },
        fixLink: { minHeight: 44, justifyContent: 'center' },
        fixText: { fontSize: 15, fontWeight: '800', color: colors.chip.learn.fg },
        markBox: { gap: 8, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card },
        input: {
            minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.page,
            paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: colors.text.body,
        },
        primary: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 12, backgroundColor: colors.brand.fill },
        primaryText: { fontSize: 15, fontWeight: '800', color: colors.text.inverse },
        refusal: { fontSize: 14, fontWeight: '700', color: colors.feedback.danger.fg },
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
                {/* Its own tags (Learn's tags): each opens Learn on a search for it, never the Market. */}
                <PostTagChips tags={[]} freeTags={page.freeTags} freeTagLabel={(tag) => t(KNOWLEDGE_TAG_WORDS.searchFor, { tag })}
                    onFreeTag={(tag) => router.push({ pathname: '/learn', params: { q: encodeURIComponent(tag) } } as any)} />
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
                        badge={writerGuide ? t(LOCAL_GUIDE_WORDS.line) : null}
                        onPress={() => router.push({ pathname: '/public-profile', params: { publicKey: page.authorPublicKey, callsign: page.authorCallsign ?? '' } })}
                    />
                ) : null}
                {thank ? (
                    <Pressable testID="knowledge-thank" accessibilityRole="button" style={[styles.tool, styles.thank]}
                        onPress={() => router.push({ pathname: '/(tabs)/ledger', params: { sendTo: page.authorPublicKey, sendName: page.authorCallsign ?? '', sendNote: knowledgeThankNote(page.title ?? '') } } as any)}>
                        <Text style={styles.toolText}>{t(KNOWLEDGE_THANK.button, { name: page.authorCallsign ?? '' })}</Text>
                    </Pressable>
                ) : null}
                <Text style={styles.standing}>{t(LEARN_LINES.standing)}</Text>
                {(() => {
                    const n = helped?.n ?? page.knowledge?.helped ?? 0;
                    const mine = helped?.mine ?? !!(page.knowledge as { helpedByMe?: boolean } | undefined)?.helpedByMe;
                    const tools = acts.edit || acts.stillRight || acts.markOutdated || acts.clearMark;
                    return (
                        <>
                            {acts.helped || n > 0 ? (
                                <View style={styles.row}>
                                    {acts.helped ? (
                                        <Pressable testID="knowledge-helped" accessibilityRole="button" accessibilityState={{ selected: mine, disabled: busy }} disabled={busy}
                                            style={[styles.tool, mine && styles.toolOn]}
                                            onPress={() => void act('POST', `${at}/helped`, { on: !mine }, (a) => setHelped({ n: Number(a?.helped) || 0, mine: !!a?.helpedByMe }))}>
                                            <Text style={[styles.toolText, mine && styles.toolTextOn]}>{mine ? t(LEARN_KEEP.helpedDone) : t(LEARN_KEEP.helped)}</Text>
                                        </Pressable>
                                    ) : null}
                                    {n > 0 ? <Text style={styles.count} testID="knowledge-helped-count">{t(LEARN_LINES.helped, { n: formatCount(n) })}</Text> : null}
                                </View>
                            ) : null}
                            {acts.fix ? (
                                <Pressable testID="knowledge-fix" accessibilityRole="button" style={styles.fixLink}
                                    onPress={() => router.push({ pathname: '/learn/new', params: { fix: page.id } } as any)}>
                                    <Text style={styles.fixText}>{own ? t(LEARN_KEEP.fix) : t(LEARN_KEEP.fixAsk)}</Text>
                                </Pressable>
                            ) : null}
                            {tools ? (
                                <View style={styles.row} testID="knowledge-tools">
                                    {acts.edit ? (
                                        <Pressable testID="knowledge-edit" accessibilityRole="button" style={styles.tool}
                                            onPress={() => router.push({ pathname: '/learn/new', params: { edit: page.id } } as any)}>
                                            <Text style={styles.toolText}>{t(LEARN_KEEP.edit)}</Text>
                                        </Pressable>
                                    ) : null}
                                    {acts.stillRight ? (
                                        <Pressable testID="knowledge-still-right" accessibilityRole="button" accessibilityState={{ selected: stillRight, disabled: busy || stillRight }}
                                            disabled={busy || stillRight} style={[styles.tool, stillRight && styles.toolOn]} onPress={() => void act('POST', `${at}/checked`, undefined, () => setStillRight(true))}>
                                            <Text style={[styles.toolText, stillRight && styles.toolTextOn]}>{stillRight ? t(LEARN_KEEP.stillRightDone) : t(LEARN_KEEP.stillRight)}</Text>
                                        </Pressable>
                                    ) : null}
                                    {acts.markOutdated && marking === null ? (
                                        <Pressable testID="knowledge-mark" accessibilityRole="button" style={styles.tool} onPress={() => { setRefusal(null); setMarking(''); }}>
                                            <Text style={styles.toolText}>{t(LEARN_KEEP.markOutdated)}</Text>
                                        </Pressable>
                                    ) : null}
                                    {acts.clearMark ? (
                                        <Pressable testID="knowledge-clear" accessibilityRole="button" disabled={busy} style={styles.tool} onPress={() => void act('POST', `${at}/outdated/clear`)}>
                                            <Text style={styles.toolText}>{t(LEARN_KEEP.clearMark)}</Text>
                                        </Pressable>
                                    ) : null}
                                </View>
                            ) : null}
                            {acts.markOutdated && marking !== null ? (
                                <View style={styles.markBox} testID="knowledge-mark-box">
                                    <TextInput testID="knowledge-mark-note" style={styles.input} value={marking} onChangeText={setMarking} maxLength={KNOWLEDGE_LIMITS.outdatedNote}
                                        multiline scrollEnabled={false} placeholder={t(LEARN_KEEP.outdatedHint)} placeholderTextColor={colors.text.muted} accessibilityLabel={t(LEARN_KEEP.outdatedHint)} />
                                    <View style={styles.row}>
                                        <Pressable testID="knowledge-mark-send" accessibilityRole="button" disabled={busy} style={styles.primary}
                                            onPress={() => void act('POST', `${at}/outdated`, { note: marking.trim() }, () => { setMarking(null); setStillRight(false); })}>
                                            <Text style={styles.primaryText}>{t(LEARN_KEEP.markOutdated)}</Text>
                                        </Pressable>
                                        <Pressable accessibilityRole="button" style={styles.tool} onPress={() => setMarking(null)}>
                                            <Text style={styles.toolText}>{t(LEARN_KEEP.cancel)}</Text>
                                        </Pressable>
                                    </View>
                                </View>
                            ) : null}
                            {busy ? <ActivityIndicator /> : null}
                            {refusal ? <Text style={styles.refusal} testID="knowledge-refusal" accessibilityLiveRegion="polite">{refusal}</Text> : null}
                        </>
                    );
                })()}
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
