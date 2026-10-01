/**
 * KeeperProtectionPanel — SSO Enrolment Panel
 *
 * NOTE: Friend / keeper recovery has been removed. This panel now hosts SSO enrolment only
 * (Sign-In Recovery Providers: Apple, Google, Facebook).
 */
import React from 'react';
import { StyleSheet, Text, View, Platform, TouchableOpacity } from 'react-native';
import { colors } from '../constants/colors';
import type { Protection } from '../utils/protection-state';
import { GoogleButton, AppleButton, FacebookButton } from './SsoButton';
import { SSO_PROVIDER_NAMES as PROVIDER_NAMES, type SsoProvider } from '../utils/sso-providers';
import { NO_WORDS_WAY_BACK, SSO_WORDS_NOTE } from '../utils/no-words-copy';
import { hasVault } from '../utils/vault-config';

/**
 * Under a connected sign-in, in a build without a key vault (utils/vault.ts `signInCopiesAt`): who can open the copy
 * the member's community keeps (recovery seal S3; Marty, card sso-copy-lock, D-2 = a, 2026-09-26). The server's
 * operators can: their process holds data/recovery-seal.key and receives the sign-in's id on every sign-in it checks.
 * A copy of the database alone can't, but only on a server with the seal, and this phone may talk to one that has not
 * updated yet. The 12 words part is for a phone that has them: on one restored with a sign-in and no words, "use only
 * your 12 words" would talk a member out of their only way back.
 */
export const SIGN_IN_COPY_OPENERS =
    "The people who run your community's server can open the copy of your account kept for your sign-in, because their server checks your sign-in. A stolen copy of the server's database can't, once the server has been updated for it.";
export const SIGN_IN_COPY_WORDS_ONLY = 'If you would rather nobody but you could get in, use only your 12 words.';

/**
 * The same, in a build with BeanPool's key vault (key vault design D6, Marty 2026-09-28: the honest words; D1: one
 * custodian, Marty, until the reshare to people in other countries, and the guide says so). The copy is at the vault,
 * not at any community. BeanPool can open it (the vault checks the sign-in itself, so it learns the id that opens the
 * copy: review FABLE-sec-crypto F1); the host can read the running server's memory; a court could order it; anyone
 * holding the sign-in account could get in, unless a device of the member's stops the day's wait (SSO_WAIT_NOTE, in the
 * footnote). The guide says the same at length once the vault is live: the parked pages in issue #1349.
 */
export const VAULT_COPY_OPENERS =
    "BeanPool's key vault, a small server in Iceland, keeps the copy of your account that your sign-in opens. BeanPool can open these copies: for now one person, BeanPool's founder, looks after the vault, and it is moving to three people in different countries, two of whom must act together. The company that hosts it can read its memory while it runs. A court could order a copy opened, and anyone who takes over your sign-in account could get in.";

/**
 * Above the sign-in buttons, in a build without a key vault: the community's server keeps the whole copy (single blob), so
 * the sign-in brings the account back through it. Was "Any single connected account, plus your community hub, restores
 * your account": that read as two keys, neither enough alone, when the server's operators can open the copy by
 * themselves (SIGN_IN_COPY_OPENERS; review FABLE-sec-sso finding 1, honest wording 2026-10-01).
 */
export const COMMUNITY_SSO_GROUP_NOTE =
    "Connect more than one, in case you lose one. Any one of them brings your account back on a new phone, through your community's server, which keeps the copy.";

/** Above the sign-in buttons, in a build with a key vault: what a linked sign-in does now that the vault keeps the copy. */
export const SSO_GROUP_NOTE =
    'Connect more than one, in case you lose one. Any one of them brings your account back on a new phone, in every community.';

/** How a sign-in restore goes with a key vault (D2: every one waits a day unless a device that has the account says it's you). */
export const SSO_WAIT_NOTE =
    "it takes a day, or less if another phone or computer of yours says it's you, and your devices are told so they can stop it.";

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
     * The community this protection describes, in a build without a key vault: there keepers are enrolled PER NODE, so
     * a panel that names no community reads as a property of the account and is how a member ends up attempting
     * recovery on a node that holds nothing for them. Unused with a vault, whose one copy covers every community.
     */
    communityName?: string;
    onProtectSso?: (provider: SsoProvider) => void;
    onDisconnectSso?: (provider: SsoProvider) => void;
}): React.JSX.Element {
    const enrolledSso = protection.enrolledSso ?? [];
    const allProviders: SsoProvider[] = Platform.OS === 'ios'
        ? ['apple', 'google', 'facebook']
        : ['google', 'facebook'];

    // Where this build keeps the copy (utils/vault.ts `signInCopiesAt`). One copy at the key vault covers every
    // community, so there the heading names none; without a vault each community keeps its own, so it names this one.
    const atVault = hasVault();
    const community = atVault ? null : formatCommunityName(communityName);
    const coveredHeading = community ? `🛡️ You're covered on ${community}` : "🛡️ You're covered";
    const copyOpeners = atVault ? VAULT_COPY_OPENERS : SIGN_IN_COPY_OPENERS;

    const renderSsoProviders = () => {
        if (Platform.OS === 'web' || !onProtectSso) return null;

        return (
            <View style={styles.ssoGroup}>
                <Text style={styles.ssoGroupTitle}>Sign-In Recovery Providers (1-of-N)</Text>
                <Text style={styles.ssoGroupSubtitle}>
                    {atVault
                        ? (hasWords ? `${SSO_GROUP_NOTE} ${SSO_WORDS_NOTE} Keep the words written down as well.` : SSO_GROUP_NOTE)
                        : hasWords
                            ? `${COMMUNITY_SSO_GROUP_NOTE} ${SSO_WORDS_NOTE} It only works while your community's server is running, so keep the words written down.`
                            : `${COMMUNITY_SSO_GROUP_NOTE} It only works while your community's server is running.`}
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
                                {/* Connecting again replaces this sign-in's copy (at the vault, or without one at the
                                    community) with a fresh one, which carries the 12 words: the way to add them to a
                                    copy made without them. Pointless on a phone without words. */}
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
                    return (
                        <FacebookButton
                            key="facebook"
                            title="Protect with Facebook"
                            onPress={() => onProtectSso('facebook')}
                            style={{ marginTop: 8 }}
                        />
                    );
                })}
                {/* Every enrolled sign-in, not just the ones this phone lists: Apple connected on an iPhone has no
                    row on Android, and its copy is on the server all the same. */}
                {enrolledSso.length > 0 && (
                    <Text style={styles.copyOpeners}>
                        {hasWords ? `${copyOpeners} ${SIGN_IN_COPY_WORDS_ONLY}` : copyOpeners}
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
                    {atVault
                        ? (enrolledSso.length > 1
                            ? `Protected by ${enrolledSso.length} sign-in accounts, in every community. Any one of them brings your account back on a new phone: ${SSO_WAIT_NOTE}`
                            : `Protected by your sign-in account, in every community. It brings your account back on a new phone: ${SSO_WAIT_NOTE}`)
                        : enrolledSso.length > 1
                            ? `Protected by ${enrolledSso.length} sign-in accounts. Any one of them brings your account back, through your community's server, which keeps the copy.`
                            : "Protected by your sign-in account. It brings your account back, through your community's server, which keeps the copy."}
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
