/**
 * KeeperProtectionPanel — SSO Enrolment Panel
 *
 * NOTE: Friend / keeper recovery has been removed. This panel now hosts SSO enrolment only
 * (Sign-In Recovery Providers: Apple, Google, Facebook).
 *
 * Shown on welcome's Safety Backup and in Settings, in the member's language: its own sentences are word() keys or t(),
 * no-words-copy.ts's (on the 12 words' key path, so in English there) through components/welcome/welcome-lines.ts.
 * Each sentence is its own Text inside the line, so one translation never runs into the next.
 */
import React from 'react';
import { StyleSheet, Text, View, Platform, TouchableOpacity } from 'react-native';
import { colors as lightColors, type AppColors } from '../constants/colors';
import type { Protection } from '../utils/protection-state';
import { GoogleButton, AppleButton, FacebookButton } from './SsoButton';
import { SSO_PROVIDER_NAMES as PROVIDER_NAMES, type SsoProvider } from '../utils/sso-providers';
import { NO_WORDS_WAY_BACK, SSO_WORDS_NOTE } from '../utils/no-words-copy';
import { hasVault } from '../utils/vault-config';
import { t, tn, word } from '@beanpool/core';
import { welcomeLineWords } from './welcome/welcome-lines';
import { WhoCanOpen } from './WhoCanOpen';

/**
 * Under a connected sign-in, in a build without a key vault (utils/vault.ts `signInCopiesAt`): who can open the copy
 * the member's community keeps (recovery seal S3; Marty, card sso-copy-lock, D-2 = a, 2026-09-26). The server's
 * operators can: their process holds data/recovery-seal.key and receives the sign-in's id on every sign-in it checks.
 * A copy of the database alone can't, but only on a server with the seal, and this phone may talk to one that has not
 * updated yet. The 12 words part is for a phone that has them: on one restored with a sign-in and no words, "use only
 * your 12 words" would talk a member out of their only way back.
 */
export const SIGN_IN_COPY_OPENERS =
    word("The people who run your community's server can open the copy of your account kept for your sign-in, because their server checks your sign-in. A stolen copy of the server's database can't, once the server has been updated for it.");
export const SIGN_IN_COPY_WORDS_ONLY = word('If you would rather nobody but you could get in, use only your 12 words.');

/**
 * The same, in a build with BeanPool's key vault (key vault design D6, Marty 2026-09-28: the honest words; D1: one
 * custodian, Marty, until the reshare to people in other countries, and the guide says so). The copy is at the vault,
 * not at any community. BeanPool can open it (the vault checks the sign-in itself, so it learns the id that opens the
 * copy: review FABLE-sec-crypto F1); the host can read the running server's memory; a court could order it; anyone
 * holding the sign-in account could get in, unless a phone of the member's stops the day's wait (the covered footnote). The guide says the same at length: settings/recovery.md "Who can open the copy" (VR0 unparked issue #1349's pages).
 * Behind "Who can open it ›" under the sign-in row (SIGN_IN_ROW), before a sign-in is linked as well as after.
 */
export const VAULT_COPY_OPENERS =
    word("BeanPool's key vault, a small server in Iceland, keeps the copy of your account that your sign-in opens. BeanPool can open these copies: for now one person, BeanPool's founder, looks after the vault, and it is moving to three people in different countries, two of whom must act together. The company that hosts it can read its memory while it runs. A court could order a copy opened, and anyone who takes over your sign-in account could get in.");

/**
 * Above the sign-in buttons, in a build without a key vault: the community's server keeps the whole copy (single blob), so
 * the sign-in brings the account back through it. Was "Any single connected account, plus your community hub, restores
 * your account": that read as two keys, neither enough alone, when the server's operators can open the copy by
 * themselves (SIGN_IN_COPY_OPENERS; review FABLE-sec-sso finding 1, honest wording 2026-10-01).
 */
export const COMMUNITY_SSO_GROUP_NOTE =
    word("Connect more than one, in case you lose one. Any one of them brings your account back on a new phone, through your community's server, which keeps the copy.");

