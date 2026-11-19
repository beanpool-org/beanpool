/**
 * A DM's key code (DESIGN-dm-key-signal-model §3): the 20 digits of the key this chat is sealed to, how to compare them with
 * the person, and the member's "Mark as verified" / "Remove verification". Reached from the chat's ⋯ menu and from a
 * key-changed notice in the thread, pushed with the conversation id. A plain scrolling screen, not a Modal, so it holds at
 * 320 dp and 1.3× text.
 *
 * Only a verified person's key change stops a chat (Signal's model): marking someone verified makes this phone ask before it
 * sends to a new key for them. The mark is on this phone only, per community and chat. The screen reads the pins without
 * judging or writing anything; Mark and Remove go through the pins' one queue (utils/db.ts markDmPeerVerified,
 * removeDmPeerVerification), and Mark refuses when the key moved since the screen read it, which the screen then says.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams, ErrorBoundary } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { t } from '@beanpool/core';
import { Alert } from '../../utils/keyboard-alert';
import { useStyles, useTheme } from '../ThemeContext';
import { dmKeyChangeStyleSpec, dmKeyCodeCopy, dmKeyCodeShowsVerified, dmKeyCodeState } from '../../utils/dm-key-change';
import { keyCodeOf, keyCodeSpoken } from '../../utils/key-code';
import { enterChatInPlace, getDmKeyCodeInfo, leaveChatInPlace, markDmPeerVerified, removeDmPeerVerification, type DmKeyCodeInfo } from '../../utils/db';
import { DM_PINS_WORDS } from '../../utils/dm-peer-pins';

export { ErrorBoundary };

export default function DmKeyCodeScreen() {
    // `community`: a chat of another community this phone holds, open in place (slice S2): its pins are that community's.
    const { id, community } = useLocalSearchParams<{ id: string; community?: string }>();
    const at = community ? String(community) : undefined;
    const styles = useStyles(({ colors }) => StyleSheet.create(dmKeyChangeStyleSpec(colors)));
    const { colors } = useTheme();
    const [info, setInfo] = useState<DmKeyCodeInfo | null | undefined>(undefined);
    const [unread, setUnread] = useState(false);
    const [moved, setMoved] = useState(false);
    const [busy, setBusy] = useState(false);

    // In place (slice S2): this screen holds the chat's community while it shows, before its first read (an effect runs in
    // the order written). Opened over the chat, which lets go as it is covered: its copy stays open, or opens again once
    // the chat's close is done, and closes as the last of the two lets go (utils/db.ts enterChatInPlace, #3305 review).
    useEffect(() => {
        if (!at) return;
        enterChatInPlace(at);
        return () => { void leaveChatInPlace(at); };
    }, [at]);
    const load = useCallback(async () => {
        try {
            setInfo(await getDmKeyCodeInfo(String(id), at));
            setUnread(false);
        } catch {
            setUnread(true);
        }
    }, [id, at]);
    useEffect(() => { void load(); }, [load]);

    const copy = dmKeyCodeCopy(info?.name, !!info?.offersKey);
    const code = keyCodeOf(info?.peer);
    // One state under the code: a verified person's new key waiting at the top of the chat; another pause (no single key
    // listed: nothing to mark while it lasts, and one line says why sending waits); verified; or not. "Verified ✓" shows
    // while the person is marked verified and no new key waits, as it does beside "🔒 End-to-end encrypted" in the chat.
    const state = dmKeyCodeState(info, code);
    const showsVerified = dmKeyCodeShowsVerified(info, code);

    const mark = async () => {
        if (!info?.peer || busy) return;
        setBusy(true);
        try {
            // The key whose code this screen shows: a sync that moved it since writes nothing, and the screen shows the new one.
            const marked = await markDmPeerVerified(String(id), info.peer, at);
            setMoved(!marked);
        } catch {
            Alert.alert(copy.title, t(DM_PINS_WORDS.storeUnread));
        } finally {
            setBusy(false);
            await load();
        }
    };

    const remove = () => {
        Alert.alert(copy.removeConfirmTitle, copy.removeConfirmBody, [
            { text: copy.cancel, style: 'cancel' },
            {
                text: copy.remove, style: 'destructive', onPress: async () => {
                    setBusy(true);
                    try {
                        await removeDmPeerVerification(String(id), at);
                    } catch {
                        Alert.alert(copy.title, t(DM_PINS_WORDS.storeUnread));
                    } finally {
                        setBusy(false);
                        setMoved(false);
                        await load();
                    }
                },
            },
        ]);
    };

    return (
        <SafeAreaView style={styles.keyCodeContainer} edges={['top', 'bottom']}>
            <View style={styles.keyCodeHeader}>
                <Pressable style={styles.keyCodeBack} accessibilityRole="button" accessibilityLabel={t('Back')}
                    onPress={() => (router.canGoBack() ? router.back() : router.replace({ pathname: '/chat/[id]', params: { id: String(id) } }))}>
                    <MaterialCommunityIcons name="arrow-left" size={28} color={colors.text.body} />
                </Pressable>
                <Text style={styles.keyCodeTitle} accessibilityRole="header">{copy.title}</Text>
            </View>
            <ScrollView contentContainerStyle={styles.keyCodeScreen}>
                {unread ? (
                    <Text style={styles.keyCodeBody}>{t(DM_PINS_WORDS.storeUnread)}</Text>
                ) : info === undefined ? null : (
                    <>
                        <Text style={styles.keyCodeHeading} accessibilityRole="header">{copy.heading}</Text>
                        {code && (
                            <View style={styles.codeBox}>
                                <Text style={styles.code} accessibilityLabel={t('Key code: {code}', { code: keyCodeSpoken(code) })} selectable>{code}</Text>
                            </View>
                        )}
                        {code && <Text style={styles.keyCodeBody}>{copy.howTo}</Text>}
                        {moved && <Text style={styles.keyCodeBody} accessibilityRole="alert">{copy.moved}</Text>}
                        {state === 'none' && <Text style={styles.keyCodeBody}>{copy.none}</Text>}
                        {state === 'paused' && <Text style={styles.keyCodeBody}>{copy.paused}</Text>}
                        {state === 'not-verified' && (
                            <>
                                <Pressable style={styles.markBtn} onPress={mark} disabled={busy} accessibilityRole="button" accessibilityState={{ disabled: busy }} accessibilityLabel={copy.mark}>
                                    <Text style={styles.markText}>{copy.mark}</Text>
                                </Pressable>
                                <Text style={styles.keyCodeBody}>{copy.markNote}</Text>
                            </>
                        )}
                        {showsVerified && <Text style={styles.verifiedText}>{copy.verified}</Text>}
                        {state === 'verified' && <Text style={styles.keyCodeBody}>{copy.verifiedNote}</Text>}
                        {state === 'waiting' && <Text style={styles.keyCodeBody}>{copy.waiting}</Text>}
                        {info?.verified && state !== 'none' && (
                            <Pressable style={styles.removeBtn} onPress={remove} disabled={busy} accessibilityRole="button" accessibilityState={{ disabled: busy }} accessibilityLabel={copy.remove}>
                                <Text style={styles.removeText}>{copy.remove}</Text>
                            </Pressable>
                        )}
                    </>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}
