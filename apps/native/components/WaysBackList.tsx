/**
 * "Where your account can be brought back from" (vault rethink VR1, DESIGN-vault-rethink-fable.md §5.1), drawn from what
 * utils/ways-back.ts found: the 12 words (on this phone or not, and the member's say-so that they are written down),
 * each copy at BeanPool's key vault with since when it is kept, each copy at each community saved on this phone (the
 * one its admins can bring the member back from, VR3, with since when), the deletes still waiting, and Remove beside each
 * copy and Remove everything under them. The vault keeps a copy per
 * sign-in account and removes a sign-in's copies together, so a sign-in with two accounts linked shows both copies, each
 * with its own dates, above one Remove that says it takes both. app/ways-back.tsx asks, removes and confirms; this only
 * draws, so the words render test and the 320 dp shots draw exactly what the screen does.
 *
 * Every sentence is its own Text and goes through t(). Nothing here says a copy is gone or kept on a guess: a keeper that
 * couldn't be asked says so, and a delete that hasn't landed reads "Not removed yet". Words wrap at any width (no
 * numberOfLines), and each button is at least 44 dp tall, at 320 dp and 1.3× text.
 */
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatDate, t, tn, word } from '@beanpool/core';
import { colors as lightColors, type AppColors } from '../constants/colors';
import { SSO_PROVIDER_NAMES, type SsoProvider } from '../utils/sso-providers';
import {
    everyoneAnswered, knownCopies, otherHalfMissing, sameCommunity, strayVaultHalves, unopenableAdminsCopies, unplacedVaultHalves, vaultCopiesBySignIn, vaultHalfOf, vaultHalves, wordsOnly, type CopyAt, type NotAnswered, type WaysBack,
} from '../utils/ways-back-state';

/** The screen's sentences said in more than one place (the list, its dialogs, the results): marked here, t() where shown. */
export const WAYS_BACK_LINES = {
    header: word('Ways back'),
    title: word('Where your account can be brought back from'),
    intro: word('Every place a copy of your account is kept, as far as this phone can ask.'),
    words: word('🔑 Your 12 words'),
    wordsHere: word('On this phone.'),
    wordsNotHere: word('No copy on this phone.'),
    writtenDown: word('I have them written down'),
    showWords: word('Show my 12 words'),
    vault: word("BeanPool's key vault"),
    communities: word("Your communities' servers"),
    keepsNone: word('Keeps no copy of your account.'),
    remove: word('Remove'),
    removeEverything: word('Remove everything'),
    notYetRemoved: word('Not removed yet. The app tries again each time it opens.'),
    communityUnknown: word("Didn't answer, so what it keeps can't be listed here."),
    linkSignIn: word('Link a sign-in'),
    linkSignInLine: word('A sign-in you link is a way back again, in Account Protection.'),
    // The community the phone is on keeps no copies (its rule, vault rethink VR2, design §5.3): nothing is offered, and
    // what is listed was made elsewhere.
    keepsNoCopies: word("This community keeps no copies of members' accounts and doesn't use BeanPool's key vault, so no sign-in can be linked here. Your 12 words are your way back here."),
    madeElsewhere: word('Any copy listed here was made before, here or in another community: it is yours until you remove it.'),
    // The copy a community keeps for its admins to bring the member back from (vault rethink VR3), whole, on its server.
    admins: word("Your community's admins"),
    adminsLine: word('A locked copy an admin can bring your account back from, when they see you in person.'),
    // One its server keeps but can't open now (its key gone, or another): listed and removable, never a way back.
    adminsCantOpen: word("Its server can't open this copy now, so it can't bring your account back. Account Protection says what can be done. Your 12 words still work."),
    // The shared placement (vault rethink VR4): half at the vault, half at the community, one way back.
    adminsHalfLine: word("Half of a locked copy, with the other half at BeanPool's key vault. It takes both for an admin to bring your account back, when they see you in person."),
    adminsHalfMissing: word("The other half isn't at BeanPool's key vault, so this can't bring your account back. Account Protection can try again."),
    vaultHalf: word('Half a copy for {community}'),
    vaultHalfStray: word('Half a copy for another community'),
    vaultHalfLine: word('A locked copy your community can open with its half, after a day.'),
    vaultHalfAlone: word('Half of a locked copy. No community on this phone holds its other half.'),
    // One no community has claimed while a community that hasn't said might yet: never called stray, so never removed on a guess.
    vaultHalfNotPlaced: word('Half a copy for a community'),
    vaultHalfNotPlacedLine: word("Half of a locked copy. This phone can't tell yet whether one of your communities holds its other half. Open this screen again later."),
    removeShared: word("{community}'s server and BeanPool's key vault delete their halves of your copy. Your admins can no longer bring you back; your 12 words still work."),
} as const;