/**
 * The sign-in row in a build with a key vault, where the copy is at the vault (vault rethink VR0, design §4.5; Marty,
 * 27 Oct, picks 10 and 14: he signs these off on the 320 dp shots). It says where the copy goes before **Protect with**
 * is tapped, at Safety Backup and in Account Protection, and VAULT_COPY_OPENERS is one tap away under it ("Who can open
 * it ›"). Each sentence its own Text. Apple is named only where it is offered (an iPhone). On a phone with no 12 words
 * the copy carries none, so the vault's sentence names the key alone. So does Account Protection under a sign-in already
 * connected: that copy may be one sealed on an earlier version, without the words (the vault's status names the sign-ins
 * only), and SSO_WORDS_NOTE under the row says so (review 4397050625). At Safety Backup the copy was made a moment ago,
 * with them. Under a sign-in already connected the covered footnote says the first and the last (it brings the account
 * back; a day's wait), so only the middle two are drawn.
 */
export const SIGN_IN_ROW = {
    title: word('A sign-in you link'),
    bringsBack: word('Google or Facebook brings your account back on a new phone.'),
    bringsBackIos: word('Google, Apple or Facebook brings your account back on a new phone.'),
    vaultKeeps: word("BeanPool's key vault, a small server in Iceland, keeps a locked copy of your key and 12 words for it."),
    vaultKeepsKey: word("BeanPool's key vault, a small server in Iceland, keeps a locked copy of your key for it."),
    whoCanOpen: word('The people who look after the vault can open that copy, and so can anyone who gets into your sign-in account.'),
    wait: word("It takes a day, or less if another phone of yours says it's you."),
    /** Was SSO_GROUP_NOTE's first sentence; its second ("brings your account back on a new phone") is the row's first. */
    moreThanOne: word('Connect more than one, in case you lose one.'),
    whoCanOpenButton: word('Who can open it'),
} as const;

