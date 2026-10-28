import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, ErrorBoundary, useLocalSearchParams } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { Image } from 'expo-image';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { COMMUNITY_CARD_WORDS, PEEK_WORDS as W, eventPlaceTimeText, peekKindWord, t, tn, word } from '@beanpool/core';
import { useStyles } from './ThemeContext';
import { useIdentity } from './IdentityContext';
import { communityOrigin } from '../utils/community-origin';
import { communityCardRoute } from '../utils/community-card-link';
import { readPeekParams } from '../utils/peek-link';
import { fetchPeekCommunityName, fetchPeekPost, type PeekPost } from '../utils/peek';

export { ErrorBoundary };

/** The screen's own words: word() keys, t()'d where shown. The peek's are core's (PEEK_WORDS). */
const PEEK_SCREEN_WORDS = {
    title: word('SHARED WITH YOU'),
    noPost: word("This link doesn't name a post this app can open."),
    unreachable: word("Can't reach that community right now. Check your connection and try again."),
} as const;

/**
 * One post shared outside its community (front doors S6, scratch/fable-design/DESIGN-entry-points-fable.md §3.4), opened
 * on this phone by the link a member shared (`https://<community>/?post=<id>&peek=<ticket>`) or by the node's share page
 * (`beanpool://peek?node=…`): utils/peek-link.ts. The post is read from that community as a visitor reads it (unsigned:
 * the ticket lets it through; the node sends it through guestPost, so nobody is in it and its place is its area only),
 * under "A member of {community} shared this with you", with Ask to join, which opens the community's own card screen
 * (app/community-card.tsx: the request to join, I have an invite, or the first screen for a phone with no account).
 * A member of that community on this phone sees the post itself, as before. Nothing is signed or sent from here.
 */