/** Why the vault's copies can't be listed, in the member's words. */
export function vaultUnknownWords(why: NotAnswered): string {
    if (why === 'paused') return t("BeanPool's key vault is paused for a little while, so its copies can't be listed. Nothing there has changed.");
    if (why === 'unverified') return t("BeanPool's key vault sent an answer that didn't check out, so its copies can't be listed. Check that your phone's date and time are right.");
    return t("BeanPool's key vault didn't answer, so its copies can't be listed. Nothing there has changed.");
}

/** A vault day (`YYYY-MM-DD`, UTC) as the member reads it: "3 Oct 2026". */
export function dayWords(day: string): string {
    return formatDate(new Date(`${day}T00:00:00Z`), 'day-month-year', { utc: true });
}

interface Props {
    /** What was found; null while the keepers are asked. */
    ways: WaysBack | null;
    hasWords: boolean;
    writtenDown: boolean;
    /** A removal under way: every button waits. */
    busy: boolean;
    /** What the last removal did, each line already in the member's words. */
    result: string[];
    colors?: AppColors;
    onWrittenDown: (writtenDown: boolean) => void;
    onShowWords: () => void;
    onRemove: (copy: CopyAt) => void;
    onRemoveEverything: () => void;
    onLinkSignIn: () => void;
    /** The community the phone is on keeps no copies (its rule, VR2): no reverse is offered, and the list says so. */
    noCopiesHere?: boolean;
}