/** The sentences above, for t() where they are shown. */
const PANEL_WORDS = {
    signInCopyOpeners: SIGN_IN_COPY_OPENERS,
    signInCopyWordsOnly: SIGN_IN_COPY_WORDS_ONLY,
    vaultCopyOpeners: VAULT_COPY_OPENERS,
    communityGroupNote: COMMUNITY_SSO_GROUP_NOTE,
} as const;


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
    copyAt,
    onProtectSso,
    onDisconnectSso,
    hasWords,
    waysBack = false,
    colors = lightColors,
}: {
    protection: Protection;
    /**
     * Account Protection in a build with a key vault (vault rethink VR0): the 12 words are the row above this panel
     * there, so a phone with them that has no sign-in yet isn't told "your 12 words are your primary recovery" a
     * second time; the panel is the sign-in row alone. Safety Backup leaves it off.
     */
    waysBack?: boolean;
    /** The drawn theme's colours. Settings passes them; welcome, which is light throughout, keeps the default. */
    colors?: AppColors;
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
    /**
     * Where this copy is, when it isn't where the build keeps copies: 'community' for an account a claim made (Marty, 24 Oct:
     * no copy at our key vault in a self-hosted community's first owner's path), as SsoEnrolSheet's copyAt deposits it.
     */
    copyAt?: 'community';
    onProtectSso?: (provider: SsoProvider) => void;
    onDisconnectSso?: (provider: SsoProvider) => void;
}): React.JSX.Element {
    const styles = stylesFor(colors);
    const enrolledSso = protection.enrolledSso ?? [];
    const allProviders: SsoProvider[] = Platform.OS === 'ios'
        ? ['apple', 'google', 'facebook']
        : ['google', 'facebook'];

    // Where this build keeps the copy (utils/vault.ts `signInCopiesAt`). One copy at the key vault covers every
    // community, so there the heading names none; without a vault each community keeps its own, so it names this one.
    const atVault = hasVault() && copyAt !== 'community';
    const community = atVault ? null : formatCommunityName(communityName);
    const coveredHeading = community ? t("🛡️ You're covered on {community}", { community }) : t("🛡️ You're covered");
    const copyOpeners = atVault ? t(PANEL_WORDS.vaultCopyOpeners) : t(PANEL_WORDS.signInCopyOpeners);
    const covered = protection.state === 'covered';
    // Account Protection's sign-in row on its own: the words row above it already says what the words are.
    const rowOnly = waysBack && atVault && !covered && hasWords;
    // Whether the row may say the vault's copy holds the 12 words (SIGN_IN_ROW): not of a copy Account Protection finds.
    const copyHasWords = hasWords && !(covered && waysBack);
    const openersLine = (
        <Text style={styles.copyOpeners}>
            <Text>{copyOpeners}</Text>
            {hasWords && <>{' '}<Text>{t(PANEL_WORDS.signInCopyWordsOnly)}</Text></>}
        </Text>
    );

    const renderSsoProviders = () => {
        if (Platform.OS === 'web' || !onProtectSso) return null;

        return (
            <View style={[styles.ssoGroup, rowOnly && styles.ssoGroupFirst]}>
                {atVault ? (
                    <>
                        <Text style={styles.ssoGroupTitle} accessibilityRole="header">{t(SIGN_IN_ROW.title)}</Text>
                        <Text style={styles.signInRowLine}>
                            {!covered && <><Text>{Platform.OS === 'ios' ? t(SIGN_IN_ROW.bringsBackIos) : t(SIGN_IN_ROW.bringsBack)}</Text>{' '}</>}
                            <Text>{copyHasWords ? t(SIGN_IN_ROW.vaultKeeps) : t(SIGN_IN_ROW.vaultKeepsKey)}</Text>
                            {' '}<Text>{t(SIGN_IN_ROW.whoCanOpen)}</Text>
                            {!covered && <>{' '}<Text>{t(SIGN_IN_ROW.wait)}</Text></>}
                        </Text>
                    </>
                ) : (
                    <Text style={styles.ssoGroupTitle}>{t('Sign-In Recovery Providers (1-of-N)')}</Text>
                )}
                <Text style={styles.ssoGroupSubtitle}>
                    <Text>{atVault ? t(SIGN_IN_ROW.moreThanOne) : t(PANEL_WORDS.communityGroupNote)}</Text>
                    {hasWords && <>{' '}<Text>{welcomeLineWords(SSO_WORDS_NOTE)}</Text></>}
                    {(hasWords || !atVault) && (
                        <>
                            {' '}
                            <Text>
                                {atVault
                                    ? t('Keep the words written down as well.')
                                    : hasWords
                                        ? t("It only works while your community's server is running, so keep the words written down.")
                                        : t("It only works while your community's server is running.")}
                            </Text>
                        </>
                    )}
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
                                    accessibilityLabel={t('{provider} connected as a recovery provider', { provider: PROVIDER_NAMES[prov] })}
                                >
                                    <Text
                                        style={styles.tick}
                                        accessibilityElementsHidden={true}
                                        importantForAccessibility="no"
                                    >✅</Text>
                                    <Text style={styles.providerName}>{t('{provider} Connected', { provider: PROVIDER_NAMES[prov] })}</Text>
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
                                            accessibilityLabel={t('Connect {provider} again, to include your 12 words', { provider: PROVIDER_NAMES[prov] })}
                                        >
                                            <Text style={styles.reconnectText}>{t('Connect again')}</Text>
                                        </TouchableOpacity>
                                    )}
                                    {onDisconnectSso && (
                                        <TouchableOpacity
                                            style={styles.disconnectBtn}
                                            onPress={() => onDisconnectSso(prov)}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('Disconnect {provider}', { provider: PROVIDER_NAMES[prov] })}
                                        >
                                            <Text style={styles.disconnectText}>{t('Disconnect')}</Text>
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
                                title={t('Protect with Apple')}
                                onPress={() => onProtectSso('apple')}
                                style={{ marginTop: 8 }}
                            />
                        );
                    }
                    if (prov === 'google') {
                        return (
                            <GoogleButton
                                key="google"
                                title={t('Protect with Google')}
                                onPress={() => onProtectSso('google')}
                                style={{ marginTop: 8 }}
                            />
                        );
                    }
                    return (
                        <FacebookButton
                            key="facebook"
                            title={t('Protect with Facebook')}
                            onPress={() => onProtectSso('facebook')}
                            style={{ marginTop: 8 }}
                        />
                    );
                })}
                {/* With a key vault: one tap away, before a sign-in is linked as well as after (VR0: said where the
                    copy is made). Without one: every enrolled sign-in, not just the ones this phone lists: Apple
                    connected on an iPhone has no row on Android, and its copy is on the server all the same. */}
                {atVault ? (
                    <WhoCanOpen label={t(SIGN_IN_ROW.whoCanOpenButton)} colors={colors}>{openersLine}</WhoCanOpen>
                ) : enrolledSso.length > 0 && openersLine}
                <Text style={styles.actionNote}>{t('This is not a login — your account stays your own key.')}</Text>
            </View>
        );
    };

    if (protection.state === 'covered') {
        return (
            <View style={[styles.panel, styles.covered]}>
                <Text style={styles.heading} accessibilityRole="header">{coveredHeading}</Text>
                {protection.holding.map((label, i) => (
                    <View key={`${label}-${i}`} style={styles.row} accessible accessibilityLabel={t('{label}: holding a piece', { label: welcomeLineWords(label) })}>
                        <Text style={styles.tick}>✅</Text>
                        <Text style={styles.rowLabel}>{welcomeLineWords(label)}</Text>
                    </View>
                ))}
                {/* How a sign-in restore goes with a key vault (D2: every one waits a day unless a phone that has the
                    account says it's you). Only the phone app is told of a restore, and only it can answer one (the
                    web app has no vault client), so these say phones, never a computer. */}
                <Text style={styles.footnote}>
                    {atVault
                        ? (enrolledSso.length > 1
                            ? tn(enrolledSso.length,
                                "Protected by {n} sign-in account, in every community. Any one of them brings your account back on a new phone: it takes a day, or less if another phone of yours says it's you, and your other phones are told so they can stop it.",
                                "Protected by {n} sign-in accounts, in every community. Any one of them brings your account back on a new phone: it takes a day, or less if another phone of yours says it's you, and your other phones are told so they can stop it.")
                            : t("Protected by your sign-in account, in every community. It brings your account back on a new phone: it takes a day, or less if another phone of yours says it's you, and your other phones are told so they can stop it."))
                        : enrolledSso.length > 1
                            ? tn(enrolledSso.length,
                                "Protected by {n} sign-in account. Any one of them brings your account back, through your community's server, which keeps the copy.",
                                "Protected by {n} sign-in accounts. Any one of them brings your account back, through your community's server, which keeps the copy.")
                            : t("Protected by your sign-in account. It brings your account back, through your community's server, which keeps the copy.")}
                </Text>

                {renderSsoProviders()}
            </View>
        );
    }

    if (rowOnly) {
        return <View style={[styles.panel, styles.wordsOnly]}>{renderSsoProviders()}</View>;
    }

    // A phone restored with a sign-in has no words to call primary: one line says so, and what to do.
    return (
        <View style={[styles.panel, styles.wordsOnly]}>
            {hasWords ? (
                <>
                    <Text style={styles.heading} accessibilityRole="header">{t('🔑 Your 12 words are your primary recovery')}</Text>
                    <Text style={styles.body}>
                        {t('Your 12 words are your primary key to your account. Write them down safely. Without them or a connected sign-in provider, restoring your account requires operator-assisted re-enrolment by your node administrator.')}
                    </Text>
                </>
            ) : (
                <>
                    <Text style={styles.heading} accessibilityRole="header">{t('🔑 Connect a sign-in')}</Text>
                    <Text style={styles.body}>{welcomeLineWords(NO_WORDS_WAY_BACK)}</Text>
                </>
            )}

            <View style={styles.buttonContainer}>
                {renderSsoProviders()}
            </View>
        </View>
    );
}

