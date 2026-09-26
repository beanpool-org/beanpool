import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { router, ErrorBoundary } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { useTheme, useStyles } from './ThemeContext';
import { useIdentity } from './IdentityContext';
import { START_COMMUNITY_COPY, RUN_A_NODE_URL, communityDetailsText, canCopyDetails } from '../utils/start-community';

export { ErrorBoundary };

/**
 * Start a community (design §3.4). What a community's node is, the ways to run one, and the member's details copied
 * for the new node's settings app. Nothing here claims a name or makes a node: that happens on the new node itself,
 * whose key owns its address.
 */
export default function StartCommunityScreen() {
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();
    const { identity } = useIdentity();
    const [name, setName] = useState('');
    const [place, setPlace] = useState('');
    const [contact, setContact] = useState('');
    const [copied, setCopied] = useState(false);

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: theme === 'dark' ? colors.surface.card : colors.text.heading },
        backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
        headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: 'bold', color: colors.brand.primary, letterSpacing: 0.5, textTransform: 'uppercase' },
        scroll: { padding: 16 },
        intro: { fontSize: 15, color: colors.text.body, lineHeight: 22 },
        sectionLabel: { fontSize: 12, fontWeight: 'bold', color: colors.text.secondary, letterSpacing: 1, marginTop: 20, marginBottom: 8, marginLeft: 4 },
        card: { backgroundColor: colors.surface.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, padding: 14, marginBottom: 10, flexDirection: 'row', gap: 12 },
        icon: { fontSize: 24 },
        cardText: { flex: 1, minWidth: 0 },
        cardTitle: { fontSize: 16, fontWeight: '800', color: colors.text.heading },
        cardBody: { fontSize: 14, color: colors.text.body, lineHeight: 20, marginTop: 2 },
        label: { fontSize: 13, fontWeight: '700', color: colors.text.secondary, marginTop: 10, marginBottom: 4 },
        input: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, color: colors.text.heading, fontSize: 16, paddingHorizontal: 12, paddingVertical: 10 },
        primary: { minHeight: 48, paddingHorizontal: 18, borderRadius: 12, backgroundColor: colors.brand.primary, alignItems: 'center', justifyContent: 'center', marginTop: 14 },
        primaryText: { color: colors.text.inverse, fontSize: 15, fontWeight: '800', textAlign: 'center' },
        link: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, marginTop: 8 },
        linkText: { fontSize: 15, fontWeight: '700', color: colors.brand.primary, flexShrink: 1, textDecorationLine: 'underline' },
        note: { fontSize: 14, color: colors.text.body, marginTop: 8, lineHeight: 20 },
    }));

    const details = { name, place, contact, organiser: identity?.callsign ?? null };
    const copy = async () => {
        await Clipboard.setStringAsync(communityDetailsText(details));
        setCopied(true);
    };
    const openWebsite = () => { WebBrowser.openBrowserAsync(RUN_A_NODE_URL).catch(() => {}); };

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <StatusBar style="light" />
            <View style={styles.header}>
                <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Back">
                    <MaterialCommunityIcons name="arrow-left" size={26} color={colors.text.inverse} />
                </Pressable>
                <Text style={styles.headerTitle} numberOfLines={1} accessibilityRole="header">{START_COMMUNITY_COPY.title}</Text>
                <View style={{ width: 48 }} />
            </View>
            <KeyboardAwareScrollView
                contentContainerStyle={[styles.scroll, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}
                keyboardShouldPersistTaps="handled"
                bottomOffset={16}
            >
                <Text style={styles.intro}>{START_COMMUNITY_COPY.intro}</Text>

                <Text style={styles.sectionLabel}>THREE WAYS TO RUN ONE</Text>
                {START_COMMUNITY_COPY.ways.map(w => (
                    <View key={w.title} style={styles.card}>
                        <Text style={styles.icon} importantForAccessibility="no">{w.icon}</Text>
                        <View style={styles.cardText}>
                            <Text style={styles.cardTitle}>{w.title}</Text>
                            <Text style={styles.cardBody}>{w.body}</Text>
                        </View>
                    </View>
                ))}
                <Pressable style={styles.link} onPress={openWebsite} accessibilityRole="link">
                    <MaterialCommunityIcons name="open-in-new" size={20} color={colors.brand.primary} />
                    <Text style={styles.linkText}>{START_COMMUNITY_COPY.website}</Text>
                </Pressable>

                <Text style={styles.sectionLabel}>YOUR COMMUNITY'S DETAILS</Text>
                <Text style={styles.label}>What will it be called?</Text>
                <TextInput style={styles.input} value={name} onChangeText={v => { setName(v); setCopied(false); }} maxLength={80} accessibilityLabel="Community name" />
                <Text style={styles.label}>Where is it? (a town or area)</Text>
                <TextInput style={styles.input} value={place} onChangeText={v => { setPlace(v); setCopied(false); }} maxLength={80} accessibilityLabel="Place" />
                <Text style={styles.label}>How can people reach you? (optional)</Text>
                <TextInput style={styles.input} value={contact} onChangeText={v => { setContact(v); setCopied(false); }} maxLength={120} autoCapitalize="none" accessibilityLabel="Contact" />
                <Pressable
                    style={[styles.primary, !canCopyDetails(details) && { opacity: 0.5 }]}
                    onPress={copy}
                    disabled={!canCopyDetails(details)}
                    accessibilityRole="button"
                >
                    <Text style={styles.primaryText}>{START_COMMUNITY_COPY.copyButton}</Text>
                </Pressable>
                {copied && <Text style={styles.note} accessibilityLiveRegion="polite">{START_COMMUNITY_COPY.copied}</Text>}

                <Text style={styles.sectionLabel}>ONCE IT'S RUNNING</Text>
                <Text style={styles.intro}>{START_COMMUNITY_COPY.after}</Text>
            </KeyboardAwareScrollView>
        </SafeAreaView>
    );
}
