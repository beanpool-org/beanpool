/**
 * Learn's form (slice K4; DESIGN-local-knowledge-fable.md §3.3 as amended): one screen for "＋ Suggest knowledge" in Learn and the
 * + chooser's 📖 Local knowledge row, pushed over the tabs with its own Back row, like the calendar. A member's page goes to the
 * waiting list (POST /api/knowledge/drafts) and shows to nobody until an owner or admin approves it; an owner's or admin's own
 * page publishes at once (POST /api/knowledge/posts). The node words every refusal in the member's language, and it is shown as
 * it comes; the form checks first what it can (a title, what to know, a topic, a link's start).
 *
 * `?from=learn`: opened from Learn, so "Open Learn" after publishing goes back to it rather than opening a second.
 */
import React, { useState } from 'react';
import { ActivityIndicator, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KNOWLEDGE_LIMITS, KNOWLEDGE_NAMES, KNOWLEDGE_TOPICS, currentLanguage, formatCount, t } from '@beanpool/core';
import { useStyles, useTheme } from '../ThemeContext';
import { LEARN_LINES } from '../../components/learn/learn-lines';
import {
    EMPTY_KNOWLEDGE_FORM, LEARN_WRITE, LINK_START, knowledgeFormBody, knowledgeFormPath, knowledgeFormProblem, type KnowledgeFormValues,
} from '../../components/learn/learn-write';
import { useLearnWriter } from '../../components/learn/useLearnWriter';
import { useLearnMode } from '../../utils/use-learn-mode';
import { askForPostPhoto } from '../../utils/post-photo';
import { signedRequestWithMethod } from '../../utils/db';

export default function NewKnowledgeScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { colors } = useTheme();
    const { from } = useLocalSearchParams<{ from?: string }>();
    const live = useLearnMode() === 'live';
    const writer = useLearnWriter(live);
    // The node knows best: a member it says is an owner or admin publishes instead (`publish_instead`).
    const [publishes, setPublishes] = useState(false);
    const checks = writer.checks || publishes;
    const [form, setForm] = useState<KnowledgeFormValues>(EMPTY_KNOWLEDGE_FORM);
    const [problem, setProblem] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState<'sent' | 'published' | null>(null);
    const set = (patch: Partial<KnowledgeFormValues>) => { setForm((f) => ({ ...f, ...patch })); setProblem(null); };

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
            <Text style={s.title} accessibilityRole="header" numberOfLines={1}>{t(KNOWLEDGE_NAMES.kind)}</Text>
        </View>
    );

    const send = async () => {
        Keyboard.dismiss();
        const wrong = knowledgeFormProblem(form);
        if (wrong) { setProblem(wrong); return; }
        setBusy(true);
        try {
            await signedRequestWithMethod('POST', knowledgeFormPath(checks), knowledgeFormBody(form, currentLanguage()), { withStatus: true });
            setDone(checks ? 'published' : 'sent');
        } catch (e) {
            const err = (e ?? {}) as { code?: unknown; message?: unknown; unsaid?: unknown };
            if (err.code === 'publish_instead') setPublishes(true);
            setProblem(err.unsaid || typeof err.message !== 'string' || !err.message ? t(LEARN_WRITE.couldNotSend) : err.message);
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

    return (
        <View style={[s.container, { paddingTop: insets.top }]} testID="learn-new">
            {header}
            <KeyboardAwareScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" bottomOffset={24}>
                <View style={s.box}><Text style={s.boxText}>{t(LEARN_WRITE.formBox)}</Text></View>

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

                {problem ? <Text style={s.problem} testID="learn-new-problem" accessibilityLiveRegion="polite">{problem}</Text> : null}
                <Pressable testID="learn-new-send" accessibilityRole="button" style={[s.primary, busy && { opacity: 0.6 }]} disabled={busy} onPress={send}>
                    {busy ? <ActivityIndicator color={colors.text.inverse} /> : <Text style={s.primaryText}>{checks ? t(LEARN_WRITE.publish) : t(LEARN_WRITE.send)}</Text>}
                </Pressable>
                <Text style={s.small}>{checks ? t(LEARN_WRITE.publishLine) : t(LEARN_WRITE.sendLine)}</Text>
            </KeyboardAwareScrollView>
        </View>
    );
}