const cache = new WeakMap<AppColors, ReturnType<typeof make>>();
function stylesFor(colors: AppColors) {
    let s = cache.get(colors);
    if (!s) {
        s = make(colors);
        cache.set(colors, s);
    }
    return s;
}

const make = (colors: AppColors) => StyleSheet.create({
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
    // The sign-in row alone in its card (Account Protection, waysBack): no rule above it.
    ssoGroupFirst: { marginTop: 0, paddingTop: 0, borderTopWidth: 0 },
    ssoGroupSubtitle: {
        fontSize: 12,
        lineHeight: 16,
        color: colors.text.secondary,
        marginBottom: 10,
    },
    // Where the copy goes, said before Protect with is tapped (VR0): body size, as it is the row's own sentence.
    signInRowLine: {
        fontSize: 13,
        lineHeight: 18,
        color: colors.text.body,
        marginBottom: 6,
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
    // No wider than the row: at 320dp with 1.3x text, Connect again and Disconnect side by side are wider than it, and
    // Disconnect ran past the row, the panel and the card (ways-back-320.mjs, VR0); capped, the second wraps under.
    providerActions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        maxWidth: '100%',
    },
    // Shrinks and wraps beside the tick: "{provider} Connected" runs longer than the row in some languages.
    providerName: {
        flexShrink: 1,
        fontSize: 14,
        fontWeight: '600',
        color: colors.text.heading,
    },
    // Both buttons shrink to the row when their words are longer than it (their words then wrap), rather than run past it.
    disconnectBtn: {
        flexShrink: 1,
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
        flexShrink: 1,
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