export default function PeekScreen() {
    const params = useLocalSearchParams<{ node?: string; post?: string; peek?: string }>();
    const peek = readPeekParams(params);
    const { identity } = useIdentity();
    const insets = useSafeAreaInsets();
    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: theme === 'dark' ? colors.surface.card : colors.text.heading },
        backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
        backIcon: { color: colors.text.inverse },
        headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: 'bold', color: colors.brand.primary, letterSpacing: 0.5 },
        scroll: { padding: 16 },
        card: { backgroundColor: colors.surface.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, padding: 16 },
        kicker: { fontSize: 14, fontWeight: '700', color: colors.text.secondary, marginBottom: 10 },
        photo: { width: '100%', aspectRatio: 4 / 3, borderRadius: 12, marginBottom: 12, backgroundColor: colors.surface.subtle },
        chip: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999, backgroundColor: colors.surface.subtle, marginBottom: 8 },
        chipText: { fontSize: 14, fontWeight: '700', color: colors.brand.primary },
        title: { fontSize: 22, fontWeight: '800', color: colors.text.heading, marginBottom: 6 },
        when: { fontSize: 16, fontWeight: '700', color: colors.text.body, marginBottom: 6 },
        body: { fontSize: 15, color: colors.text.body, lineHeight: 22, marginTop: 4 },
        note: { fontSize: 14, color: colors.text.secondary, marginTop: 12, lineHeight: 20 },
        refusal: { fontSize: 15, color: colors.feedback.warning.fg, lineHeight: 21 },
        actions: { gap: 10, marginTop: 16 },
        primary: { minHeight: 48, paddingHorizontal: 18, borderRadius: 12, backgroundColor: colors.brand.fill, alignItems: 'center', justifyContent: 'center' },
        primaryText: { color: colors.text.inverse, fontSize: 16, fontWeight: '800', textAlign: 'center' },
        secondary: { minHeight: 48, paddingHorizontal: 18, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center' },
        secondaryText: { color: colors.text.body, fontSize: 16, fontWeight: '700', textAlign: 'center' },
    }));

    const [post, setPost] = useState<PeekPost | 'loading' | 'stopped' | 'unreachable'>('loading');
    const [community, setCommunity] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);

    // A member of that community on this phone sees the post itself, as a shared link always opened it.
    useEffect(() => {
        if (!peek || !identity) return;
        let alive = true;
        AsyncStorage.getItem('beanpool_anchor_url').then((anchor) => {
            if (alive && anchor && communityOrigin(anchor) === peek.origin) router.replace(`/post/${encodeURIComponent(peek.postId)}`);
        }).catch(() => {});
        return () => { alive = false; };
    }, [peek?.origin, peek?.postId, identity]);

    useEffect(() => {
        if (!peek) return;
        let alive = true;
        setPost('loading');
        fetchPeekPost(peek.origin, peek.postId, peek.ticket).then((p) => { if (alive) setPost(p); });
        fetchPeekCommunityName(peek.origin).then((n) => { if (alive) setCommunity(n); });
        return () => { alive = false; };
    }, [peek?.origin, peek?.postId, peek?.ticket, attempt]);

    const leave = () => (router.canGoBack() ? router.back() : router.replace('/'));
    const name = community ?? peek?.origin.replace(/^https:\/\//, '') ?? '';

    const askDoor = peek && (
        <View style={styles.actions}>
            <Pressable style={styles.primary} onPress={() => router.push(communityCardRoute(peek.origin))} accessibilityRole="button" testID="peek-ask">
                <Text style={styles.primaryText}>{t(COMMUNITY_CARD_WORDS.ask)}</Text>
            </Pressable>
        </View>
    );

    const content = () => {
        if (!peek) return <Text style={styles.refusal}>{t(PEEK_SCREEN_WORDS.noPost)}</Text>;
        if (post === 'loading') return <ActivityIndicator style={{ marginTop: 24 }} />;
        if (post === 'unreachable') {
            return (
                <View style={styles.card}>
                    <Text style={styles.refusal}>{t(PEEK_SCREEN_WORDS.unreachable)}</Text>
                    <View style={styles.actions}>
                        <Pressable style={styles.secondary} onPress={() => setAttempt(n => n + 1)} accessibilityRole="button" testID="peek-retry">
                            <Text style={styles.secondaryText}>{t('Try again')}</Text>
                        </Pressable>
                    </View>
                </View>
            );
        }
        if (post === 'stopped') {
            return (
                <View style={styles.card} testID="peek-stopped">
                    <Text style={styles.refusal}>{t(W.stopped)}</Text>
                    {askDoor}
                </View>
            );
        }
        const kind = peekKindWord(post.type);
        const price = (post.type === 'offer' || post.type === 'need') && typeof post.credits === 'number' && post.credits > 0
            ? tn(post.credits, W.beans.one, W.beans.other) : null;
        const chip = [kind ? t(kind) : null, price].filter(Boolean).join(' · ');
        const when = post.type === 'event' ? eventPlaceTimeText(post.eventStartLocal, post.eventTz, post.eventStartAt) : null;
        const photo = post.photos && post.photos.length > 0 ? `${peek.origin}${post.photos[0]}` : null;
        return (
            <View style={styles.card} testID="peek-post">
                <Text style={styles.kicker}>{t(W.sharedWithYou, { community: name })}</Text>
                {photo && <Image source={{ uri: photo }} style={styles.photo} contentFit="cover" accessibilityIgnoresInvertColors />}
                {chip ? <View style={styles.chip}><Text style={styles.chipText}>{chip}</Text></View> : null}
                <Text style={styles.title}>{post.title}</Text>
                {when && <Text style={styles.when}>{when}</Text>}
                {post.description ? <Text style={styles.body}>{post.description}</Text> : null}
                <Text style={styles.note}>{t(W.namesWhenJoin, { community: name })}</Text>
                {askDoor}
            </View>
        );
    };

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <StatusBar style="light" />
            <View style={styles.header}>
                <Pressable onPress={leave} style={styles.backButton} accessibilityRole="button" accessibilityLabel={t('Back')}>
                    <MaterialCommunityIcons name="arrow-left" size={24} style={styles.backIcon} />
                </Pressable>
                <Text style={styles.headerTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} accessibilityRole="header">{t(PEEK_SCREEN_WORDS.title)}</Text>
                <View style={styles.backButton} />
            </View>
            <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: 24 + insets.bottom }]}>
                {content()}
            </ScrollView>
        </SafeAreaView>
    );
}
