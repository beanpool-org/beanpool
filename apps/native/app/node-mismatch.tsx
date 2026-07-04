import { useState, useEffect } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, SafeAreaView, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useIdentity } from './IdentityContext';
import { useNodeStatus } from './NodeStatusContext';
import { normalizeNodeUrl, looksLikeNodeAddress } from '../utils/node-url';
import { wipeIdentity } from '../utils/identity';
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
    const { setIdentity } = useIdentity();
    const { nodeUrl, recheck } = useNodeStatus();
    const [input, setInput] = useState(nodeUrl || '');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // nodeUrl can resolve after first render; prefill once it's known.
    useEffect(() => { if (nodeUrl && !input) setInput(nodeUrl); }, [nodeUrl]);

    async function handleReconnect() {
        const url = normalizeNodeUrl(input);
        if (!url || !looksLikeNodeAddress(url)) {
            setError("That node address doesn't look right. Use something like node.yourcommunity.org");
            return;
        }
        setLoading(true);
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

    function handleLogout() {
        Alert.alert(
            'Log out & start over?',
            "Your 12-word recovery phrase still restores this account later. You'll return to the welcome screen to set things up again.",
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Log out',
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

                        <Pressable style={styles.secondaryBtn} onPress={handleLogout} disabled={loading} accessibilityRole="button">
                            <Text style={styles.secondaryBtnText}>Log out & start over</Text>
                        </Pressable>
                    </View>
                </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface.app },
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
