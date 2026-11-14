/**
 * Small parts the phone's forum screens share (slice F3; DESIGN-forums-fable.md §2, §5, §14), as the web's
 * components/forum/ForumBits.tsx: a post's words with their links, its photos read signed, the menu a ⋯ opens, the sheet a
 * public forum's first post waits on, and the forum's styles in each look (colours from the central tokens only).
 */
import React, { useEffect, useState } from 'react';
import { Image, Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { FORUM_LIMITS, forumWordRuns, t } from '@beanpool/core';
import { useStyles } from '../../app/ThemeContext';
import { Alert } from '../../utils/keyboard-alert';
import { forumPhotoUri } from '../../utils/forum';
import { TOLD_WORDS, TOPIC_WORDS } from './forum-words';

/** The forum's styles, from the look's tokens: 48 dp targets, nothing fixed-width, words that wrap at 320 dp and 1.3x text. */
export function useForumStyles() {
    return useStyles(({ colors }) => StyleSheet.create({
        page: { flex: 1, backgroundColor: colors.surface.page },
        pad: { paddingHorizontal: 12, paddingBottom: 24, gap: 10 },
        head: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 4, minHeight: 48, borderBottomWidth: 1, borderBottomColor: colors.border.default },
        iconBtn: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
        headWords: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: '600', color: colors.text.secondary },
        heading: { fontSize: 18, fontWeight: '800', color: colors.text.heading, flexShrink: 1 },
        title: { fontSize: 18, fontWeight: '800', lineHeight: 24, color: colors.text.heading },
        body: { fontSize: 15, lineHeight: 21, color: colors.text.body },
        small: { fontSize: 13, lineHeight: 18, color: colors.text.secondary },
        muted: { fontSize: 13, lineHeight: 18, color: colors.text.muted },
        italic: { fontSize: 14, lineHeight: 20, fontStyle: 'italic', color: colors.text.muted },
        link: { color: colors.text.link, textDecorationLine: 'underline' },
        danger: { fontSize: 14, lineHeight: 20, color: colors.feedback.danger.fg },
        row: { borderTopWidth: 1, borderTopColor: colors.border.default, paddingVertical: 10, minHeight: 56, flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
        rowWords: { flex: 1, minWidth: 0, gap: 2 },
        rowTitle: { fontSize: 15, fontWeight: '700', lineHeight: 21, color: colors.text.heading },
        dot: { width: 12, height: 12, borderRadius: 6, marginTop: 6, backgroundColor: colors.accent.fill },
        commit: { minHeight: 48, borderRadius: 10, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.brand.fill },
        commitText: { fontSize: 15, fontWeight: '800', color: colors.text.onBrand, textAlign: 'center' },
        quiet: { minHeight: 48, borderRadius: 10, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface.subtle, borderWidth: 1, borderColor: colors.border.strong },
        quietText: { fontSize: 15, fontWeight: '700', color: colors.text.body, textAlign: 'center' },
        warnRow: { minHeight: 48, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, justifyContent: 'center', backgroundColor: colors.feedback.warning.bg, borderWidth: 1, borderColor: colors.feedback.warning.border },
        warnText: { fontSize: 15, fontWeight: '800', color: colors.feedback.warning.fg },
        infoBox: { borderRadius: 10, padding: 12, gap: 8, backgroundColor: colors.feedback.info.bg, borderWidth: 1, borderColor: colors.feedback.info.border },
        infoText: { fontSize: 14, lineHeight: 20, color: colors.text.body },
        chip: { minHeight: 40, borderRadius: 20, paddingHorizontal: 14, justifyContent: 'center', borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card },
        chipOn: { backgroundColor: colors.accent.fill, borderColor: colors.accent.fill },
        chipText: { fontSize: 14, fontWeight: '600', color: colors.text.body },
        chipTextOn: { fontSize: 14, fontWeight: '700', color: colors.text.onAccent },
        card: { borderRadius: 12, padding: 12, gap: 8, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default },
        field: { minHeight: 48, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: colors.text.body, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong },
        label: { fontSize: 14, fontWeight: '700', color: colors.text.secondary },
        mine: { backgroundColor: colors.surface.subtle },
        quote: { borderLeftWidth: 3, borderLeftColor: colors.accent.fill, paddingLeft: 8 },
        photo: { width: 96, height: 96, borderRadius: 10, overflow: 'hidden', backgroundColor: colors.surface.subtle, borderWidth: 1, borderColor: colors.border.default },
        backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: colors.overlay.scrim, padding: 12 },
        sheet: { borderRadius: 16, padding: 8, backgroundColor: colors.surface.card },
        menuItem: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, justifyContent: 'center', borderRadius: 10 },
        menuText: { fontSize: 16, fontWeight: '600', color: colors.text.body },
        menuDanger: { fontSize: 16, fontWeight: '600', color: colors.feedback.danger.fg },
        placeholder: { color: colors.text.muted },
    }));
}
export type ForumStyles = ReturnType<typeof useForumStyles>;

