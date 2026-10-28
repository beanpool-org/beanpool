/**
 * Settings → Account Protection → "Where your account can be brought back from" (vault rethink VR1,
 * DESIGN-vault-rethink-fable.md §5.1). Lists every place a copy of this account's key is kept, as far as this phone can
 * ask (utils/ways-back.ts), with since when, Remove beside each copy and Remove everything under them; drawn by
 * components/WaysBackList.tsx.
 *
 * - Asked each time the screen comes into view, and again after every removal: what it shows is what the keepers said.
 * - Every removal is confirmed first. One that would leave no copy this phone knows of asks about the 12 words first
 *   (`beforeRemoving`): "Show my 12 words first?" on a phone that has them and hasn't said they are written down; what
 *   is then left, said plainly, on a phone without them. It never refuses.
 * - The result says what each keeper did, never more: removed on its own answer, "not removed" with why, "not removed
 *   yet" for a community's delete that is remembered and tried again (vault-move.ts), and nothing removed at a community
 *   that couldn't be asked.
 * - Restores of this account waiting (D2) are at the top, with Stop and "Yes, it's me" (RecoveryAlertBanner).
 *
 * The root stack draws no headers, so this screen draws the standard one (← Back and its name), as your-area.tsx does.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { ErrorBoundary, router, useFocusEffect } from 'expo-router';
import { t, tn } from '@beanpool/core';
import { useIdentity } from './IdentityContext';
import { useOnboardingColors } from './ThemeContext';
import type { AppColors } from '../constants/colors';
import { RecoveryAlertBanner } from '../components/RecoveryAlertBanner';
import { WAYS_BACK_LINES, WaysBackList } from '../components/WaysBackList';
import { hasMnemonic } from '../utils/identity';
import { SSO_PROVIDER_NAMES } from '../utils/sso-providers';
import {
    beforeRemoving, listWaysBack, noteWordsWrittenDown, removeCommunityCopyFrom, removeEverything, removeVaultCopy, sameCommunity,
    wordsWrittenDown, type BeforeRemoving, type CopyAt, type EverythingRemoved, type Removal, type WaysBack,
} from '../utils/ways-back';

export { ErrorBoundary };

/** Two whole sentences, one after the other: a language that writes no space between sentences joins them its way. */
const twoSentences = (first: string, second: string) => t('{first} {second}', { first, second }, 'two sentences, one after the other');

const VAULT_DELETES = () => t("BeanPool's key vault deletes it at once, and from its backups within 30 days, or later if the vault is paused in that time.");

/** What a vault removal that didn't happen says. */
function vaultNotRemoved(why: Exclude<Removal, { removed: true }>['why']): string {
    if (why === 'paused') return t("Not removed: BeanPool's key vault is paused for a little while. Try again later.");
    if (why === 'unverified') return t("Not removed: BeanPool's key vault sent an answer that didn't check out. Check that your phone's date and time are right, then try again.");
    if (why === 'refused') return t("Not removed: BeanPool's key vault couldn't do it just now. Try again later.");
    return t("Not removed: BeanPool's key vault didn't answer. Check your connection and try again.");
}

/** What a community removal says: gone on its own answer, or remembered and tried again. */
function communityResult(name: string, removal: Removal): string {
    return removal.removed
        ? t('Removed from {community}.', { community: name })
        : t("Not removed yet: {community} didn't answer. The app tries again each time it opens.", { community: name });
}

/** Remove everything's result, keeper by keeper: only what each one's own answer says. */
function everythingResult(done: EverythingRemoved): string[] {
    const lines: string[] = [];
    if (done.vault) lines.push(done.vault.removed ? t("Removed from BeanPool's key vault.") : vaultNotRemoved(done.vault.why));
    for (const c of done.communities) {
        const line = communityResult(c.name, c.removal);
        if (!lines.includes(line)) lines.push(line);
    }
    for (const c of done.notAsked) lines.push(t("{community} didn't answer, so nothing kept there was removed. Open this screen again later.", { community: c.name }));
    return lines;
}

