/**
 * KeeperProtectionPanel — SSO Enrolment Panel
 *
 * NOTE: Friend / keeper recovery has been removed. This panel now hosts SSO enrolment only
 * (Sign-In Recovery Providers: Apple, Google, Facebook, GitHub).
 */
import React from 'react';
import { StyleSheet, Text, View, Platform, TouchableOpacity } from 'react-native';
import { colors } from '../constants/colors';
import type { Protection } from '../utils/protection-state';
import { GoogleButton, AppleButton, FacebookButton, GitHubButton } from './SsoButton';
import type { SsoProvider } from '../utils/sso-signin';
import { NO_WORDS_WAY_BACK, SSO_WORDS_NOTE } from '../utils/no-words-copy';

const PROVIDER_NAMES: Record<SsoProvider, string> = {
    apple: 'Apple',
    google: 'Google',
    facebook: 'Facebook',
    github: 'GitHub',
};

/**
 * Under a connected sign-in: who can open the copy it keeps (recovery seal S3; Marty, card sso-copy-lock, D-2 = a,
 * 2026-09-26). The server's operators can: their process holds data/recovery-seal.key and receives the sign-in's id
 * on every sign-in it checks. A copy of the database alone can't, but only on a server with the seal, and this phone
 * may talk to one that has not updated yet. The 12 words part is for a phone that has them: on one restored with a
 * sign-in and no words, "use only your 12 words" would talk a member out of their only way back.
 */
export const SIGN_IN_COPY_OPENERS =
    "The people who run your community's server can open the copy of your account kept for your sign-in, because their server checks your sign-in. A stolen copy of the server's database can't, once the server has been updated for it.";
export const SIGN_IN_COPY_WORDS_ONLY = 'If you would rather nobody but you could get in, use only your 12 words.';

export function formatCommunityName(raw?: string | null): string | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed === 'Detecting...' || trimmed === 'Local discovery (or offline)') {
        return null;
    }
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        try {
            const url = new URL(trimmed);
            return url.host || url.hostname || trimmed;
        } catch {
            return trimmed.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        }
    }
    return trimmed;
}