/**
 * A post's words, its line breaks kept. A known writer's links open in the browser; a new writer's are plain text
 * (`linksOn` false), so nothing in them can be tapped before a moderator has seen them.
 */
export function ForumWords({ words, linksOn, styles, testID }: { words: string; linksOn: boolean; styles: ForumStyles; testID?: string }) {
    return (
        <Text style={styles.body} selectable testID={testID}>
            {forumWordRuns(words, linksOn).map((run, i) => (run.isUrl
                ? <Text key={i} style={styles.link} accessibilityRole="link" onPress={() => void Linking.openURL(/^https?:\/\//i.test(run.text) ? run.text : `https://${run.text}`).catch(() => {})}>{run.text}</Text>
                : <Text key={i}>{run.text}</Text>))}
        </Text>
    );
}

function ForumPhoto({ id, n, waiting, styles }: { id: string; n: number; waiting?: boolean; styles: ForumStyles }) {
    const [uri, setUri] = useState<string | null>(null);
    useEffect(() => {
        let live = true;
        void forumPhotoUri(id, n, waiting).then((u) => { if (live) setUri(u); });
        return () => { live = false; };
    }, [id, n, waiting]);
    return (
        <View style={styles.photo} accessibilityLabel={t(TOPIC_WORDS.photo, { n: n + 1 })}>
            {uri ? <Image source={{ uri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" /> : null}
        </View>
    );
}

/** A post's photos (or a waiting topic's), up to 3, each read signed when it is drawn. */
export function ForumPhotos({ id, count, waiting, styles }: { id: string; count: number; waiting?: boolean; styles: ForumStyles }) {
    if (count <= 0) return null;
    return (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }} testID="forum-photos">
            {Array.from({ length: Math.min(count, FORUM_LIMITS.photos) }, (_, n) => <ForumPhoto key={n} id={id} n={n} waiting={waiting} styles={styles} />)}
        </View>
    );
}

/** [label, action, danger]; no action: a sentence at the top of the menu (a confirm's question). */
export type ForumMenuItem = [string, (() => void) | null, boolean?];

/** What a ⋯ opens: a sheet of 48 dp rows from the bottom, closed by a tap outside it or by Cancel (its last row). */
export function ForumMenu({ label, items, onClose, styles }: { label: string; items: ForumMenuItem[] | null; onClose: () => void; styles: ForumStyles }) {
    return (
        <Modal visible={!!items} transparent animationType="fade" onRequestClose={onClose}>
            <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={label}>
                <Pressable style={styles.sheet} onPress={() => {}} testID="forum-menu">
                    {(items ?? []).map(([words, fn, danger]) => (fn
                        ? (
                            <Pressable key={words} onPress={fn} accessibilityRole="button" style={styles.menuItem}>
                                <Text style={danger ? styles.menuDanger : styles.menuText}>{words}</Text>
                            </Pressable>
                        )
                        : <Text key={words} style={[styles.small, { paddingHorizontal: 16, paddingVertical: 12 }]}>{words}</Text>))}
                </Pressable>
            </Pressable>
        </Modal>
    );
}

/**
 * Before a member's first post on a public forum (the global community's), once per account (design §5): the node keeps the
 * time they agreed and refuses a first post without it, so no app can skip the telling. Post: true; Not now: false (what they
 * wrote stays).
 */
export function askForumTold(): Promise<boolean> {
    return new Promise((resolve) => {
        Alert.alert(t(TOLD_WORDS.title), t(TOLD_WORDS.body), [
            { text: t(TOLD_WORDS.notNow), style: 'cancel', onPress: () => resolve(false) },
            { text: t(TOLD_WORDS.post), onPress: () => resolve(true) },
        ], { cancelable: true, onDismiss: () => resolve(false) });
    });
}
