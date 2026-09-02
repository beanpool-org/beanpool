import { useState, useEffect } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, SafeAreaView, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useIdentity } from './IdentityContext';
import { useNodeStatus } from './NodeStatusContext';
import { normalizeNodeUrl, looksLikeNodeAddress } from '../utils/node-url';
import { getSavedNodes, type SavedNode } from '../utils/nodes';
import { wipeIdentity, getMnemonic, hasMnemonic } from '../utils/identity';
import { requestSync } from '../services/pillar-sync';
import { colors, palette } from '../constants/colors';

/**
 * Shown when the active node is reachable but definitively does NOT recognise this
 * identity as a member (usually a wrong/typo'd node address). We keep the identity —
 * the keys and 12-word phrase are valid — and just let the user point at the right
 * community, or log out and start over. Routed to from the root layout when
 * NodeStatus recognition === 'stranger'.
 */
export default function NodeMismatchScreen() {
    const router = useRouter();
    const { identity, setIdentity } = useIdentity();
    const { nodeUrl, recheck } = useNodeStatus();
    const [input, setInput] = useState(nodeUrl || '');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // nodeUrl can resolve after first render; prefill once it's known.
    useEffect(() => { if (nodeUrl && !input) setInput(nodeUrl); }, [nodeUrl]);

    // The communities this device already knows about. Landing here almost always means
    // the member is anchored to the wrong one of these, so offering the list is a far
    // better first move than asking them to retype an address — and it is the difference
    // between one tap and reaching for the destructive option.
    // Words are revealed in-place before the wipe is offered. The previous dialog
    // asserted that the 12-word phrase would restore the account, which is only true if
    // the member was ever shown it and wrote it down — so show it instead of claiming it.
    const [words, setWords] = useState<string[] | null>(null);
    const [showWipe, setShowWipe] = useState(false);

    const [otherNodes, setOtherNodes] = useState<SavedNode[]>([]);
    useEffect(() => {
        getSavedNodes()
            .then((nodes) => setOtherNodes(nodes.filter((n) => n.url !== nodeUrl)))
            .catch(() => {});
    }, [nodeUrl]);

    async function handleReconnect() {
        const url = normalizeNodeUrl(input);
        if (!url || !looksLikeNodeAddress(url)) {
            setError("That node address doesn't look right. Use something like node.yourcommunity.org");
            return;
        }
        await switchToNode(url);
    }

    async function switchToNode(url: string) {
        setError(null);
        try {
            // Each node has its own local DB — swap it the same way Settings does.
            const { closeDB, initDB } = await import('../utils/db');
            await closeDB();
            await AsyncStorage.setItem('beanpool_anchor_url', url);
            await initDB();

            const result = await recheck();
            if (result === 'member') {
                requestSync().catch(() => {});
                router.replace('/(tabs)');
            } else if (result === 'stranger') {
                setError("That community also doesn't recognise your account. Double-check the address with whoever invited you.");
            } else {
                setError("Couldn't reach that node. Check the address and your connection, then try again.");
            }
        } catch (e: any) {
            setError(e?.message || 'Could not switch to that node.');
        } finally {
            setLoading(false);
        }
    }

    async function handleStartWipe() {
        if (hasMnemonic(identity)) {
            const w = await getMnemonic(identity);
            setWords(w);
        } else {
            setWords(null);
        }
        setShowWipe(true);
    }

    function handleConfirmWipe() {
        const hasWords = hasMnemonic(identity);
        Alert.alert(
            'Delete this account from this phone?',
            hasWords
                ? "Only do this if you have written your 12 words down. They are the only way back in, " +
                  "apart from a sign-in account linked on a community that holds a recovery piece for you.\n\n" +
                  "This erases the key for every community, not just this one."
                : "This account has no 12-word phrase stored on this device, so deleting it is PERMANENT " +
                  "unless a community holds a recovery piece for you.\n\nSwitching communities is almost " +
                  "certainly what you want instead.",
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: async () => {
                        await wipeIdentity();
                        setIdentity(null);
                    },
                },
            ]
        );
    }

    return (
        <SafeAreaView style={styles.container}>
            <StatusBar style="dark" />
            <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
                <ScrollView contentContainerStyle={styles.scroll}>
                    <View style={styles.card}>
                        <Text style={styles.emoji}>🧭</Text>
                        <Text style={styles.title}>This community doesn't recognise you</Text>
                        <Text style={styles.body}>
                            Your account is fine — but the community node you're connected to doesn't
                            have you as a member. This almost always means the node address is wrong.
                        </Text>

                        {nodeUrl ? (
                            <View style={styles.currentBox}>
                                <Text style={styles.currentLabel}>Currently connected to</Text>
                                <Text style={styles.currentUrl}>{nodeUrl}</Text>
                            </View>
                        ) : null}

                        {otherNodes.length > 0 ? (
                            <View style={styles.pickerWrap}>
                                <Text style={styles.inputLabel}>Switch to one of your communities</Text>
                                {otherNodes.map((n) => {
                                    let host = n.url;
                                    try { host = new URL(n.url).host; } catch {}
                                    return (
                                        <Pressable
                                            key={n.url}
                                            style={styles.nodeRow}
                                            onPress={() => switchToNode(n.url)}
                                            disabled={loading}
                                            accessibilityRole="button"
                                            accessibilityLabel={`Switch to ${n.alias || host}`}
                                        >
                                            <View style={{ flex: 1 }}>
                                                <Text style={styles.nodeRowName}>{n.alias || host}</Text>
                                                {n.alias ? <Text style={styles.nodeRowUrl}>{host}</Text> : null}
                                            </View>
                                            <Text style={styles.nodeRowChevron}>›</Text>
                                        </Pressable>
                                    );
                                })}
                                <Text style={styles.hint}>Or enter a different address below.</Text>
                            </View>
                        ) : null}

                        <Text style={styles.inputLabel}>Correct community node address</Text>
                        <TextInput
                            style={styles.input}
                            placeholder="e.g. node.yourcommunity.org"
                            placeholderTextColor={colors.text.muted}
                            value={input}
                            onChangeText={(t) => { setInput(t); setError(null); }}
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="url"
                            accessibilityLabel="Community node address"
                        />
                        <Text style={styles.hint}>Not sure? Ask whoever invited you for the exact address.</Text>

                        {error && <Text style={styles.error}>{error}</Text>}

                        <Pressable style={styles.primaryBtn} onPress={handleReconnect} disabled={loading} accessibilityRole="button">
                            {loading ? <ActivityIndicator color={colors.text.inverse} /> : <Text style={styles.primaryBtnText}>Reconnect</Text>}
                        </Pressable>

                        {!showWipe ? (
                            <Pressable style={styles.secondaryBtn} onPress={handleStartWipe} disabled={loading} accessibilityRole="button">
                                <Text style={styles.secondaryBtnText}>Delete this account from this phone</Text>
                            </Pressable>
                        ) : (
                            <View style={styles.wipeWrap}>
                                {words ? (
                                    <>
                                        <Text style={styles.wipeTitle}>Write these 12 words down first</Text>
                                        <Text style={styles.wipeBody}>
                                            They are the only way back into this account, apart from a linked
                                            sign-in on a community that holds a recovery piece for you.
                                        </Text>
                                        <View style={styles.wordsBox}>
                                            {words.map((w, i) => (
                                                <Text key={`${w}-${i}`} style={styles.word}>{i + 1}. {w}</Text>
                                            ))}
                                        </View>
                                    </>
                                ) : (
                                    <>
                                        <Text style={styles.wipeTitle}>No recovery phrase on this device</Text>
                                        <Text style={styles.wipeBody}>
                                            This account has no 12 words stored here, so deleting it is permanent
                                            unless a community holds a recovery piece for you. Switching
                                            communities above is almost certainly what you want instead.
                                        </Text>
                                    </>
                                )}
                                <Pressable style={styles.secondaryBtn} onPress={handleConfirmWipe} disabled={loading} accessibilityRole="button">
                                    <Text style={styles.secondaryBtnText}>I've saved them — delete the account</Text>
                                </Pressable>
                                <Pressable style={styles.secondaryBtn} onPress={() => { setShowWipe(false); setWords(null); }} accessibilityRole="button">
                                    <Text style={styles.cancelWipeText}>Cancel</Text>
                                </Pressable>
                            </View>
                        )}
                    </View>
                </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface.app },
    pickerWrap: { marginBottom: 18 },
    wipeWrap: { marginTop: 4 },
    wipeTitle: { color: colors.text.heading, fontSize: 15, fontWeight: '700', marginBottom: 6 },
    wipeBody: { color: colors.text.secondary, fontSize: 13, lineHeight: 19, marginBottom: 10 },
    wordsBox: {
        flexDirection: 'row', flexWrap: 'wrap', gap: 6,
        backgroundColor: colors.surface.app, borderRadius: 12, padding: 12,
        borderWidth: 1, borderColor: colors.border.default, marginBottom: 12,
    },
    word: { color: colors.text.heading, fontSize: 13, fontWeight: '600', width: '45%' },
    cancelWipeText: { color: colors.text.secondary, fontSize: 14, textAlign: 'center', fontWeight: '600' },
    nodeRow: {
        flexDirection: 'row', alignItems: 'center', gap: 10,
        paddingVertical: 14, paddingHorizontal: 14, marginBottom: 8,
        backgroundColor: colors.surface.app, borderRadius: 12,
        borderWidth: 1, borderColor: colors.border.default,
    },
    nodeRowName: { color: colors.text.heading, fontSize: 15, fontWeight: '700' },
    nodeRowUrl: { color: colors.text.secondary, fontSize: 12, marginTop: 2 },
    nodeRowChevron: { color: colors.text.muted, fontSize: 22, fontWeight: '300' },
    scroll: { flexGrow: 1, justifyContent: 'center', padding: 24 },
    card: { backgroundColor: colors.surface.card, padding: 24, borderRadius: 16, borderWidth: 1, borderColor: colors.border.default },
    emoji: { fontSize: 40, marginBottom: 8 },
    title: { fontSize: 22, fontWeight: 'bold', color: colors.text.heading, marginBottom: 10 },
    body: { fontSize: 15, color: palette.gray600, lineHeight: 22, marginBottom: 20 },
    currentBox: { backgroundColor: colors.surface.subtle, borderRadius: 12, padding: 12, marginBottom: 20 },
    currentLabel: { fontSize: 12, color: colors.text.secondary, marginBottom: 2 },
    currentUrl: { fontSize: 15, color: colors.text.heading, fontWeight: '600' },
    inputLabel: { fontSize: 14, color: palette.gray700, fontWeight: '600', marginBottom: 6 },
    input: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 12, padding: 14, color: colors.text.heading, fontSize: 16, marginBottom: 8 },
    hint: { fontSize: 13, color: colors.text.secondary, lineHeight: 18, marginBottom: 16 },
    error: { color: palette.red600, fontSize: 14, marginBottom: 16, lineHeight: 20 },
    primaryBtn: { backgroundColor: palette.blue600, borderRadius: 12, padding: 16, alignItems: 'center', marginBottom: 12 },
    primaryBtnText: { color: colors.text.inverse, fontSize: 16, fontWeight: '600' },
    secondaryBtn: { padding: 14, alignItems: 'center' },
    secondaryBtnText: { color: colors.text.secondary, fontSize: 15, fontWeight: '500' },
});
