/**
 * A new topic on the phone (slice F3; DESIGN-forums-fable.md §2, §5, §14 "New topic"), as the web's
 * components/forum/ForumNewTopic.tsx: the section (only those the member may start in: "News from BeanPool" is the owners' and
 * admins'), a title, the words and a place in words (optional, never a map point). A new member reads under the button that a
 * moderator looks first, with the measured wait. On a public forum the sheet that anyone on the web can read it comes first,
 * once. Photos on a topic come with the phone's photo slice (named in the PR); the web takes them today.
 */
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { FORUM_LIMITS, currentLanguage, forumSectionName, t, tn } from '@beanpool/core';
import { useTheme } from '../ThemeContext';
import { loadIdentity } from '../../utils/identity';
import { usePinRole } from '../../utils/use-pin-role';
import { getForumFront, keptForumFront, markForumTold, noteForumBack, startForumTopic, type ForumFront } from '../../utils/forum';
import { askForumTold, useForumStyles } from '../../components/forum/ForumBits';
import { NEW_TOPIC_WORDS, TOPIC_WORDS } from '../../components/forum/forum-words';

export default function NewForumTopicScreen() {
    const params = useLocalSearchParams<{ section?: string; hours?: string }>();
    const styles = useForumStyles();
    const { colors } = useTheme();
    const [me, setMe] = useState<string | null>(null);
    const role = usePinRole(true, me);
    const staff = role === 'owner' || role === 'admin';
    const [front, setFront] = useState<ForumFront | null>(null);
    const [section, setSection] = useState('');
    const [title, setTitle] = useState('');
    const [words, setWords] = useState('');
    const [place, setPlace] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const hours = Number(params.hours) || 0;

    useEffect(() => {
        void loadIdentity().then((i) => setMe(i?.publicKey ?? null));
        void keptForumFront().then((f) => { if (f) setFront((now) => now ?? f); });
        void getForumFront().then(setFront).catch((e) => setError((e as Error)?.message || t(TOPIC_WORDS.saveFailed)));
    }, []);
    const open = (front?.sections ?? []).filter((s) => !s.archived && (s.starts === 'members' || staff));
    // The section the list showed, if the member may start there; else the first they may.
    useEffect(() => {
        if (open.some((s) => s.id === section)) return;
        setSection(open.some((s) => s.id === params.section) ? String(params.section) : open[0]?.id ?? '');
    }, [open.map((s) => s.id).join(','), params.section]);
    const length = Array.from(words.trim()).length;
    const ready = !!front && !!section && title.trim().length > 0 && length > 0 && length <= FORUM_LIMITS.opening;

    /** `told`: they just agreed to the sheet (the front they were handed still says not). */
    async function post(told = false) {
        if (!ready || busy || !front) return;
        if (front.public && !front.told && !told) {
            if (!(await askForumTold())) return;
            try {
                await markForumTold();
            } catch (e) {
                setError((e as Error)?.message || t(TOPIC_WORDS.saveFailed));
                return;
            }
            setFront({ ...front, told: true });
            return post(true);
        }
        setBusy(true);
        setError(null);
        try {
            const out = await startForumTopic({ sectionId: section, title: title.trim(), words: words.trim(), place: place.trim() || undefined, lang: currentLanguage() });
            if ('waiting' in out) { noteForumBack({ kind: 'sent' }); router.back(); }
            else router.replace({ pathname: '/forum/[id]', params: { id: out.topic.id } });
        } catch (e) {
            setError((e as Error)?.message || t(TOPIC_WORDS.saveFailed));
            setBusy(false);
        }
    }

    return (
        <SafeAreaView style={styles.page} testID="forum-new-topic">
            <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
                <View style={styles.head}>
                    <Pressable accessibilityRole="button" accessibilityLabel={t(NEW_TOPIC_WORDS.cancel)} onPress={() => router.back()} style={styles.iconBtn}>
                        <MaterialCommunityIcons name="chevron-left" size={28} color={colors.text.body} />
                    </Pressable>
                    <Text style={styles.heading} accessibilityRole="header">{t(NEW_TOPIC_WORDS.heading)}</Text>
                </View>
                <ScrollView contentContainerStyle={[styles.pad, { paddingTop: 12 }]} keyboardShouldPersistTaps="handled">
                    <Text style={styles.label}>{t(NEW_TOPIC_WORDS.section)}</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} testID="forum-new-section">
                        {open.map((s) => (
                            <Pressable key={s.id} onPress={() => setSection(s.id)} accessibilityRole="radio" accessibilityState={{ selected: section === s.id }} style={[styles.chip, section === s.id && styles.chipOn]}>
                                <Text style={section === s.id ? styles.chipTextOn : styles.chipText}>{forumSectionName(s)}</Text>
                            </Pressable>
                        ))}
                    </View>
                    <Text style={styles.label}>{t(NEW_TOPIC_WORDS.title)}</Text>
                    <TextInput value={title} onChangeText={setTitle} maxLength={FORUM_LIMITS.title} style={styles.field} accessibilityLabel={t(NEW_TOPIC_WORDS.title)} testID="forum-new-title" />
                    <Text style={styles.label}>{t(NEW_TOPIC_WORDS.words)}</Text>
                    <TextInput value={words} onChangeText={setWords} multiline style={[styles.field, { minHeight: 140, textAlignVertical: 'top' }]} accessibilityLabel={t(NEW_TOPIC_WORDS.words)} testID="forum-new-words" />
                    <Text style={[styles.muted, { alignSelf: 'flex-end' }]}>{t(NEW_TOPIC_WORDS.count, { n: length, max: FORUM_LIMITS.opening })}</Text>
                    <Text style={styles.label}>{t(NEW_TOPIC_WORDS.place)}</Text>
                    <TextInput value={place} onChangeText={setPlace} maxLength={FORUM_LIMITS.place} style={styles.field} accessibilityLabel={t(NEW_TOPIC_WORDS.place)} />
                    <Text style={styles.muted}>{t(NEW_TOPIC_WORDS.placeHint)}</Text>
                    {error && <Text style={styles.danger} accessibilityRole="alert">{error}</Text>}
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
                        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.quiet}><Text style={styles.quietText}>{t(NEW_TOPIC_WORDS.cancel)}</Text></Pressable>
                        <Pressable accessibilityRole="button" testID="forum-new-post" disabled={!ready || busy} onPress={() => void post()} style={[styles.commit, (!ready || busy) && { opacity: 0.5 }]}>
                            <Text style={styles.commitText}>{t(NEW_TOPIC_WORDS.post)}</Text>
                        </Pressable>
                    </View>
                    {front?.firstTopicWaits && (
                        <Text style={styles.small} testID="forum-first-look-note">
                            {hours ? tn(hours, NEW_TOPIC_WORDS.firstLookHours.one, NEW_TOPIC_WORDS.firstLookHours.other, { n: hours }) : t(NEW_TOPIC_WORDS.firstLook)}
                        </Text>
                    )}
                </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}
