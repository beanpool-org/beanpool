/**
 * One suggestion to check (slice K4 part 2 + K5 + web pictures; DESIGN-local-knowledge-fable.md §5 as amended §A5):
 * owners and admins read a waiting suggestion or fix in full, inspect its diff / photos / sources / Wikimedia Commons
 * credits, and Approve, Edit first, or say Not this one with a reason and optional words.
 * Parity with apps/pwa/src/components/LearnCheck.tsx LearnCheckOne.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator, BackHandler, DeviceEventEmitter, Keyboard, Linking, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Image } from 'expo-image';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
    KNOWLEDGE_DECLINE_REASONS, KNOWLEDGE_LIMITS, KNOWLEDGE_TAG_WORDS, KNOWLEDGE_TOPICS, formatCount, t, upperCase,
    type KnowledgeDraftWhole, type KnowledgePhotoCredit,
} from '@beanpool/core';
import { useStyles, useTheme } from '../../ThemeContext';
import { Alert } from '../../../utils/keyboard-alert';
import { leaveScreen } from '../../../utils/leave-screen';
import { forgetHomeForHeader } from '../../../utils/home-store';
import { askForPostPhoto } from '../../../utils/post-photo';
import { TagPicker } from '../../../components/TagPicker';
import { hostOf, openableSource } from '../../../components/learn/KnowledgeDetail';
import { photoToggleName } from '../../../components/learn/learn-keep';
import { LEARN_LINES, topicOf } from '../../../components/learn/learn-lines';
import {
    EMPTY_KNOWLEDGE_FORM, LEARN_WRITE, LINK_START, knowledgeFormProblem, learnRefusal,
    type KnowledgeFormValues,
} from '../../../components/learn/learn-write';
import {
    COMMONS_SITE, LEARN_CHECK_ANSWERED, LEARN_CHECK_WORDS, approveLearnDraft, commonsRestrictionNote,
    creditReadDate, declineLearnDraft, draftFromWords, draftKindWord, draftTagsText, draftWaited, fixPartLabel,
    fixPartText, readLearnDraft,
} from '../../../components/learn/learn-check';

const NO_LIBRARY = () => {};
const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v) ?? '';
const RASTER_DATA_URL = /^data:image\/(?:jpeg|jpg|png|webp|gif);base64,/i;
const shownPhoto = (src: unknown): src is string => typeof src === 'string' && RASTER_DATA_URL.test(src);

const openableHref = (url: unknown): string | null => {
    if (typeof url !== 'string' || !openableSource(url)) return null;
    try {
        return new URL(url.trim()).href;
    } catch {
        return null;
    }
};

const openableCommonsUrl = (url: unknown): string | null => {
    const href = openableHref(url);
    if (!href) return null;
    const u = new URL(href);
    return u.protocol === 'https:' && u.hostname === 'commons.wikimedia.org' && /^\/wiki\/File(?::|%3A)/i.test(u.pathname)
        ? u.href
        : null;
};

export default function LearnCheckOneScreen() {
    const router = useRouter();
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();
    const { colors } = useTheme();
    const params = useLocalSearchParams<{ id?: string | string[] }>();
    const id = first(params.id);
    const mountedRef = useRef(true);
    useEffect(() => () => { mountedRef.current = false; }, []);

    const [draft, setDraft] = useState<KnowledgeDraftWhole | null | 'failed' | undefined>(undefined);
    const [tries, setTries] = useState(0);
    const [ticked, setTicked] = useState(false);
    const [mode, setMode] = useState<'read' | 'no' | 'edit'>('read');
    const [reason, setReason] = useState<string | null>(null);
    const [words, setWords] = useState('');
    const [busy, setBusy] = useState(false);
    const [refusal, setRefusal] = useState<string | null>(null);
    const [removed, setRemoved] = useState<number[]>([]);
    const [form, setForm] = useState<KnowledgeFormValues>(EMPTY_KNOWLEDGE_FORM);
    const [edited, setEdited] = useState(false);

    useEffect(() => {
        if (!id) { setDraft(null); return undefined; }
        let live = true;
        const stop = new AbortController();
        setDraft(undefined);
        setRemoved([]);
        setTicked(false);
        setMode('read');
        setReason(null);
        setWords('');
        setRefusal(null);
        setEdited(false);
        readLearnDraft(id, stop.signal)
            .then((d) => { if (live) setDraft(d); })
            .catch(() => { if (live) setDraft('failed'); });
        return () => { live = false; stop.abort(); };
    }, [id, tries]);

    const s = useStyles(({ colors: c }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: c.surface.page },
        header: {
            flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingHorizontal: 8,
            borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border.default, backgroundColor: c.surface.chrome,
        },
        back: { flexDirection: 'row', alignItems: 'center', minWidth: 44, minHeight: 44, paddingHorizontal: 8, gap: 4 },
        backArrow: { fontSize: 22, fontWeight: '600', color: c.brand.primary, marginTop: -2 },
        backText: { fontSize: 16, fontWeight: '600', color: c.brand.primary },
        headerTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '800', color: c.text.heading, marginRight: 44 },
        content: { padding: 16, paddingBottom: 48, gap: 12 },
        chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
        chip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: c.chip.learn.bg },
        chipText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5, color: c.chip.learn.fg },
        title: { fontSize: 20, fontWeight: '800', lineHeight: 26, color: c.text.heading },
        metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
        meta: { fontSize: 13, color: c.text.secondary },
        box: {
            padding: 12, borderRadius: 12, borderWidth: 1, borderColor: c.border.default,
            backgroundColor: c.surface.card, gap: 6,
        },
        boxLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase', color: c.text.secondary },
        boxBody: { fontSize: 14, lineHeight: 20, color: c.text.body },
        boxStrong: { fontSize: 14, lineHeight: 20, fontWeight: '700', color: c.text.heading },
        subLabel: { fontSize: 12, fontWeight: '700', color: c.text.secondary, marginTop: 2 },
        moved: { fontSize: 13, fontWeight: '700', color: c.feedback.warning.fg },
        body: { fontSize: 15, lineHeight: 22, color: c.text.body },
        place: { fontSize: 14, fontWeight: '700', color: c.text.heading },
        photoWrap: { gap: 6 },
        photo: { width: '100%', aspectRatio: 4 / 3, borderRadius: 12, backgroundColor: c.surface.subtle },
        photoOff: { opacity: 0.4 },
        creditMaker: { fontSize: 14, fontWeight: '700', color: c.text.heading },
        creditNote: { fontSize: 12, fontWeight: '700', color: c.feedback.warning.fg },
        linkBtn: { minHeight: 44, justifyContent: 'center', paddingVertical: 4 },
        linkTitle: { fontSize: 14, fontWeight: '700', color: c.chip.learn.fg },
        linkHost: { fontSize: 12, color: c.text.secondary },
        small: { fontSize: 12.5, lineHeight: 18, color: c.text.secondary },
        smallBtn: {
            alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: 12,
            borderRadius: 10, borderWidth: 1, borderColor: c.border.default, backgroundColor: c.surface.card,
        },
        smallBtnText: { fontSize: 14, fontWeight: '700', color: c.text.heading },
        bullet: { fontSize: 14, lineHeight: 20, color: c.text.body },
        checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, minHeight: 44, paddingVertical: 4 },
        checkBox: {
            width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: c.border.strong,
            alignItems: 'center', justifyContent: 'center', marginTop: 1,
        },
        checkBoxOn: { backgroundColor: c.brand.fill, borderColor: c.brand.fill },
        checkMark: { fontSize: 14, fontWeight: '800', color: c.text.onBrand },
        checkLabel: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: '700', lineHeight: 20, color: c.text.heading },
        radioRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingVertical: 4 },
        radioOuter: {
            width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: c.border.strong,
            alignItems: 'center', justifyContent: 'center',
        },
        radioOuterOn: { borderColor: c.brand.primary },
        radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: c.brand.primary },
        radioLabel: { flex: 1, minWidth: 0, fontSize: 14, color: c.text.heading },
        inputLabel: { fontSize: 12, fontWeight: '800', letterSpacing: 0.6, color: c.text.secondary, marginTop: 6 },
        input: {
            minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: c.border.default, backgroundColor: c.surface.card,
            paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: c.text.body,
        },
        multiline: { minHeight: 110, textAlignVertical: 'top' },
        counter: { fontSize: 12, color: c.text.muted, textAlign: 'right' },
        topicChip: {
            minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 999,
            borderWidth: 1, borderColor: c.border.default, backgroundColor: c.surface.card,
        },
        topicChipOn: { backgroundColor: c.chip.learn.bg, borderColor: c.chip.learn.fg },
        topicChipText: { fontSize: 14, fontWeight: '700', color: c.text.body },
        topicChipTextOn: { color: c.chip.learn.fg },
        linkRow: { gap: 6, padding: 10, borderRadius: 12, borderWidth: 1, borderColor: c.border.default },
        linkTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
        remove: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
        removeText: { fontSize: 16, fontWeight: '700', color: c.text.secondary },
        thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center' },
        thumb: { width: 64, height: 64, borderRadius: 10, backgroundColor: c.surface.subtle },
        problem: { fontSize: 14, fontWeight: '700', color: c.feedback.danger.fg },
        primary: {
            minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
            paddingHorizontal: 16, backgroundColor: c.brand.fill,
        },
        primaryDisabled: { opacity: 0.55 },
        primaryText: { fontSize: 15, fontWeight: '800', color: c.text.onBrand, textAlign: 'center' },
        secondary: {
            minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
            paddingHorizontal: 16, borderWidth: 1, borderColor: c.border.default, backgroundColor: c.surface.card,
        },
        secondaryText: { fontSize: 15, fontWeight: '800', color: c.text.heading, textAlign: 'center' },
        empty: { fontSize: 15, color: c.text.secondary, paddingVertical: 20 },
    }));

    const finishWith = (said: string) => {
        forgetHomeForHeader();
        DeviceEventEmitter.emit(LEARN_CHECK_ANSWERED, said);
        if (mountedRef.current) leaveScreen(router, 'learn/check/[id]');
    };

    const leave = () => {
        if (mode === 'edit') {
            if (edited) {
                Alert.alert(t(LEARN_CHECK_WORDS.title), t(LEARN_CHECK_WORDS.leaveEditAsk), [
                    { text: t(LEARN_CHECK_WORDS.leaveEditStay), style: 'cancel' },
                    { text: t(LEARN_CHECK_WORDS.leaveEditDiscard), style: 'destructive', onPress: () => { setMode('read'); setEdited(false); setRefusal(null); } },
                ]);
                return;
            }
            setMode('read');
            setRefusal(null);
            return;
        }
        leaveScreen(router, 'learn/check/[id]');
    };

    const leaveRef = useRef(leave);
    leaveRef.current = leave;

    useEffect(() => {
        const inEdit = mode === 'edit';
        navigation.setOptions({ gestureEnabled: !inEdit });
        if (!inEdit) return undefined;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            if (!navigation.isFocused()) return false;
            leaveRef.current();
            return true;
        });
        return () => sub.remove();
    }, [navigation, mode]);

    const header = (
        <View style={s.header}>
            <Pressable testID="learn-check-one-back" accessibilityRole="button" accessibilityLabel={t(LEARN_LINES.back)} onPress={leave} style={s.back}>
                <Text style={s.backArrow}>‹</Text>
                <Text style={s.backText}>{t(LEARN_LINES.back)}</Text>
            </Pressable>
            <Text style={s.headerTitle} accessibilityRole="header" numberOfLines={1}>{t(LEARN_CHECK_WORDS.title)}</Text>
        </View>
    );

    if (draft === undefined) {
        return (
            <View style={[s.container, { paddingTop: insets.top }]} testID="learn-check-one-loading">
                {header}
                <ActivityIndicator size="large" color={colors.brand.primary} style={{ padding: 48 }} />
            </View>
        );
    }

    if (draft === 'failed') {
        return (
            <View style={[s.container, { paddingTop: insets.top }]} testID="learn-check-one-failed">
                {header}
                <View style={s.content}>
                    <View style={s.box}>
                        <Text style={s.problem}>{t(LEARN_CHECK_WORDS.loadFailed)}</Text>
                        <Pressable testID="learn-check-one-retry" accessibilityRole="button" style={s.smallBtn} onPress={() => setTries((n) => n + 1)}>
                            <Text style={s.smallBtnText}>{t(LEARN_CHECK_WORDS.tryAgain)}</Text>
                        </Pressable>
                    </View>
                </View>
            </View>
        );
    }

    if (draft === null) {
        return (
            <View style={[s.container, { paddingTop: insets.top }]} testID="learn-check-gone">
                {header}
                <View style={s.content}>
                    <Text style={s.empty}>{t(LEARN_CHECK_WORDS.alreadyAnswered)}</Text>
                </View>
            </View>
        );
    }

    const d = draft;
    const byAssistant = d.assistant !== null;
    const fix = d.kind === 'fix';
    const mayApprove = !d.needsSourcesTicked || ticked;
    const keptPhotos = d.photos.filter((src, i) => shownPhoto(src) && !removed.includes(i));
    const togglePhoto = (i: number) => setRemoved((was) => (was.includes(i) ? was.filter((x) => x !== i) : [...was, i]));

    const act = async (go: () => Promise<unknown>, said: string) => {
        if (busy) return;
        Keyboard.dismiss();
        setBusy(true);
        setRefusal(null);
        try {
            await go();
            finishWith(said);
        } catch (e) {
            if (mountedRef.current) setRefusal(learnRefusal(e));
        } finally {
            if (mountedRef.current) setBusy(false);
        }
    };

    const startEdit = () => {
        setForm({
            title: d.title,
            body: d.body,
            topic: d.topic,
            place: d.place ?? '',
            sources: d.sources.map((src) => ({ url: src.url, label: src.label })),
            photos: [...keptPhotos],
            freeTags: [...(d.freeTags ?? [])],
        });
        setEdited(false);
        setRefusal(null);
        setMode('edit');
    };

    const patchForm = (patch: Partial<KnowledgeFormValues>) => {
        setForm((prev) => ({ ...prev, ...patch }));
        setEdited(true);
        setRefusal(null);
    };

    const renderCredit = (credit: KnowledgePhotoCredit) => {
        const notes = [...new Set(credit.restrictions.map(commonsRestrictionNote))];
        const read = creditReadDate(credit.readAt);
        const creditHref = openableCommonsUrl(credit.url);
        return (
            <View style={{ gap: 2 }} testID="learn-check-credit">
                <Text style={s.creditMaker}>{credit.maker ? `📷 ${credit.maker} · ${credit.licence}` : `📷 ${credit.licence}`}</Text>
                <Text style={s.small}>{t(LEARN_CHECK_WORDS.commonsFrom, { site: COMMONS_SITE, date: read })}</Text>
                {notes.map((note) => (
                    <Text key={note} style={s.creditNote} testID="learn-check-credit-note">{note}</Text>
                ))}
                {creditHref ? (
                    <Pressable accessibilityRole="link" style={s.linkBtn} testID="learn-check-credit-page" onPress={() => { void Linking.openURL(creditHref).catch(() => {}); }}>
                        <Text style={s.linkTitle}>{t(LEARN_CHECK_WORDS.openPage)}<Text importantForAccessibility="no">{' ↗'}</Text></Text>
                    </Pressable>
                ) : null}
            </View>
        );
    };

    if (mode === 'edit') {
        const submitEdit = () => {
            const wrong = knowledgeFormProblem(form);
            if (wrong) { setRefusal(wrong); return; }
            void act(
                () => approveLearnDraft(d.id, { edits: form, lang: d.lang, checkedSources: d.needsSourcesTicked, fix }),
                fix ? t(LEARN_CHECK_WORDS.approvedFix) : t(LEARN_CHECK_WORDS.approvedNew),
            );
        };
        return (
            <View style={[s.container, { paddingTop: insets.top }]} testID="learn-check-edit-form">
                {header}
                <KeyboardAwareScrollView
                    contentContainerStyle={[s.content, { paddingBottom: 48 + insets.bottom }]}
                    keyboardShouldPersistTaps="handled"
                    bottomOffset={24}
                >
                    <Text style={s.inputLabel}>{t(LEARN_WRITE.titleLabel)}</Text>
                    <TextInput
                        testID="learn-edit-title"
                        style={s.input}
                        value={form.title}
                        onChangeText={(title) => patchForm({ title })}
                        placeholder={t(LEARN_WRITE.titleHint)}
                        placeholderTextColor={colors.text.muted}
                        accessibilityLabel={t(LEARN_WRITE.titleLabel)}
                        multiline
                        scrollEnabled={false}
                        submitBehavior="blurAndSubmit"
                        returnKeyType="next"
                        editable={!busy}
                        maxLength={KNOWLEDGE_LIMITS.title}
                    />
                    <Text style={s.inputLabel}>{t(LEARN_WRITE.bodyLabel)}</Text>
                    <TextInput
                        testID="learn-edit-body"
                        style={[s.input, s.multiline]}
                        value={form.body}
                        onChangeText={(body) => patchForm({ body })}
                        placeholder={t(LEARN_WRITE.bodyHint)}
                        placeholderTextColor={colors.text.muted}
                        accessibilityLabel={t(LEARN_WRITE.bodyLabel)}
                        multiline
                        editable={!busy}
                        maxLength={KNOWLEDGE_LIMITS.body}
                    />
                    <Text style={s.counter}>{t(LEARN_WRITE.counter, { n: formatCount(form.body.length), max: formatCount(KNOWLEDGE_LIMITS.body) })}</Text>
                    <Text style={s.inputLabel}>{t(LEARN_WRITE.topicLabel)}</Text>
                    <View style={s.chips}>
                        {KNOWLEDGE_TOPICS.map((tp) => {
                            const on = form.topic === tp.id;
                            return (
                                <Pressable
                                    key={tp.id}
                                    testID={`learn-edit-topic-${tp.id}`}
                                    accessibilityRole="button"
                                    accessibilityState={{ selected: on, disabled: busy }}
                                    disabled={busy}
                                    style={[s.topicChip, on && s.topicChipOn]}
                                    onPress={() => patchForm({ topic: tp.id })}
                                >
                                    <Text style={[s.topicChipText, on && s.topicChipTextOn]}><Text importantForAccessibility="no">{tp.emoji}{' '}</Text>{t(tp.label)}</Text>
                                </Pressable>
                            );
                        })}
                    </View>
                    <Text style={s.inputLabel}>{t(LEARN_WRITE.placeLabel)}</Text>
                    <TextInput
                        testID="learn-edit-place"
                        style={s.input}
                        value={form.place}
                        onChangeText={(place) => patchForm({ place })}
                        placeholder={t(LEARN_WRITE.placeHint)}
                        placeholderTextColor={colors.text.muted}
                        accessibilityLabel={t(LEARN_WRITE.placeLabel)}
                        editable={!busy}
                        maxLength={KNOWLEDGE_LIMITS.place}
                    />
                    <TagPicker
                        freeOnly
                        testID="learn-check-tags"
                        onChange={NO_LIBRARY}
                        freeTags={form.freeTags}
                        onFreeTagsChange={(freeTags) => patchForm({ freeTags })}
                        hints={[t(KNOWLEDGE_TAG_WORDS.hint)]}
                    />
                    <Text style={s.inputLabel}>{t(LEARN_WRITE.sourcesLabel)}</Text>
                    {form.sources.map((src, i) => (
                        <View key={i} style={s.linkRow}>
                            <View style={s.linkTop}>
                                <TextInput
                                    style={[s.input, { flex: 1, minWidth: 0 }]}
                                    value={src.url}
                                    onChangeText={(url) => patchForm({ sources: form.sources.map((x, j) => (j === i ? { ...x, url } : x)) })}
                                    accessibilityLabel={t(LEARN_WRITE.sourcesLabel)}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    keyboardType="url"
                                    editable={!busy}
                                    maxLength={KNOWLEDGE_LIMITS.sourceUrl}
                                />
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityLabel={t(LEARN_WRITE.removeLink)}
                                    accessibilityState={{ disabled: busy }}
                                    disabled={busy}
                                    style={s.remove}
                                    onPress={() => patchForm({ sources: form.sources.filter((_, j) => j !== i) })}
                                >
                                    <Text style={s.removeText}>✕</Text>
                                </Pressable>
                            </View>
                            <TextInput
                                style={s.input}
                                value={src.label}
                                onChangeText={(label) => patchForm({ sources: form.sources.map((x, j) => (j === i ? { ...x, label } : x)) })}
                                placeholder={t(LEARN_WRITE.linkLabelHint)}
                                placeholderTextColor={colors.text.muted}
                                accessibilityLabel={t(LEARN_WRITE.linkLabelHint)}
                                editable={!busy}
                                maxLength={KNOWLEDGE_LIMITS.sourceLabel}
                            />
                        </View>
                    ))}
                    {form.sources.length < KNOWLEDGE_LIMITS.sources ? (
                        <Pressable
                            accessibilityRole="button"
                            accessibilityState={{ disabled: busy }}
                            disabled={busy}
                            style={s.secondary}
                            onPress={() => patchForm({ sources: [...form.sources, { url: LINK_START, label: '' }] })}
                        >
                            <Text style={s.secondaryText}>{t(LEARN_WRITE.addLink)}</Text>
                        </Pressable>
                    ) : null}
                    {!fix && (form.photos.length > 0 || byAssistant) ? (
                        <View style={{ gap: 8 }}>
                            <Text style={s.inputLabel}>{t(LEARN_WRITE.photoLabel)}</Text>
                            <View style={s.thumbs}>
                                {form.photos.map((uri, i) => (
                                    <View key={i} style={{ alignItems: 'center', gap: 4 }}>
                                        <Image source={{ uri }} style={s.thumb} accessibilityLabel={t(LEARN_CHECK_WORDS.photoN, { n: i + 1 })} />
                                        <Pressable
                                            accessibilityRole="button"
                                            accessibilityLabel={photoToggleName(t(LEARN_WRITE.removePhoto), i)}
                                            accessibilityState={{ disabled: busy }}
                                            disabled={busy}
                                            style={s.smallBtn}
                                            onPress={() => patchForm({ photos: form.photos.filter((_, j) => j !== i) })}
                                        >
                                            <Text style={s.smallBtnText}>{t(LEARN_WRITE.removePhoto)}</Text>
                                        </Pressable>
                                    </View>
                                ))}
                            </View>
                            {byAssistant && form.photos.length < KNOWLEDGE_LIMITS.photos ? (
                                <Pressable
                                    testID="learn-edit-add-photo"
                                    accessibilityRole="button"
                                    accessibilityState={{ disabled: busy }}
                                    disabled={busy}
                                    style={s.secondary}
                                    onPress={() => {
                                        Keyboard.dismiss();
                                        askForPostPhoto((dataUrl) => {
                                            if (!mountedRef.current) return;
                                            setForm((prev) => ({
                                                ...prev,
                                                photos: [...prev.photos, dataUrl].slice(0, KNOWLEDGE_LIMITS.photos),
                                            }));
                                            setEdited(true);
                                            setRefusal(null);
                                        });
                                    }}
                                >
                                    <Text style={s.secondaryText}>{t(LEARN_WRITE.addPhoto)}</Text>
                                </Pressable>
                            ) : null}
                        </View>
                    ) : null}
                    {refusal ? <Text style={s.problem} accessibilityLiveRegion="polite">{refusal}</Text> : null}
                    <Pressable
                        testID="learn-check-edit-approve"
                        accessibilityRole="button"
                        accessibilityState={{ disabled: busy, busy }}
                        disabled={busy}
                        style={[s.primary, busy && s.primaryDisabled]}
                        onPress={submitEdit}
                    >
                        {busy ? <ActivityIndicator color={colors.text.onBrand} /> : <Text style={s.primaryText}>{t(LEARN_CHECK_WORDS.approve)}</Text>}
                    </Pressable>
                </KeyboardAwareScrollView>
            </View>
        );
    }

    const changed = d.changed ?? [];
    const moved = new Set(d.pageChanged ?? []);
    const tagsChanged = d.freeTagsChanged === true;

    return (
        <View style={[s.container, { paddingTop: insets.top }]} testID="learn-check-one">
            {header}
            <KeyboardAwareScrollView
                contentContainerStyle={[s.content, { paddingBottom: 48 + insets.bottom }]}
                keyboardShouldPersistTaps="handled"
                bottomOffset={24}
            >
                <View style={s.chips}>
                    <View style={s.chip}><Text style={s.chipText}>{upperCase(t(topicOf(d.topic).label))}</Text></View>
                    <View style={s.chip}><Text style={s.chipText}>{upperCase(draftKindWord(d.kind))}</Text></View>
                    {byAssistant ? (
                        <View style={s.chip} testID="learn-check-gathered">
                            <Text style={s.chipText}>{upperCase(t(LEARN_CHECK_WORDS.gatheredChip))}</Text>
                        </View>
                    ) : null}
                </View>

                <Text style={s.title} accessibilityRole="header">{d.title}</Text>
                <View style={s.metaRow}>
                    <Text style={s.meta}>{draftFromWords(d)}</Text>
                    <Text style={s.meta}>{draftWaited(d.createdAt)}</Text>
                </View>

                {d.note ? (
                    <View style={s.box}>
                        <Text style={s.boxLabel}>{t(LEARN_CHECK_WORDS.whatChanged)}</Text>
                        <Text style={s.boxBody}>{d.note}</Text>
                    </View>
                ) : null}

                {fix ? (
                    !d.post ? (
                        <Text style={s.empty} testID="learn-check-page-gone">{t(LEARN_CHECK_WORDS.pageGone)}</Text>
                    ) : changed.length === 0 && !tagsChanged ? (
                        <Text style={s.empty} testID="learn-check-note-alone">{t(LEARN_CHECK_WORDS.noteAlone)}</Text>
                    ) : (
                        <View style={{ gap: 8 }} testID="learn-check-parts">
                            {changed.map((part) => (
                                <View key={part} style={s.box} testID={`learn-check-part-${part}`}>
                                    <Text style={s.boxLabel}>{fixPartLabel(part)}</Text>
                                    {moved.has(part) ? (
                                        <Text style={s.moved} testID="learn-check-moved">{t(LEARN_CHECK_WORDS.moved)}</Text>
                                    ) : null}
                                    <Text style={s.subLabel}>{t(LEARN_CHECK_WORDS.now)}</Text>
                                    <Text style={s.boxBody}>{fixPartText(part, d.post!)}</Text>
                                    <Text style={s.subLabel}>{t(LEARN_CHECK_WORDS.suggested)}</Text>
                                    <Text style={s.boxStrong}>{fixPartText(part, d)}</Text>
                                </View>
                            ))}
                            {tagsChanged ? (
                                <View style={s.box} testID="learn-check-part-tags">
                                    <Text style={s.boxLabel}>{t(LEARN_CHECK_WORDS.tags)}</Text>
                                    {d.freeTagsPageChanged === true ? (
                                        <Text style={s.moved} testID="learn-check-moved">{t(LEARN_CHECK_WORDS.moved)}</Text>
                                    ) : null}
                                    <Text style={s.subLabel}>{t(LEARN_CHECK_WORDS.now)}</Text>
                                    <Text style={s.boxBody}>{draftTagsText(d.post.freeTags)}</Text>
                                    <Text style={s.subLabel}>{t(LEARN_CHECK_WORDS.suggested)}</Text>
                                    <Text style={s.boxStrong}>{draftTagsText(d.freeTags)}</Text>
                                </View>
                            ) : null}
                        </View>
                    )
                ) : null}

                <Text style={s.body} testID="learn-check-body">{d.body}</Text>

                {d.place ? (
                    <Text style={s.place}>{t(LEARN_CHECK_WORDS.where, { place: d.place })}</Text>
                ) : null}

                {(d.freeTags?.length ?? 0) > 0 ? (
                    <View style={s.box} testID="learn-check-tags">
                        <Text style={s.boxLabel}>{t(LEARN_CHECK_WORDS.tags)}</Text>
                        <Text style={s.boxBody}>{draftTagsText(d.freeTags)}</Text>
                    </View>
                ) : null}

                {d.photos.length > 0 ? (
                    <View style={{ gap: 10 }} testID="learn-check-photos">
                        <Text style={s.small}>{t(LEARN_CHECK_WORDS.photosIntro)}</Text>
                        {d.photos.map((src, i) => {
                            if (!shownPhoto(src)) return null;
                            const out = removed.includes(i);
                            const credit = d.photoCredits?.[i] ?? null;
                            return (
                                <View key={i} style={s.photoWrap} testID={`learn-check-photo-${i}`}>
                                    <Image
                                        source={{ uri: src }}
                                        style={[s.photo, out && s.photoOff]}
                                        contentFit="cover"
                                        accessibilityLabel={t(LEARN_CHECK_WORDS.photoN, { n: i + 1 })}
                                    />
                                    {credit ? renderCredit(credit) : null}
                                    {!credit && byAssistant ? (
                                        <Text style={s.small} testID="learn-check-uploaded">{t(LEARN_CHECK_WORDS.uploadedByAssistant)}</Text>
                                    ) : null}
                                    {out ? <Text style={s.small}>{t(LEARN_CHECK_WORDS.leftOut)}</Text> : null}
                                    {(() => {
                                        const toggleLabel = out ? t(LEARN_CHECK_WORDS.keepPhoto) : t(LEARN_CHECK_WORDS.removePhoto);
                                        return (
                                            <Pressable
                                                testID={`learn-check-photo-toggle-${i}`}
                                                accessibilityRole="button"
                                                accessibilityLabel={photoToggleName(toggleLabel, i)}
                                                accessibilityState={{ disabled: busy }}
                                                disabled={busy}
                                                style={s.smallBtn}
                                                onPress={() => togglePhoto(i)}
                                            >
                                                <Text style={s.smallBtnText}>{toggleLabel}</Text>
                                            </Pressable>
                                        );
                                    })()}
                                </View>
                            );
                        })}
                    </View>
                ) : null}

                {d.sources.length > 0 ? (
                    <View style={s.box} testID="learn-check-sources">
                        <Text style={s.boxLabel}>{t(LEARN_CHECK_WORDS.sources)}</Text>
                        {d.sources.map((src, i) => {
                            const host = hostOf(src.url);
                            const sourceHref = openableHref(src.url);
                            return sourceHref ? (
                                <Pressable
                                    key={`${i}-${src.url}`}
                                    accessibilityRole="link"
                                    style={s.linkBtn}
                                    onPress={() => { void Linking.openURL(sourceHref).catch(() => {}); }}
                                >
                                    <Text style={s.linkTitle}>{src.label || host}<Text importantForAccessibility="no">{' ↗'}</Text></Text>
                                    <Text style={s.linkHost}>{host}</Text>
                                </Pressable>
                            ) : (
                                <View key={`${i}-${src.url}`} style={s.linkBtn}>
                                    <Text style={s.boxStrong}>{src.label || host}</Text>
                                    <Text style={s.linkHost}>{host}</Text>
                                </View>
                            );
                        })}
                    </View>
                ) : null}

                <View style={s.box}>
                    <Text style={s.boxLabel}>{t(LEARN_CHECK_WORDS.beforeApprove)}</Text>
                    <View style={{ flexDirection: 'row', gap: 6 }}><Text style={s.bullet} importantForAccessibility="no">•</Text><Text style={[s.bullet, { flex: 1, minWidth: 0 }]}>{t(LEARN_CHECK_WORDS.checkRule1)}</Text></View>
                    <View style={{ flexDirection: 'row', gap: 6 }}><Text style={s.bullet} importantForAccessibility="no">•</Text><Text style={[s.bullet, { flex: 1, minWidth: 0 }]}>{t(LEARN_CHECK_WORDS.checkRule2)}</Text></View>
                    <View style={{ flexDirection: 'row', gap: 6 }}><Text style={s.bullet} importantForAccessibility="no">•</Text><Text style={[s.bullet, { flex: 1, minWidth: 0 }]}>{t(LEARN_CHECK_WORDS.checkRule3)}</Text></View>
                </View>

                {d.needsSourcesTicked ? (
                    <Pressable
                        testID="learn-check-tick"
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: ticked, disabled: busy }}
                        disabled={busy}
                        style={s.checkRow}
                        onPress={() => setTicked((v) => !v)}
                    >
                        <View style={[s.checkBox, ticked && s.checkBoxOn]}>
                            {ticked ? <Text style={s.checkMark} importantForAccessibility="no">✓</Text> : null}
                        </View>
                        <Text style={s.checkLabel}>{t(LEARN_CHECK_WORDS.sourcesTick)}</Text>
                    </Pressable>
                ) : null}

                {mode === 'no' ? (
                    <View style={{ gap: 10 }} testID="learn-check-no">
                        <Text style={s.boxStrong} accessibilityRole="header">{t(LEARN_CHECK_WORDS.whyNot)}</Text>
                        {KNOWLEDGE_DECLINE_REASONS.map((r) => {
                            const selected = reason === r.id;
                            return (
                                <Pressable
                                    key={r.id}
                                    testID={`learn-check-reason-${r.id}`}
                                    accessibilityRole="radio"
                                    accessibilityState={{ checked: selected, selected, disabled: busy }}
                                    disabled={busy}
                                    style={s.radioRow}
                                    onPress={() => setReason(r.id)}
                                >
                                    <View style={[s.radioOuter, selected && s.radioOuterOn]}>
                                        {selected ? <View style={s.radioInner} /> : null}
                                    </View>
                                    <Text style={s.radioLabel}>{t(r.label)}</Text>
                                </Pressable>
                            );
                        })}
                        <Text style={s.inputLabel}>{t(LEARN_CHECK_WORDS.reasonWordsLabel)}</Text>
                        <TextInput
                            testID="learn-check-no-words"
                            style={[s.input, s.multiline]}
                            value={words}
                            onChangeText={setWords}
                            accessibilityLabel={t(LEARN_CHECK_WORDS.reasonWordsLabel)}
                            editable={!busy}
                            maxLength={KNOWLEDGE_LIMITS.reasonWords}
                            multiline
                        />
                        {refusal ? <Text style={s.problem} accessibilityLiveRegion="polite">{refusal}</Text> : null}
                        <Pressable
                            testID="learn-check-no-send"
                            accessibilityRole="button"
                            accessibilityState={{ disabled: !reason || busy, busy }}
                            disabled={!reason || busy}
                            style={[s.primary, (!reason || busy) && s.primaryDisabled]}
                            onPress={() => {
                                if (!reason) return;
                                void act(
                                    () => declineLearnDraft(d.id, reason, words),
                                    byAssistant ? t(LEARN_CHECK_WORDS.declinedAssistant) : t(LEARN_CHECK_WORDS.declinedMember),
                                );
                            }}
                        >
                            {busy ? <ActivityIndicator color={colors.text.onBrand} /> : <Text style={s.primaryText}>{t(LEARN_CHECK_WORDS.send)}</Text>}
                        </Pressable>
                        <Pressable
                            testID="learn-check-no-back"
                            accessibilityRole="button"
                            accessibilityState={{ disabled: busy }}
                            disabled={busy}
                            style={[s.secondary, busy && s.primaryDisabled]}
                            onPress={() => { setMode('read'); setRefusal(null); }}
                        >
                            <Text style={s.secondaryText}>{t(LEARN_CHECK_WORDS.back)}</Text>
                        </Pressable>
                    </View>
                ) : (
                    <View style={{ gap: 10 }}>
                        <Text style={s.small}>{fix ? t(LEARN_CHECK_WORDS.approveFixHint) : t(LEARN_CHECK_WORDS.approveNewHint)}</Text>
                        {refusal ? <Text style={s.problem} accessibilityLiveRegion="polite">{refusal}</Text> : null}
                        <Pressable
                            testID="learn-check-approve"
                            accessibilityRole="button"
                            accessibilityState={{ disabled: !mayApprove || busy, busy }}
                            disabled={!mayApprove || busy}
                            style={[s.primary, (!mayApprove || busy) && s.primaryDisabled]}
                            onPress={() => void act(
                                () => approveLearnDraft(d.id, {
                                    checkedSources: d.needsSourcesTicked,
                                    ...(!fix && d.photos.length > 0 ? { photos: keptPhotos } : {}),
                                }),
                                fix ? t(LEARN_CHECK_WORDS.approvedFix) : t(LEARN_CHECK_WORDS.approvedNew),
                            )}
                        >
                            {busy ? <ActivityIndicator color={colors.text.onBrand} /> : <Text style={s.primaryText}>{t(LEARN_CHECK_WORDS.approve)}</Text>}
                        </Pressable>
                        <Pressable
                            testID="learn-check-edit"
                            accessibilityRole="button"
                            accessibilityState={{ disabled: !mayApprove || busy }}
                            disabled={!mayApprove || busy}
                            style={[s.secondary, (!mayApprove || busy) && s.primaryDisabled]}
                            onPress={startEdit}
                        >
                            <Text style={s.secondaryText}>{t(LEARN_CHECK_WORDS.editFirst)}</Text>
                        </Pressable>
                        <Pressable
                            testID="learn-check-not"
                            accessibilityRole="button"
                            accessibilityState={{ disabled: busy }}
                            disabled={busy}
                            style={[s.secondary, busy && s.primaryDisabled]}
                            onPress={() => { setMode('no'); setRefusal(null); }}
                        >
                            <Text style={s.secondaryText}>{t(LEARN_CHECK_WORDS.notThisOne)}</Text>
                        </Pressable>
                    </View>
                )}
            </KeyboardAwareScrollView>
        </View>
    );
}
