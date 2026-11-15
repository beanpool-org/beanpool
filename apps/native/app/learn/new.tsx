/**
 * Learn's form (slice K4; DESIGN-local-knowledge-fable.md §3.3 as amended): one screen for "＋ Suggest knowledge" in Learn and the
 * + chooser's 📖 Local knowledge row, pushed over the tabs with its own Back row, like the calendar. A member's page goes to the
 * waiting list (POST /api/knowledge/drafts) and shows to nobody until an owner or admin approves it; an owner's or admin's own
 * page publishes at once (POST /api/knowledge/posts). The node words every refusal in the member's language, and it is shown as
 * it comes; no answer at all reads "Couldn't send it. Check your connection and try again." (learnRefusal). The form checks first
 * what it can (a title, what to know, a topic, a link's start).
 *
 * `?from=learn`: opened from Learn, so "Open Learn" after publishing goes back to it rather than opening a second.
 *
 * Slice K5 B (§3.5): `?fix=<page id>` is "Suggest a fix": the same form filled with the page as it shows, "WHAT CHANGED? *"
 * first, no photo; it sends only the parts changed and the note to the waiting list (learn-keep.ts fixBody), never onto the page.
 * `?edit=<page id>` is an owner's or admin's "Edit": the same form, saved at once (POST /api/knowledge/posts/:id/edit).
 *
 * Both are sent against the page the form opened on, and only that (review of #3218): the member's changes to it. A sync while
 * the form is open, or the page leaving the copy, changes nothing in the form or in what it sends; the node answers when it is
 * sent (a page taken down meanwhile is refused in its words). A fix opens on the page as it shows (the copy, or the node when the
 * copy hasn't it). An edit opens on the page as the node has it, read when the form opens, as the web does: /edit rewrites the
 * whole page, so starting from a copy that's behind would put older words back. Not reached, the edit doesn't open.
 *
 * Tags (Learn's tags, 16 Nov 2026): the Market's own Tags field, the member's own tags alone (TagPicker `freeOnly`), after Where,
 * as on the web. A fix and an edit open on the page's tags; a fix sends them only when changed, an edit always ([] takes them off).
 */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KNOWLEDGE_LIMITS, KNOWLEDGE_NAMES, KNOWLEDGE_TAG_WORDS, KNOWLEDGE_TOPICS, currentLanguage, formatCount, t } from '@beanpool/core';
import { useStyles, useTheme } from '../ThemeContext';
import { LEARN_LINES } from '../../components/learn/learn-lines';
import {
    EMPTY_KNOWLEDGE_FORM, LEARN_WRITE, LINK_START, knowledgeFormBody, knowledgeFormPath, knowledgeFormProblem, learnRefusal, refusalCode,
    type KnowledgeFormValues,
} from '../../components/learn/learn-write';
import { forgetLearnRole, useLearnWriter } from '../../components/learn/useLearnWriter';
import { LEARN_KEEP, editBody, fixBody, formOfPage } from '../../components/learn/learn-keep';
import { readNodePage, useKnowledgePage } from '../../components/learn/useKnowledgePage';
import type { KnowledgePage } from '../../utils/learn-copy';
import { useIdentity } from '../IdentityContext';
import { useLearnMode } from '../../utils/use-learn-mode';
import { askForPostPhoto } from '../../utils/post-photo';
import { TagPicker } from '../../components/TagPicker';

/** The Market's picker reads library tags it is never given here (freeOnly). */
const NO_LIBRARY = () => {};
/** Learn's line under the Tags field, in place of the Market's two. */
const TAG_HINTS = [KNOWLEDGE_TAG_WORDS.hint];
import { signedRequestWithMethod } from '../../utils/db';

