/**
 * A new topic on the phone (slice F3; DESIGN-forums-fable.md §2, §5, §14 "New topic"), as the web's
 * components/forum/ForumNewTopic.tsx: the section (only those the member may start in: "News from BeanPool" is the owners' and
 * admins'), a title, the words and a place in words (optional, never a map point). A new member reads under the button that a
 * moderator looks first, with the measured wait. On a public forum the sheet that anyone on the web can read it comes first,
 * once. Photos, up to 3, where the forum takes this member's (`linksOn`, or a new member's first topic, which a moderator sees
 * first): each fitted within 800 px on the phone (components/forum/ForumBits.tsx pickForumPhoto), the web's 📎 row.
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
import { Alert } from '../../utils/keyboard-alert';
import { ForumAttached, askForumTold, pickForumPhoto } from '../../components/forum/ForumBits';
import { useForumStyles } from '../../components/forum/forum-style';
import { FORUM_WORDS, NEW_TOPIC_WORDS, TOPIC_WORDS } from '../../components/forum/forum-words';

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
    const [photos, setPhotos] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const hours = Number(params.hours) || 0;

    useEffect(() => {
        void loadIdentity().then((i) => setMe(i?.publicKey ?? null));
        void keptForumFront().then((f) => { if (f) setFront((now) => now ?? f); });
        // A read, not a save: with no answer from the node, the forum's own line for a load (its refusal says its own words).
        void getForumFront().then(setFront).catch((e) => setError((e as Error)?.message || t(FORUM_WORDS.failed)));
    }, []);
    const open = (front?.sections ?? []).filter((s) => !s.archived && (s.starts === 'members' || staff));
    // The section the list showed, if the member may start there; else the first they may.
    useEffect(() => {
        if (open.some((s) => s.id === section)) return;
        setSection(open.some((s) => s.id === params.section) ? String(params.section) : open[0]?.id ?? '');
    }, [open.map((s) => s.id).join(','), params.section]);
    const photosOk = !!front && (front.linksOn || front.firstTopicWaits);
    const full = photos.length >= FORUM_LIMITS.photos;
    async function attach() {
        if (full) { Alert.alert(t('At most {n} photos.', { n: FORUM_LIMITS.photos })); return; }
        const photo = await pickForumPhoto();
        if (photo) setPhotos((now) => (now.length < FORUM_LIMITS.photos ? [...now, photo] : now));
    }
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
            const out = await startForumTopic({ sectionId: section, title: title.trim(), words: words.trim(), place: place.trim() || undefined, lang: currentLanguage(), photos: photosOk ? photos : [] });
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
                    {photosOk && (
                        <View style={{ marginHorizontal: -12 }}>
                            <ForumAttached photos={photos} onChange={setPhotos} disabled={busy} />
                            <Pressable accessibilityRole="button" testID="forum-attach" accessibilityLabel={full ? t('At most {n} photos.', { n: FORUM_LIMITS.photos }) : t('Add a photo')}
                                disabled={busy} onPress={() => void attach()} style={[styles.quiet, { alignSelf: 'flex-start', marginHorizontal: 12, marginTop: 8, flexDirection: 'row', gap: 8 }, full && { opacity: 0.5 }]}>
                                <MaterialCommunityIcons name="camera-plus-outline" size={20} color={colors.text.body} />
                                <Text style={styles.quietText}>{t('Add a photo')}</Text>
                            </Pressable>
                        </View>
                    )}
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