export default function WaysBackScreen() {
    // The colours your-area.tsx draws its header and cards in, light or dark.
    const { colors, dark } = useOnboardingColors();
    const styles = useMemo(() => makeStyles(colors, dark), [colors, dark]);
    const { identity } = useIdentity();
    const insets = useSafeAreaInsets();
    const [ways, setWays] = useState<WaysBack | null>(null);
    const [writtenDown, setWrittenDown] = useState(false);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<string[]>([]);
    const hasWords = hasMnemonic(identity);
    // Each read has a turn: an answer that arrives after a newer read began (or the screen left) is dropped.
    const turn = useRef(0);

    const load = useCallback(async () => {
        if (!identity?.privateKey) return;
        const mine = ++turn.current;
        const [found, said] = await Promise.all([listWaysBack(identity), wordsWrittenDown(identity.publicKey)]);
        if (mine !== turn.current) return;
        setWays(found);
        setWrittenDown(said);
    }, [identity]);

    useFocusEffect(useCallback(() => {
        void load();
        return () => { turn.current++; };
    }, [load]));

    const showWords = () => router.push({ pathname: '/(tabs)/settings', params: { section: 'protection' } });

    const after = async (lines: string[]) => {
        setResult(lines);
        setWays(null);
        await load();
    };

    /** The confirm, or the 12 words first (see the file's note); `go` runs only on the member's yes. */
    const confirm = (before: BeforeRemoving, title: string, body: string, go: () => void) => {
        if (before === 'show-words-first') {
            Alert.alert(t('Show my 12 words first?'), twoSentences(t('After this, no copy this phone knows of can bring your account back. Only your 12 words can, so write them down first.'), body), [
                { text: t('Cancel'), style: 'cancel' },
                { text: t(WAYS_BACK_LINES.showWords), onPress: showWords },
                { text: t('Remove anyway'), style: 'destructive', onPress: go },
            ]);
            return;
        }
        if (before === 'no-words-on-phone') {
            Alert.alert(t('This phone has no 12 words'), twoSentences(t('After this, no copy this phone knows of can bring your account back. Unless you have your 12 words written down, losing this phone loses your account: an admin can only move your Beans and name to a new key.'), body), [
                { text: t('Keep it'), style: 'cancel' },
                { text: t('Remove anyway'), style: 'destructive', onPress: go },
            ]);
            return;
        }
        Alert.alert(title, body, [
            { text: t('Cancel'), style: 'cancel' },
            { text: t(WAYS_BACK_LINES.remove), style: 'destructive', onPress: go },
        ]);
    };

    const onRemove = (copy: CopyAt) => {
        if (!identity || !ways || busy) return;
        const name = SSO_PROVIDER_NAMES[copy.provider];
        const community = copy.at === 'community' ? ways.communities.find(c => sameCommunity(c.url, copy.url)) : undefined;
        if (copy.at === 'community' && !community) return;
        // The vault keeps a copy per sign-in account and removes a sign-in's copies together: two accounts, both go, and the
        // member is told so (PR #2570 review).
        const atVault = copy.at === 'vault' && ways.vault.kind === 'listed' ? ways.vault.copies.filter(c => c.provider === copy.provider).length : 1;
        const body = copy.at === 'community'
            ? t("{community}'s server deletes it. Copies already in that server's backups stay there.", { community: community!.name })
            : atVault > 1
                ? t("BeanPool's key vault keeps one for each {provider} account you linked, and removes them together. It deletes them at once, and from its backups within 30 days, or later if the vault is paused in that time.", { provider: name })
                : VAULT_DELETES();
        const title = atVault > 1
            ? tn(atVault, 'Remove your {n} {provider} copy?', 'Remove your {n} {provider} copies?', { provider: name })
            : t('Remove your {provider} copy?', { provider: name });
        confirm(beforeRemoving(ways, copy, { hasWords, writtenDown }), title, body, () => {
            void (async () => {
                setBusy(true);
                try {
                    if (copy.at === 'vault') {
                        const removal = await removeVaultCopy(identity, copy.provider);
                        await after([removal.removed ? t("Removed from BeanPool's key vault.") : vaultNotRemoved(removal.why)]);
                    } else {
                        await after([communityResult(community!.name, await removeCommunityCopyFrom(identity, community!, copy.provider))]);
                    }
                } finally {
                    setBusy(false);
                }
            })();
        });
    };

    const onRemoveEverything = () => {
        if (!identity || !ways || busy) return;
        const parts: string[] = [];
        if (ways.vault.kind === 'unknown' || (ways.vault.kind === 'listed' && ways.vault.copies.length > 0)) {
            parts.push(t("BeanPool's key vault deletes its copies at once, and from its backups within 30 days, or later if the vault is paused in that time."));
        }
        if (ways.communities.some(c => (c.status?.providers.length ?? 0) > 0)) {
            parts.push(t("Each community's server deletes its copy. Copies already in a server's backups stay there."));
        }
        for (const c of ways.communities.filter(c => !c.status)) {
            parts.push(t("{community} didn't answer, so anything kept there stays.", { community: c.name }));
        }
        const body = parts.reduce((all, p) => (all ? twoSentences(all, p) : p), '');
        confirm(beforeRemoving(ways, 'everything', { hasWords, writtenDown }), t('Remove everything?'), body, () => {
            void (async () => {
                setBusy(true);
                try {
                    await after(everythingResult(await removeEverything(identity, ways)));
                } finally {
                    setBusy(false);
                }
            })();
        });
    };

    const onWrittenDown = (yes: boolean) => {
        setWrittenDown(yes);
        if (identity) void noteWordsWrittenDown(identity.publicKey, yes);
    };

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <StatusBar style="light" />
            <View style={styles.header}>
                <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel={t('Back')}>
                    <MaterialCommunityIcons name="arrow-left" size={26} color={colors.text.inverse} />
                </Pressable>
                <Text style={styles.headerTitle} numberOfLines={1} accessibilityRole="header">{t(WAYS_BACK_LINES.header)}</Text>
                <View style={styles.headerSpacer} />
            </View>
            <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: Math.max(insets.bottom, 16) + 32 }]}>
                <RecoveryAlertBanner onStopSuccess={() => { void load(); }} />
                <View style={styles.card}>
                    <WaysBackList
                        ways={ways}
                        hasWords={hasWords}
                        writtenDown={writtenDown}
                        busy={busy}
                        result={result}
                        colors={colors}
                        onWrittenDown={onWrittenDown}
                        onShowWords={showWords}
                        onRemove={onRemove}
                        onRemoveEverything={onRemoveEverything}
                        onLinkSignIn={showWords}
                    />
                </View>
            </ScrollView>
        </SafeAreaView>
    );
}

function makeStyles(colors: AppColors, dark: boolean) {
    return StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.border.default, backgroundColor: dark ? colors.surface.card : colors.text.heading },
        backButton: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
        headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: 'bold', color: colors.brand.primary, letterSpacing: 0.5 },
        headerSpacer: { width: 48 },
        scroll: { padding: 16 },
        card: { backgroundColor: colors.surface.card, borderRadius: 16, padding: 16, marginBottom: 12 },
    });
}