export function KeeperProtectionPanel({
    protection,
    communityName,
    onProtectSso,
    onDisconnectSso,
    hasWords,
}: {
    protection: Protection;
    /**
     * Whether this phone holds the 12 words (`hasMnemonic`). A phone restored with a sign-in holds
     * none, so the panel must not call them the way back or tell the member to keep them written down.
     */
    hasWords: boolean;
    /**
     * The community this protection describes. Keepers are enrolled PER NODE, so a
     * panel that names no community reads as a property of the account and is how a
     * member ends up attempting recovery on a node that holds nothing for them.
     */
    communityName?: string;
    onProtectSso?: (provider: SsoProvider) => void;
    onDisconnectSso?: (provider: SsoProvider) => void;
}): React.JSX.Element {
    const enrolledSso = protection.enrolledSso ?? [];
    const allProviders: SsoProvider[] = Platform.OS === 'ios'
        ? ['apple', 'google', 'facebook', 'github']
        : ['google', 'facebook', 'github'];

    const community = formatCommunityName(communityName);
    const coveredHeading = community ? `🛡️ You're covered on ${community}` : "🛡️ You're covered";

    const renderSsoProviders = () => {
        if (Platform.OS === 'web' || !onProtectSso) return null;

        return (
            <View style={styles.ssoGroup}>
                <Text style={styles.ssoGroupTitle}>Sign-In Recovery Providers (1-of-N)</Text>
                <Text style={styles.ssoGroupSubtitle}>
                    {hasWords
                        ? `Connect more than one for redundancy. Any single connected account, plus your community hub, restores your account on a new phone. ${SSO_WORDS_NOTE} It only works while your hub is running — so keep the words written down.`
                        : 'Connect more than one for redundancy. Any single connected account, plus your community hub, restores your account on a new phone. It only works while your hub is running.'}
                </Text>

                {allProviders.map((prov) => {
                    const isConnected = enrolledSso.includes(prov);
                    if (isConnected) {
                        return (
                            <View key={prov} style={styles.providerConnectedRow}>
                                {/*
                                  * Grouped on the TEXT, not on the row. `accessible` collapses a
                                  * subtree into one element, so putting it on the row would take
                                  * the Disconnect button out of the reader's focus order — the
                                  * control would still be on screen and no longer reachable.
                                  * The tick is decorative and repeats what the label says.
                                  */}
                                <View
                                    style={styles.providerInfo}
                                    accessible={true}
                                    accessibilityLabel={`${PROVIDER_NAMES[prov]} connected as a recovery provider`}
                                >
                                    <Text
                                        style={styles.tick}
                                        accessibilityElementsHidden={true}
                                        importantForAccessibility="no"
                                    >✅</Text>
                                    <Text style={styles.providerName}>{PROVIDER_NAMES[prov]} Connected</Text>
                                </View>
                                {/* Connecting again replaces this sign-in's copy with one that carries the 12 words.
                                    The only way to add them to a copy made before copies carried words: the node
                                    refuses to disconnect a member's last sign-in. Pointless on a phone without words. */}
                                <View style={styles.providerActions}>
                                    {hasWords && (
                                        <TouchableOpacity
                                            style={styles.reconnectBtn}
                                            onPress={() => onProtectSso(prov)}
                                            accessibilityRole="button"
                                            accessibilityLabel={`Connect ${PROVIDER_NAMES[prov]} again, to include your 12 words`}
                                        >
                                            <Text style={styles.reconnectText}>Connect again</Text>
                                        </TouchableOpacity>
                                    )}
                                    {onDisconnectSso && (
                                        <TouchableOpacity
                                            style={styles.disconnectBtn}
                                            onPress={() => onDisconnectSso(prov)}
                                            accessibilityRole="button"
                                            accessibilityLabel={`Disconnect ${PROVIDER_NAMES[prov]}`}
                                        >
                                            <Text style={styles.disconnectText}>Disconnect</Text>
                                        </TouchableOpacity>
                                    )}
                                </View>
                            </View>
                        );
                    }

                    if (prov === 'apple') {
                        return (
                            <AppleButton
                                key="apple"
                                title="Protect with Apple"
                                onPress={() => onProtectSso('apple')}
                                style={{ marginTop: 8 }}
                            />
                        );
                    }
                    if (prov === 'google') {
                        return (
                            <GoogleButton
                                key="google"
                                title="Protect with Google"
                                onPress={() => onProtectSso('google')}
                                style={{ marginTop: 8 }}
                            />
                        );
                    }
                    if (prov === 'facebook') {
                        return (
                            <FacebookButton
                                key="facebook"
                                title="Protect with Facebook"
                                onPress={() => onProtectSso('facebook')}
                                style={{ marginTop: 8 }}
                            />
                        );
                    }
                    return (
                        <GitHubButton
                            key="github"
                            title="Protect with GitHub"
                            onPress={() => onProtectSso('github')}
                            style={{ marginTop: 8 }}
                        />
                    );
                })}
                {allProviders.some(p => enrolledSso.includes(p)) && (
                    <Text style={styles.copyOpeners}>
                        {hasWords ? `${SIGN_IN_COPY_OPENERS} ${SIGN_IN_COPY_WORDS_ONLY}` : SIGN_IN_COPY_OPENERS}
                    </Text>
                )}
                <Text style={styles.actionNote}>This is not a login — your account stays your own key.</Text>
            </View>
        );
    };

    if (protection.state === 'covered') {
        return (
            <View style={[styles.panel, styles.covered]}>
                <Text style={styles.heading} accessibilityRole="header">{coveredHeading}</Text>
                {protection.holding.map((label, i) => (
                    <View key={`${label}-${i}`} style={styles.row} accessible accessibilityLabel={`${label}: holding a piece`}>
                        <Text style={styles.tick}>✅</Text>
                        <Text style={styles.rowLabel}>{label}</Text>
                    </View>
                ))}
                <Text style={styles.footnote}>
                    {enrolledSso.length > 1
                        ? `Protected by ${enrolledSso.length} sign-in accounts + your community hub. Any single account, together with the hub, restores your account.`
                        : "Your sign-in account can't restore your account alone — it takes your community's server too."}
                </Text>

                {renderSsoProviders()}
            </View>
        );
    }

    // A phone restored with a sign-in has no words to call primary: one line says so, and what to do.
    return (
        <View style={[styles.panel, styles.wordsOnly]}>
            {hasWords ? (
                <>
                    <Text style={styles.heading} accessibilityRole="header">🔑 Your 12 words are your primary recovery</Text>
                    <Text style={styles.body}>
                        Your 12 words are your primary key to your account. Write them down safely. Without them or a connected sign-in provider, restoring your account requires operator-assisted re-enrolment by your node administrator.
                    </Text>
                </>
            ) : (
                <>
                    <Text style={styles.heading} accessibilityRole="header">🔑 Connect a sign-in</Text>
                    <Text style={styles.body}>{NO_WORDS_WAY_BACK}</Text>
                </>
            )}

            <View style={styles.buttonContainer}>
                {renderSsoProviders()}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    panel: { borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1 },
    covered: { backgroundColor: colors.feedback.success.bg, borderColor: colors.feedback.success.border },
    wordsOnly: { backgroundColor: colors.feedback.info.bg, borderColor: colors.feedback.info.border },
    heading: { fontSize: 18, fontWeight: '700', color: colors.text.heading, marginBottom: 8 },
    body: { fontSize: 14, lineHeight: 20, color: colors.text.body, marginBottom: 8 },
    row: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
    tick: { fontSize: 15, marginRight: 8 },
    rowLabel: { flex: 1, fontSize: 14, color: colors.text.body, flexWrap: 'wrap' },
    footnote: { fontSize: 13, lineHeight: 18, color: colors.text.secondary, marginTop: 10, marginBottom: 4 },
    buttonContainer: { marginTop: 12 },
    ssoGroup: {
        marginTop: 14,
        paddingTop: 12,
        borderTopWidth: 1,
        borderTopColor: 'rgba(255, 255, 255, 0.1)',
    },
    ssoGroupTitle: {
        fontSize: 14,
        fontWeight: '700',
        color: colors.text.heading,
        marginBottom: 4,
    },
    ssoGroupSubtitle: {
        fontSize: 12,
        lineHeight: 16,
        color: colors.text.secondary,
        marginBottom: 10,
    },
    // Wraps: at 320dp and a 1.3x font the name and two buttons do not fit on one line.
    providerConnectedRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: colors.surface.card,
        borderWidth: 1,
        borderColor: colors.feedback.success.border,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        marginTop: 8,
    },
    providerInfo: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
        minWidth: 150,
    },
    providerActions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    providerName: {
        fontSize: 14,
        fontWeight: '600',
        color: colors.text.heading,
    },
    disconnectBtn: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        minHeight: 44,
        justifyContent: 'center',
        borderRadius: 6,
        borderWidth: 1,
        borderColor: colors.feedback.danger.border,
        backgroundColor: 'rgba(239, 68, 68, 0.1)',
    },
    disconnectText: {
        fontSize: 12,
        fontWeight: '600',
        color: colors.feedback.danger.fg,
    },
    reconnectBtn: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        minHeight: 44,
        justifyContent: 'center',
        borderRadius: 6,
        borderWidth: 1,
        borderColor: colors.feedback.success.border,
    },
    reconnectText: {
        fontSize: 12,
        fontWeight: '600',
        color: colors.feedback.success.fg,
    },
    // Wraps in the column at any width: no fixed height, no numberOfLines, so 320dp at a 1.3x font cuts nothing off.
    copyOpeners: {
        fontSize: 12,
        lineHeight: 16,
        color: colors.text.secondary,
        marginTop: 10,
    },
    actionNote: {
        fontSize: 12,
        lineHeight: 16,
        color: colors.text.secondary,
        marginTop: 8,
        textAlign: 'center',
    },
});