export default function NewKnowledgeScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { colors } = useTheme();
    const { from, fix, edit } = useLocalSearchParams<{ from?: string; fix?: string; edit?: string }>();
    // "Suggest a fix" or "Edit" (K5): the page they start from. `opened`: the page the form was filled from, kept as it was:
    // what is sent is the member's changes to it, never to a newer copy that a sync brings meanwhile.
    const pageId = typeof fix === 'string' && fix ? fix : typeof edit === 'string' && edit ? edit : undefined;
    const use: 'new' | 'fix' | 'edit' = !pageId ? 'new' : pageId === fix ? 'fix' : 'edit';
    const { page, settled } = useKnowledgePage(use === 'fix' ? pageId : undefined, true);
    const [opened, setOpened] = useState<KnowledgePage | null>(null);
    // An edit's read of the node's page: under way, the node has no such page, or not reached (then "Try again").
    const [nodeRead, setNodeRead] = useState<'reading' | 'none' | 'unreached'>('reading');
    const [tries, setTries] = useState(0);
    const [note, setNote] = useState('');
    const live = useLearnMode() === 'live';
    const writer = useLearnWriter(live);
    const { identity } = useIdentity();
    // The node knows best, over the role remembered for ten minutes: a member it says is an owner or admin publishes instead
    // (`publish_instead`), and an owner or admin no longer suggests (`admins_only`).
    const [heard, setHeard] = useState<'checks' | 'member' | null>(null);
    const checks = heard ? heard === 'checks' : writer.checks;
    const [form, setForm] = useState<KnowledgeFormValues>(EMPTY_KNOWLEDGE_FORM);
    const [problem, setProblem] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState<'sent' | 'published' | null>(null);
    const set = (patch: Partial<KnowledgeFormValues>) => { setForm((f) => ({ ...f, ...patch })); setProblem(null); };
    useEffect(() => {
        if (use === 'fix' && page && !opened) { setForm(formOfPage(page)); setOpened(page); }
    }, [use, page, opened]);
    useEffect(() => {
        if (use !== 'edit' || !pageId) return undefined;
        let gone = false;
        setNodeRead('reading');
        void readNodePage(pageId).then((p) => {
            if (gone) return;
            if (p) { setForm(formOfPage(p)); setOpened(p); } else setNodeRead(p === null ? 'none' : 'unreached');
        });
        return () => { gone = true; };
    }, [use, pageId, tries]);

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
        content: { padding: 16, paddingBottom: 48, gap: 8 },
        box: { padding: 12, borderRadius: 12, backgroundColor: c.chip.learn.bg, marginBottom: 8 },
        boxText: { fontSize: 14, lineHeight: 20, color: c.text.body },
        label: { fontSize: 12, fontWeight: '800', letterSpacing: 0.6, color: c.text.secondary, marginTop: 12 },
        input: {
            minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: c.border.default, backgroundColor: c.surface.card,
            paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: c.text.body,
        },
        multiline: { minHeight: 140, textAlignVertical: 'top' },
        counter: { fontSize: 12, color: c.text.muted, textAlign: 'right' },
        chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
        chip: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: c.border.default, backgroundColor: c.surface.card },
        chipOn: { backgroundColor: c.chip.learn.bg, borderColor: c.chip.learn.fg },
        chipText: { fontSize: 14, fontWeight: '700', color: c.text.body },
        chipTextOn: { color: c.chip.learn.fg },
        link: { gap: 6, padding: 10, borderRadius: 12, borderWidth: 1, borderColor: c.border.default },
        linkTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
        remove: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
        removeText: { fontSize: 16, fontWeight: '700', color: c.text.secondary },
        secondary: {
            minHeight: 48, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 14, borderRadius: 12, borderWidth: 1,
            borderColor: c.chip.learn.fg, backgroundColor: c.surface.card,
        },
        secondaryText: { fontSize: 15, fontWeight: '800', color: c.chip.learn.fg, textAlign: 'center' },
        photos: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center' },
        photo: { width: 64, height: 64, borderRadius: 10, backgroundColor: c.surface.subtle },
        small: { fontSize: 13, lineHeight: 18, color: c.text.secondary },
        problem: { fontSize: 14, fontWeight: '700', color: c.feedback.danger.fg, marginTop: 12 },
        primary: { minHeight: 52, marginTop: 16, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, backgroundColor: c.brand.fill },
        primaryText: { fontSize: 16, fontWeight: '800', color: c.text.inverse, textAlign: 'center' },
        doneTitle: { fontSize: 22, fontWeight: '800', color: c.text.heading, textAlign: 'center', marginTop: 32 },
        doneLine: { fontSize: 16, lineHeight: 22, color: c.text.body, textAlign: 'center' },
    }));

    const leave = () => { if (router.canGoBack()) router.back(); else router.replace('/learn'); };
    const header = (
        <View style={s.header}>
            <Pressable testID="learn-new-back" accessibilityRole="button" accessibilityLabel={t(LEARN_LINES.back)} onPress={leave} style={s.back}>
                <Text style={s.backArrow}>‹</Text>
                <Text style={s.backText}>{t(LEARN_LINES.back)}</Text>
            </Pressable>
            <Text style={s.title} accessibilityRole="header" numberOfLines={1}>
                {use === 'fix' ? t(LEARN_KEEP.fix) : use === 'edit' ? t(LEARN_KEEP.edit) : t(KNOWLEDGE_NAMES.kind)}
            </Text>
        </View>
    );

    const send = async () => {
        Keyboard.dismiss();
        const wrong = use === 'fix' && !note.trim() ? t(LEARN_KEEP.noNote) : knowledgeFormProblem(form);
        if (wrong) { setProblem(wrong); return; }
        setBusy(true);
        if (use !== 'new' && opened) {
            // A fix waits for an owner or admin; an owner's or admin's edit is saved at once. Each against the page it opened on.
            // The node's refusal, in its words.
            try {
                if (use === 'fix') {
                    await signedRequestWithMethod('POST', '/api/knowledge/drafts', fixBody(opened, form, note), { withStatus: true });
                    setDone('sent');
                } else {
                    await signedRequestWithMethod('POST', `/api/knowledge/posts/${encodeURIComponent(opened.id)}/edit`, editBody(opened, form), { withStatus: true });
                    leave();
                }
            } catch (e) {
                setProblem(learnRefusal(e));
            } finally {
                setBusy(false);
            }
            return;
        }
        const body = knowledgeFormBody(form, currentLanguage());
        const post = (publish: boolean) => signedRequestWithMethod('POST', knowledgeFormPath(publish), body, { withStatus: true });
        try {
            let published = checks;
            try {
                await post(checks);
            } catch (e) {
                // An owner or admin no longer (the remembered role is out of date): it goes as a suggestion instead, once.
                if (!checks || refusalCode(e) !== 'admins_only') throw e;
                setHeard('member');
                void forgetLearnRole(identity);
                published = false;
                await post(false);
            }
            setDone(published ? 'published' : 'sent');
        } catch (e) {
            if (refusalCode(e) === 'publish_instead') {
                setHeard('checks');
                void forgetLearnRole(identity);
            }
            // The node's own words only when it answered; a dropped connection's message is the phone's English.
            setProblem(learnRefusal(e));
        } finally {
            setBusy(false);
        }
    };

    if (done) {
        const published = done === 'published';
        return (
            <View style={[s.container, { paddingTop: insets.top }]} testID="learn-new-done-screen">
                {header}
                <View style={[s.content, { gap: 12 }]}>
                    <Text style={s.doneTitle} accessibilityRole="header">{published ? t(LEARN_WRITE.publishedTitle) : t(LEARN_WRITE.sentTitle)}</Text>
                    <Text style={s.doneLine}>{published ? t(LEARN_WRITE.publishedLine) : t(LEARN_WRITE.sentLine)}</Text>
                    {published ? (
                        <Pressable testID="learn-new-open-learn" accessibilityRole="button" style={s.primary}
                            onPress={() => (from === 'learn' && router.canGoBack() ? router.back() : router.replace('/learn'))}>
                            <Text style={s.primaryText}>{t(LEARN_WRITE.openLearn)}</Text>
                        </Pressable>
                    ) : (
                        <Pressable testID="learn-new-done" accessibilityRole="button" style={s.primary} onPress={leave}>
                            <Text style={s.primaryText}>{t(LEARN_WRITE.done)}</Text>
                        </Pressable>
                    )}
                </View>
            </View>
        );
    }

    const setLink = (i: number, patch: Partial<{ url: string; label: string }>) =>
        set({ sources: form.sources.map((x, at) => (at === i ? { ...x, ...patch } : x)) });
    const pickPhoto = () => {
        Keyboard.dismiss();
        askForPostPhoto((photo) => setForm((f) => (f.photos.length < KNOWLEDGE_LIMITS.photos ? { ...f, photos: [...f.photos, photo] } : f)));
    };

    if (use !== 'new' && !opened) {
        // The page is being read, isn't in Learn any more (taken down meanwhile), or the node wasn't reached for an edit (which
        // never starts from the copy): nothing to fix or edit yet.
        const gone = use === 'fix' ? settled && !page : nodeRead === 'none';
        const unreached = use === 'edit' && nodeRead === 'unreached';
        return (
            <View style={[s.container, { paddingTop: insets.top }]} testID="learn-new-page-missing">
                {header}
                <View style={[s.content, { gap: 12 }]}>
                    {gone ? <Text style={s.doneLine}>{t(LEARN_LINES.notFound)}</Text> : unreached ? (
                        <>
                            <Text style={s.doneLine} testID="learn-new-unreached">{t(LEARN_KEEP.unreached)}</Text>
                            <Pressable testID="learn-new-again" accessibilityRole="button" style={s.secondary} onPress={() => setTries((n) => n + 1)}>
                                <Text style={s.secondaryText}>{t(LEARN_KEEP.again)}</Text>
                            </Pressable>
                        </>
                    ) : <ActivityIndicator />}
                </View>
            </View>
        );
    }
    const wordsOnly = use !== 'new';
    return (
        <View style={[s.container, { paddingTop: insets.top }]} testID="learn-new">
            {header}
            <KeyboardAwareScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" bottomOffset={24}>
                {use === 'new' ? <View style={s.box}><Text style={s.boxText}>{t(LEARN_WRITE.formBox)}</Text></View> : null}
                {use === 'fix' ? (
                    <>
                        <Text style={s.label}>{t(LEARN_KEEP.noteLabel)}</Text>
                        <TextInput testID="learn-new-note" style={s.input} value={note} onChangeText={(v) => { setNote(v); setProblem(null); }}
                            maxLength={KNOWLEDGE_LIMITS.changeNote} multiline scrollEnabled={false} placeholder={t(LEARN_KEEP.noteHint)}
                            placeholderTextColor={colors.text.muted} accessibilityLabel={t(LEARN_KEEP.noteLabel)} />
                    </>
                ) : null}

                <Text style={s.label}>{t(LEARN_WRITE.titleLabel)}</Text>
                {/* Grows to a second line rather than cutting one (its hint and an 80-letter title at 320 dp with 1.3x text); Enter
                    leaves the box, a title holds no line break. */}
                <TextInput testID="learn-new-title" style={s.input} value={form.title} onChangeText={(title) => set({ title })} maxLength={KNOWLEDGE_LIMITS.title}
                    multiline scrollEnabled={false} submitBehavior="blurAndSubmit" returnKeyType="next"
                    placeholder={t(LEARN_WRITE.titleHint)} placeholderTextColor={colors.text.muted} accessibilityLabel={t(LEARN_WRITE.titleLabel)} />

                <Text style={s.label}>{t(LEARN_WRITE.bodyLabel)}</Text>
                <TextInput testID="learn-new-body" style={[s.input, s.multiline]} value={form.body} onChangeText={(body) => set({ body })} multiline
                    maxLength={KNOWLEDGE_LIMITS.body} placeholder={t(LEARN_WRITE.bodyHint)} placeholderTextColor={colors.text.muted} accessibilityLabel={t(LEARN_WRITE.bodyLabel)} />
                <Text style={s.counter}>{t(LEARN_WRITE.counter, { n: formatCount(form.body.length), max: formatCount(KNOWLEDGE_LIMITS.body) })}</Text>

                <Text style={s.label}>{t(LEARN_WRITE.topicLabel)}</Text>
                <View style={s.chips}>
                    {KNOWLEDGE_TOPICS.map((topic) => {
                        const on = form.topic === topic.id;
                        return (
                            <Pressable key={topic.id} testID={`learn-new-topic-${topic.id}`} accessibilityRole="button" accessibilityState={{ selected: on }}
                                onPress={() => set({ topic: topic.id })} style={[s.chip, on && s.chipOn]}>
                                <Text style={[s.chipText, on && s.chipTextOn]}>{t(LEARN_LINES.emojiTopic, { emoji: topic.emoji, topic: t(topic.label) })}</Text>
                            </Pressable>
                        );
                    })}
                </View>

                <Text style={s.label}>{t(LEARN_WRITE.placeLabel)}</Text>
                <TextInput testID="learn-new-place" style={s.input} value={form.place} onChangeText={(place) => set({ place })} maxLength={KNOWLEDGE_LIMITS.place}
                    placeholder={t(LEARN_WRITE.placeHint)} placeholderTextColor={colors.text.muted} accessibilityLabel={t(LEARN_WRITE.placeLabel)} />

                <TagPicker freeOnly testID="learn-new-tags" onChange={NO_LIBRARY} freeTags={form.freeTags} onFreeTagsChange={(freeTags) => set({ freeTags })} hints={TAG_HINTS} />

                <Text style={s.label}>{t(LEARN_WRITE.sourcesLabel)}</Text>
                {form.sources.map((link, i) => (
                    <View key={i} style={s.link}>
                        <View style={s.linkTop}>
                            <TextInput testID={`learn-new-link-url-${i}`} style={[s.input, { flex: 1, minWidth: 0 }]} value={link.url} onChangeText={(url) => setLink(i, { url })}
                                maxLength={KNOWLEDGE_LIMITS.sourceUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" accessibilityLabel={t(LEARN_WRITE.sourcesLabel)} />
                            <Pressable testID={`learn-new-link-remove-${i}`} accessibilityRole="button" accessibilityLabel={t(LEARN_WRITE.removeLink)} style={s.remove}
                                onPress={() => set({ sources: form.sources.filter((_, at) => at !== i) })}>
                                <Text style={s.removeText}>✕</Text>
                            </Pressable>
                        </View>
                        <TextInput testID={`learn-new-link-label-${i}`} style={s.input} value={link.label} onChangeText={(label) => setLink(i, { label })}
                            maxLength={KNOWLEDGE_LIMITS.sourceLabel} placeholder={t(LEARN_WRITE.linkLabelHint)} placeholderTextColor={colors.text.muted} accessibilityLabel={t(LEARN_WRITE.linkLabelHint)} />
                    </View>
                ))}
                {form.sources.length < KNOWLEDGE_LIMITS.sources ? (
                    <Pressable testID="learn-new-add-link" accessibilityRole="button" style={s.secondary} onPress={() => set({ sources: [...form.sources, { url: LINK_START, label: '' }] })}>
                        <Text style={s.secondaryText}>{t(LEARN_WRITE.addLink)}</Text>
                    </Pressable>
                ) : null}

                {wordsOnly ? null : <>
                <Text style={s.label}>{t(LEARN_WRITE.photoLabel)}</Text>
                <View style={s.photos}>
                    {form.photos.map((photo, i) => (
                        <Pressable key={i} accessibilityRole="button" accessibilityLabel={t(LEARN_WRITE.removePhoto)} onPress={() => set({ photos: form.photos.filter((_, at) => at !== i) })}>
                            <Image source={{ uri: photo }} style={s.photo} contentFit="cover" accessibilityLabel={t(LEARN_WRITE.removePhoto)} />
                        </Pressable>
                    ))}
                    {form.photos.length < KNOWLEDGE_LIMITS.photos ? (
                        <Pressable testID="learn-new-add-photo" accessibilityRole="button" style={s.secondary} onPress={pickPhoto}>
                            <Text style={s.secondaryText}>{t(LEARN_WRITE.addPhoto)}</Text>
                        </Pressable>
                    ) : null}
                </View>
                <Text style={s.small}>{t(LEARN_WRITE.photoLine)}</Text>
                </>}

                {problem ? <Text style={s.problem} testID="learn-new-problem" accessibilityLiveRegion="polite">{problem}</Text> : null}
                <Pressable testID="learn-new-send" accessibilityRole="button" style={[s.primary, busy && { opacity: 0.6 }]} disabled={busy} onPress={send}>
                    {busy ? <ActivityIndicator color={colors.text.inverse} /> : (
                        <Text style={s.primaryText}>{use === 'edit' ? t(LEARN_KEEP.save) : checks && use === 'new' ? t(LEARN_WRITE.publish) : t(LEARN_WRITE.send)}</Text>
                    )}
                </Pressable>
                {use === 'edit' ? null : (
                    <Text style={s.small}>{use === 'fix' ? t(LEARN_KEEP.fixLine) : checks ? t(LEARN_WRITE.publishLine) : t(LEARN_WRITE.sendLine)}</Text>
                )}
            </KeyboardAwareScrollView>
        </View>
    );
}