export function WaysBackList({
    ways, hasWords, writtenDown, busy, result, colors = lightColors, onWrittenDown, onShowWords, onRemove, onRemoveEverything, onLinkSignIn,
    noCopiesHere = false,
}: Props): React.JSX.Element {
    const s = stylesFor(colors);
    const removeButton = (copy: CopyAt, label: string) => (
        <Pressable
            style={[s.remove, busy && s.disabled]}
            disabled={busy}
            onPress={() => onRemove(copy)}
            accessibilityRole="button"
            accessibilityLabel={label}
        >
            <Text style={s.removeText}>{t(WAYS_BACK_LINES.remove)}</Text>
        </Pressable>
    );

    return (
        <View>
            <Text style={s.title} accessibilityRole="header">{t(WAYS_BACK_LINES.title)}</Text>
            <Text style={s.intro}>{t(WAYS_BACK_LINES.intro)}</Text>

            {/* The 12 words: never asked of anyone, so drawn at once. */}
            <View style={s.section}>
                <Text style={s.heading} accessibilityRole="header">{t(WAYS_BACK_LINES.words)}</Text>
                <Text style={s.line}>{hasWords ? t(WAYS_BACK_LINES.wordsHere) : t(WAYS_BACK_LINES.wordsNotHere)}</Text>
                <Pressable
                    style={s.tick}
                    onPress={() => onWrittenDown(!writtenDown)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: writtenDown }}
                    accessibilityLabel={t(WAYS_BACK_LINES.writtenDown)}
                >
                    <View style={[s.box, writtenDown && s.boxOn]}>
                        {writtenDown && <Text style={s.boxMark} accessibilityElementsHidden importantForAccessibility="no">✓</Text>}
                    </View>
                    <Text style={s.tickText}>{t(WAYS_BACK_LINES.writtenDown)}</Text>
                </Pressable>
                {hasWords && (
                    <Pressable style={s.secondary} onPress={onShowWords} accessibilityRole="button">
                        <Text style={s.secondaryText}>{t(WAYS_BACK_LINES.showWords)}</Text>
                    </Pressable>
                )}
            </View>

            {!ways ? (
                <ActivityIndicator color={colors.brand.primary} style={{ marginVertical: 20 }} accessibilityLabel={t('Checking where copies are kept')} />
            ) : (
                <>
                    {ways.vault.kind !== 'no-vault' && (
                        <View style={s.section}>
                            <Text style={s.heading} accessibilityRole="header">{t(WAYS_BACK_LINES.vault)}</Text>
                            {ways.vault.kind === 'unknown' ? (
                                <Text style={s.line}>{vaultUnknownWords(ways.vault.why)}</Text>
                            ) : ways.vault.copies.length === 0 && vaultHalves(ways).length === 0 ? (
                                <Text style={s.line}>{t(WAYS_BACK_LINES.keepsNone)}</Text>
                            ) : vaultCopiesBySignIn(ways.vault.copies).map(({ provider, copies }) => {
                                const name = SSO_PROVIDER_NAMES[provider];
                                const several = copies.length > 1;
                                return (
                                    <View key={provider} style={s.copy}>
                                        <Text style={s.copyName}>{name}</Text>
                                        {several && (
                                            <Text style={s.small}>{tn(copies.length, 'A copy for {n} {provider} account.', 'A copy for each of {n} {provider} accounts.', { provider: name })}</Text>
                                        )}
                                        {copies.map((c, i) => (
                                            <View key={i} style={several ? s.account : undefined}>
                                                {c.since && <Text style={s.small}>{t('Kept since {date}', { date: dayWords(c.since) })}</Text>}
                                                {c.lastReleasedAt !== null && (
                                                    <Text style={s.small}>{t('Last brought your account back on {date}', { date: formatDate(new Date(c.lastReleasedAt), 'day-month-year') })}</Text>
                                                )}
                                            </View>
                                        ))}
                                        {removeButton({ at: 'vault', provider }, several
                                            ? tn(copies.length, "Remove the {n} {provider} copy at BeanPool's key vault", "Remove the {n} {provider} copies at BeanPool's key vault", { provider: name })
                                            : t("Remove the {provider} copy at BeanPool's key vault", { provider: name }))}
                                    </View>
                                );
                            })}
                            {ways.communities.filter(c => vaultHalfOf(ways, c)).map(c => {
                                const half = vaultHalfOf(ways, c);
                                return (
                                    <View key={`half-${c.url}`} style={s.copy} testID="ways-back-vault-half">
                                        <Text style={s.copyName}>{t(WAYS_BACK_LINES.vaultHalf, { community: c.name })}</Text>
                                        <Text style={s.small}>{t(WAYS_BACK_LINES.vaultHalfLine)}</Text>
                                        {half?.since && <Text style={s.small}>{t('Kept since {date}', { date: dayWords(half.since) })}</Text>}
                                        {removeButton({ at: 'admins', url: c.url }, t('Remove the copy at {community} that its admins can bring you back from', { community: c.name }))}
                                    </View>
                                );
                            })}
                            {strayVaultHalves(ways).map(h => (
                                <View key={h.ref} style={s.copy} testID="ways-back-vault-half-stray">
                                    <Text style={s.copyName}>{t(WAYS_BACK_LINES.vaultHalfStray)}</Text>
                                    <Text style={s.small}>{t(WAYS_BACK_LINES.vaultHalfAlone)}</Text>
                                    {h.since && <Text style={s.small}>{t('Kept since {date}', { date: dayWords(h.since) })}</Text>}
                                    {removeButton({ at: 'vault-half', ref: h.ref }, t(WAYS_BACK_LINES.vaultHalfStray))}
                                </View>
                            ))}
                            {unplacedVaultHalves(ways).map(h => (
                                <View key={h.ref} style={s.copy} testID="ways-back-vault-half-not-placed">
                                    <Text style={s.copyName}>{t(WAYS_BACK_LINES.vaultHalfNotPlaced)}</Text>
                                    <Text style={s.small}>{t(WAYS_BACK_LINES.vaultHalfNotPlacedLine)}</Text>
                                    {h.since && <Text style={s.small}>{t('Kept since {date}', { date: dayWords(h.since) })}</Text>}
                                </View>
                            ))}
                        </View>
                    )}

                    {ways.communities.length > 0 && (
                        <View style={s.section}>
                            <Text style={s.heading} accessibilityRole="header">{t(WAYS_BACK_LINES.communities)}</Text>
                            {ways.communities.map(c => {
                                const waiting = ways.pending.filter(p => sameCommunity(p.url, c.url)).map(p => p.provider);
                                const kept = (c.status?.providers ?? []).filter(p => !waiting.includes(p));
                                const admins = c.status?.adminsCopy;
                                const adminsSince = admins?.since ? new Date(admins.since) : null;
                                const cantOpen = admins ? null : c.status?.adminsCopyUnopenable ?? null;
                                const cantOpenSince = cantOpen?.since ? new Date(cantOpen.since) : null;
                                return (
                                    <View key={c.url} style={s.community}>
                                        <Text style={s.communityName}>{c.name}</Text>
                                        {!c.status && <Text style={s.line}>{t(WAYS_BACK_LINES.communityUnknown)}</Text>}
                                        {c.status && kept.length === 0 && waiting.length === 0 && !admins && !cantOpen && <Text style={s.line}>{t(WAYS_BACK_LINES.keepsNone)}</Text>}
                                        {cantOpen && (
                                            <View style={s.copy} testID="ways-back-admins-cant-open">
                                                <Text style={s.copyName}>{t(WAYS_BACK_LINES.admins)}</Text>
                                                {cantOpenSince && Number.isFinite(cantOpenSince.getTime()) && (
                                                    <Text style={s.small}>{t('Kept since {date}', { date: formatDate(cantOpenSince, 'day-month-year') })}</Text>
                                                )}
                                                <Text style={s.small}>{t(WAYS_BACK_LINES.adminsCantOpen)}</Text>
                                                {removeButton({ at: 'admins', url: c.url }, t("Remove the copy at {community} that its server can't open", { community: c.name }))}
                                            </View>
                                        )}
                                        {admins && (
                                            <View style={s.copy} testID="ways-back-admins-copy">
                                                <Text style={s.copyName}>{t(WAYS_BACK_LINES.admins)}</Text>
                                                <Text style={s.small}>
                                                    {admins.placement !== 'shared'
                                                        ? t(WAYS_BACK_LINES.adminsLine)
                                                        : otherHalfMissing(ways, c)
                                                            ? t(WAYS_BACK_LINES.adminsHalfMissing)
                                                            : t(WAYS_BACK_LINES.adminsHalfLine)}
                                                </Text>
                                                {adminsSince && Number.isFinite(adminsSince.getTime()) && (
                                                    <Text style={s.small}>{t('Kept since {date}', { date: formatDate(adminsSince, 'day-month-year') })}</Text>
                                                )}
                                                {removeButton({ at: 'admins', url: c.url }, t('Remove the copy at {community} that its admins can bring you back from', { community: c.name }))}
                                            </View>
                                        )}
                                        {kept.map((p: SsoProvider) => (
                                            <View key={p} style={s.copy}>
                                                <Text style={s.copyName}>{SSO_PROVIDER_NAMES[p]}</Text>
                                                {removeButton({ at: 'community', url: c.url, provider: p }, t('Remove the {provider} copy at {community}', { provider: SSO_PROVIDER_NAMES[p], community: c.name }))}
                                            </View>
                                        ))}
                                        {waiting.map((p: SsoProvider) => (
                                            <View key={`waiting-${p}`} style={s.copy}>
                                                <Text style={s.copyName}>{SSO_PROVIDER_NAMES[p]}</Text>
                                                <Text style={s.small}>{t(WAYS_BACK_LINES.notYetRemoved)}</Text>
                                            </View>
                                        ))}
                                    </View>
                                );
                            })}
                        </View>
                    )}

                    {wordsOnly(ways) && (
                        <Text style={s.wordsOnly}>
                            {hasWords || writtenDown
                                ? t('Nothing is kept anywhere this phone can ask. Your 12 words are your way back. Without them, an admin can move your Beans and name to a new key, one community at a time.')
                                : t('Nothing is kept anywhere this phone can ask, and this phone has no copy of your 12 words. If you lose this phone without them, an admin can move your Beans and name to a new key, one community at a time.')}
                        </Text>
                    )}

                    {result.length > 0 && (
                        <View style={s.result} accessibilityLiveRegion="polite">
                            {result.map(line => <Text key={line} style={s.resultLine}>{line}</Text>)}
                        </View>
                    )}

                    {(knownCopies(ways).length > 0 || unopenableAdminsCopies(ways).length > 0 || !everyoneAnswered(ways)) && (
                        <Pressable
                            style={[s.everything, busy && s.disabled]}
                            disabled={busy}
                            onPress={onRemoveEverything}
                            accessibilityRole="button"
                        >
                            {busy ? <ActivityIndicator color={colors.feedback.danger.fg} /> : <Text style={s.everythingText}>{t(WAYS_BACK_LINES.removeEverything)}</Text>}
                        </Pressable>
                    )}

                    {/* The reverse (design §5.1): nothing is lost by having left. Not where the community keeps no copies
                        (design §5.3): there the words are the way back, and what is listed was made elsewhere. */}
                    {noCopiesHere ? (
                        <>
                            <Text style={s.small} testID="ways-back-no-copies-here">{t(WAYS_BACK_LINES.keepsNoCopies)}</Text>
                            <Text style={s.small}>{t(WAYS_BACK_LINES.madeElsewhere)}</Text>
                        </>
                    ) : (
                        <>
                            <Text style={s.small}>{t(WAYS_BACK_LINES.linkSignInLine)}</Text>
                            <Pressable style={s.secondary} onPress={onLinkSignIn} accessibilityRole="button">
                                <Text style={s.secondaryText}>{t(WAYS_BACK_LINES.linkSignIn)}</Text>
                            </Pressable>
                        </>
                    )}
                </>
            )}
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
    title: { fontSize: 18, fontWeight: '700', color: colors.text.heading, marginBottom: 6 },
    intro: { fontSize: 14, lineHeight: 20, color: colors.text.secondary, marginBottom: 12 },
    section: { borderTopWidth: 1, borderTopColor: colors.border.default, paddingTop: 12, marginTop: 4, marginBottom: 12 },
    heading: { fontSize: 16, fontWeight: '700', color: colors.text.heading, marginBottom: 6 },
    line: { fontSize: 14, lineHeight: 20, color: colors.text.body, marginBottom: 6 },
    small: { fontSize: 13, lineHeight: 18, color: colors.text.secondary, marginBottom: 6 },
    // The say-so: a row whose words wrap beside the box, 44 dp tall at least.
    tick: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, marginBottom: 4 },
    // The box's edge in the words' own grey: a control's outline needs 3:1, which border.strong is not.
    box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: colors.text.secondary, alignItems: 'center', justifyContent: 'center' },
    boxOn: { backgroundColor: colors.brand.fill, borderColor: colors.brand.fill },
    boxMark: { color: colors.text.onBrand, fontSize: 14, fontWeight: '800' },
    tickText: { flex: 1, fontSize: 14, lineHeight: 20, color: colors.text.body },
    community: { marginBottom: 8 },
    communityName: { fontSize: 15, fontWeight: '700', color: colors.text.heading, marginBottom: 4 },
    copy: { backgroundColor: colors.surface.subtle, borderWidth: 1, borderColor: colors.border.default, borderRadius: 10, padding: 12, marginBottom: 8 },
    copyName: { fontSize: 15, fontWeight: '600', color: colors.text.heading, marginBottom: 4 },
    // One account's copy among several of a sign-in: its dates kept together, apart from the next account's.
    account: { borderLeftWidth: 2, borderLeftColor: colors.border.strong, paddingLeft: 8, marginBottom: 4 },
    remove: {
        alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 8, borderWidth: 1,
        borderColor: colors.feedback.danger.border, marginTop: 2,
    },
    removeText: { fontSize: 14, fontWeight: '700', color: colors.feedback.danger.fg },
    everything: {
        minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: colors.feedback.danger.border, backgroundColor: colors.feedback.danger.bg,
        alignItems: 'center', justifyContent: 'center', padding: 12, marginTop: 4, marginBottom: 16,
    },
    everythingText: { fontSize: 15, fontWeight: '700', color: colors.feedback.danger.fg, textAlign: 'center' },
    secondary: {
        minHeight: 44, borderRadius: 10, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card,
        alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 10, marginBottom: 8,
    },
    secondaryText: { fontSize: 14, fontWeight: '600', color: colors.text.heading, textAlign: 'center' },
    wordsOnly: { fontSize: 14, lineHeight: 20, color: colors.text.body, backgroundColor: colors.feedback.info.bg, borderColor: colors.feedback.info.border, borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 12 },
    result: { backgroundColor: colors.surface.subtle, borderRadius: 10, padding: 12, marginBottom: 12 },
    // A keeper per line, apart enough to read as separate answers.
    resultLine: { fontSize: 14, lineHeight: 20, color: colors.text.body, marginBottom: 8 },
    disabled: { opacity: 0.5 },
});
