/**
 * Small parts the phone's forum screens share (slice F3; DESIGN-forums-fable.md §2, §5, §14), as the web's
 * components/forum/ForumBits.tsx: a post's words with their links, its photos read signed, the menu a ⋯ opens, the sheet a
 * public forum's first post waits on. Each draws with the forum's styles itself (components/forum/forum-style.ts).
 */
import React, { useEffect, useState } from 'react';
import { Image, Linking, Modal, Pressable, Text, View } from 'react-native';
import { FORUM_LIMITS, forumWordRuns, t } from '@beanpool/core';
import { Alert } from '../../utils/keyboard-alert';
import { forumPhotoUri } from '../../utils/forum';
import { TOLD_WORDS, TOPIC_WORDS } from './forum-words';
import { useForumStyles } from './forum-style';


/**
 * A post's words, its line breaks kept. A known writer's links open in the browser; a new writer's are plain text
 * (`linksOn` false), so nothing in them can be tapped before a moderator has seen them.
 */
export function ForumWords({ words, linksOn, testID }: { words: string; linksOn: boolean; testID?: string }) {
    const styles = useForumStyles();
    return (
        <Text style={styles.body} selectable testID={testID}>
            {forumWordRuns(words, linksOn).map((run, i) => (run.isUrl
                ? <Text key={i} style={styles.link} accessibilityRole="link" onPress={() => void Linking.openURL(/^https?:\/\//i.test(run.text) ? run.text : `https://${run.text}`).catch(() => {})}>{run.text}</Text>
                : <Text key={i}>{run.text}</Text>))}
        </Text>
    );
}

function ForumPhoto({ id, n, waiting }: { id: string; n: number; waiting?: boolean }) {
    const styles = useForumStyles();
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
export function ForumPhotos({ id, count, waiting }: { id: string; count: number; waiting?: boolean }) {
    if (count <= 0) return null;
    return (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }} testID="forum-photos">
            {Array.from({ length: Math.min(count, FORUM_LIMITS.photos) }, (_, n) => <ForumPhoto key={n} id={id} n={n} waiting={waiting} />)}
        </View>
    );
}

/** [label, action, danger]; no action: a sentence at the top of the menu (a confirm's question). */
export type ForumMenuItem = [string, (() => void) | null, boolean?];

/** What a ⋯ opens: a sheet of 48 dp rows from the bottom, closed by a tap outside it or by Cancel (its last row). */
export function ForumMenu({ label, items, onClose }: { label: string; items: ForumMenuItem[] | null; onClose: () => void }) {
    const styles = useForumStyles();
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
