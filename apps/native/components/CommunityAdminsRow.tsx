/**
 * Account Protection's third way back: "Your community's admins" (vault rethink VR3, community-held placement, and VR4,
 * shared placement; scratch/fable-design/DESIGN-vault-rethink-fable.md §4.3 and §4.5). Turn on, after the phone's lock; On
 * since when; Remove. Shown where the community's server says it offers it (its status answer's `offered`: its rule is
 * "this server" and anyone can't walk in; or `sharedOffered`, its rule the key vault, in a build that has one), and also
 * wherever the community already keeps this member's copy (the rule may have moved since: the copy is the member's until
 * they remove it, design §4.4). The phone asks only where its rule offers one of the two and it isn't the global community
 * (utils/community-copy.ts offersCommunityCopy), or where it turned it on.
 *
 * **Nothing leaves on a guess.** The rule as this phone read it only says whom to ask. What the row offers is the server's
 * own answer to the status call signed by the member's key: until it has answered, the row offers nothing, and with no
 * answer under the key vault's rule it stays that way. And Turn on asks that again at the tap ({@link offerIn}), and
 * sends what the row's words said a tap makes, or nothing: asking again can only narrow what goes. If the answer has
 * moved, the row redraws with its words and the member decides having read them, so a member who read "half each" never
 * sends the whole key. The copy and its whole key go only where the server says it keeps whole copies: a server that
 * refuses them has already been handed the key, which under the key vault's rule ends "the node alone opens nothing".
 * Where the rule reads "this server" and the server gave no answer, Turn on stays, as it always has, to try again: it
 * asks first, and with still no answer it says so and nothing has left the phone.
 *
 * Says who can open the copy, plainly: the community's server, so the people who run it; nobody else. Never a false
 * success: On only once the server answered that it keeps the copy and can open it. A copy it keeps but can't open
 * (the key it locks copies with gone, or another in its place) is said as that, with what can be done: never On.
 * Holds at 320 dp and 1.3× text: every line wraps.
 *
 * The shared placement (vault rethink VR4, utils/community-recovery.ts): where the community's rule is BeanPool's key vault,
 * in a build that has one, the same row makes a copy the vault and the community keep half each, and says so: it takes
 * both, and it takes a day. On only when both keep the very same copy; begun on one side only, it says "Not finished: tap
 * to try again". A vault that can't be asked just now never turns an On off, and a slow one holds nothing up: what the
 * community said is shown while the vault is asked.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import { formatDate, t, word } from '@beanpool/core';
import { useIdentity } from '../app/IdentityContext';
import { useStyles } from '../app/ThemeContext';
import { authenticateUser } from '../utils/LocalAuth';
import { anchorUrl as getAnchorUrl } from '../utils/node-post';
import { copiesRuleForScreen } from '../utils/copies-rule';
import { hasVault } from '../utils/vault-config';
import { removeSharedCopy, sharedCopySide, sharedCopyState, turnOnSharedCopy, type SharedCopySide } from '../utils/community-recovery';
import { onCommunitySwitched } from '../utils/community-switch';
import {
    COMMUNITY_COPY_TEXT, communityCopyStatus, offersCommunityCopy, removeCommunityCopy, turnOnCommunityCopy, type CommunityCopyStatus,
} from '../utils/community-copy';
import { keyLineWords } from './key-lines';

/** The row's words (design §4.5 and §4.4), through t(). */
export const COMMUNITY_ADMINS_ROW = {
    title: word("👥 Your community's admins"),
    body: word("Go and see an admin in person and they can bring your account back: the same key, Beans and all. No Google or Apple needed. Your community's server keeps the locked copy. The people who run it can open it; nobody else."),
    // The shared placement (design §4.5).
    bodyShared: word("Go and see an admin in person and they can bring your account back: the same key, Beans and all. No Google or Apple needed. Your community's server and BeanPool's key vault each keep half of a locked copy; it takes both, and it takes a day, so your other phones can stop it."),
    notFinished: word('Not finished: tap to try again.'),
    removeBodyShared: word("{community}'s server and BeanPool's key vault delete their halves of your copy. Your admins can no longer bring you back; your 12 words still work."),
    turnOn: word('Turn on'),
    on: word('On in {community} since {date}'),
    remove: word('Remove'),
    lockReason: word("Confirm it's you to let your community's admins bring your account back."),
    removeTitle: word('Remove this way back?'),
    removeBody: word("{community}'s server deletes its copy of your account. Your admins can no longer bring you back; your 12 words still work."),
    keep: word('Keep it'),
    noLongerOffered: word('{community} no longer offers this to new members. Your copy there still works until you remove it.'),
    turnedOn: word('On. If you lose this phone, go and see one of your admins with your new phone.'),
    // A copy the community's server keeps but can't open now (its status answer's `unopenable`): never On.
    cantOpen: word("Kept in {community} since {date}, but its server can't open it now, so your admins can't bring you back with it."),
    cantOpenKeyMissing: word('The server is missing the key it locks these copies with. The people who run it can put that key back. Until then, your 12 words still work.'),
    cantOpenTurnOnAgain: word('It was locked with a key the server no longer has. Turn it on again to make a copy it can open.'),
    cantOpenNotOffered: word('It was locked with a key the server no longer has, and {community} no longer makes new copies. You can remove it; your 12 words still work.'),
    turnOnAgain: word('Turn on again'),
    removeCopyTitle: word('Remove this copy?'),
    removeCopyBody: word("{community}'s server deletes the copy it can't open. Your 12 words still work."),
} as const;

/**
 * This phone turned it on at this community: the row asks the community about the copy only then, or where it is
 * offered, so no other community is asked on every visit to Account Protection.
 */
const turnedOnKey = (url: string): string => `beanpool_community_copy_on_${url}`;

/**
 * What the community's own answer lets this phone send: its whole copy where it says it keeps those, half of a shared copy
 * where it says it keeps those and this build can reach the vault (with the key its vouchers are signed with), else
 * nothing. No answer is nothing: the rule as this phone read it is never a reason to send.
 */
function offerIn(status: CommunityCopyStatus | null): 'whole' | 'shared' | null {
    if (status?.offered) return 'whole';
    return status?.sharedOffered && hasVault() && status.nodeKey ? 'shared' : null;
}

/** The community's name as the row says it: its saved name, else its address. */
function placeOf(url: string, name?: string | null): string {
    if (name) return name;
    try { return new URL(url).host; } catch { return url; }
}

export function CommunityAdminsRow({ communityName }: { communityName?: string | null }) {
    const { identity } = useIdentity();
    const styles = useStyles(({ colors: c }) => StyleSheet.create({
        row: { marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: c.border.default },
        title: { color: c.text.heading, fontSize: 16, fontWeight: 'bold', marginBottom: 8 },
        body: { color: c.text.secondary, fontSize: 13, lineHeight: 18 },
        state: { color: c.text.body, fontSize: 14, fontWeight: '600', lineHeight: 20, marginTop: 10 },
        note: { color: c.text.secondary, fontSize: 13, lineHeight: 18, marginTop: 8 },
        error: { color: c.feedback.danger.fg, fontSize: 13, lineHeight: 18, marginTop: 8 },
        cantOpen: { marginTop: 10, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: c.feedback.warning.border, backgroundColor: c.feedback.warning.bg },
        cantOpenState: { color: c.feedback.warning.fg, fontSize: 14, fontWeight: '600', lineHeight: 20 },
        cantOpenNote: { color: c.text.body, fontSize: 13, lineHeight: 18, marginTop: 6 },
        buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 },
        primary: { minHeight: 44, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, backgroundColor: c.brand.fill, alignItems: 'center', justifyContent: 'center' },
        primaryText: { color: c.text.inverse, fontWeight: 'bold', fontSize: 14, textAlign: 'center' },
        secondary: { minHeight: 44, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: c.border.strong, backgroundColor: c.surface.card, alignItems: 'center', justifyContent: 'center' },
        secondaryText: { color: c.text.body, fontWeight: '600', fontSize: 14, textAlign: 'center' },
    }));
    const [url, setUrl] = useState<string | null>(null);
    // The server gave no answer and the rule, as this phone read it, is "this server": Turn on stays, to try again (`turnOn`
    // asks first). Never under the key vault's rule, and not while the server is still being asked.
    const [noAnswerHere, setNoAnswerHere] = useState(false);
    const [status, setStatus] = useState<CommunityCopyStatus | null>(null);
    // How the key vault's side of a shared copy stands against the community's (null: none is asked about here).
    const [side, setSide] = useState<SharedCopySide | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [justOn, setJustOn] = useState(false);
    // Which key at which community the state above was read for. Settings stays mounted across a community switch, so a
    // new one starts from nothing: the community left's "On", note or error never shows as the one now in use's (where
    // Remove would ask it to delete a copy it never held), and an answer from the one left never lands after the switch.
    const readFor = useRef<string | null>(null);
    // Each read has a turn, and only the newest speaks: the status lands before the vault's answer, so a read still waiting
    // on a slow vault could otherwise lay what it found over a Turn on that finished meanwhile.
    const turn = useRef(0);

    const read = useCallback(async () => {
        const mine = ++turn.current;
        const at = await getAnchorUrl().catch(() => null);
        if (mine !== turn.current) return;
        const scope = at && identity ? `${identity.publicKey} ${at}` : null;
        if (scope !== readFor.current) {
            readFor.current = scope;
            setNoAnswerHere(false);
            setStatus(null);
            setSide(null);
            setJustOn(false);
            setError(null);
        }
        setUrl(at);
        if (!at) return;
        const rule = await copiesRuleForScreen(at).catch(() => null);
        if (mine !== turn.current) return;
        const askHere = offersCommunityCopy(at, rule);
        const turnedOnHere = await AsyncStorage.getItem(turnedOnKey(at)).catch(() => null);
        if (mine !== turn.current) return;
        if (!identity || (!askHere && !turnedOnHere)) {
            setNoAnswerHere(false);
            return;
        }
        const now = await communityCopyStatus(at, identity);
        if (mine !== turn.current) return;
        setNoAnswerHere(!now && askHere && rule === 'server');
        // No answer takes nothing away: what this community last said stands, with any sentence beside it (Turn on asks again).
        if (!now) return;
        // Said before the vault is asked, which can take 20 s: its answer only adds to this one.
        setStatus(now);
        const nowSide = hasVault() && (now.sharedOffered || now.placement === 'shared') ? await sharedCopySide(identity, now) : null;
        if (mine !== turn.current) return;
        setSide(nowSide);
        // Forgotten only once nothing is kept at all: a copy the server can't open, or half of one, is still there to say and remove.
        if (!now.kept && !now.unopenable && nowSide !== 'differs' && turnedOnHere) await AsyncStorage.removeItem(turnedOnKey(at)).catch(() => {});
    }, [identity]);
    // Asked again each time Account Protection comes into view: "Where your account can be brought back from" removes it too.
    useFocusEffect(useCallback(() => { void read(); }, [read]));
    // And at once on a switch made while Settings shows (its Advanced switch stays on this screen).
    useEffect(() => onCommunitySwitched(() => { void read(); }), [read]);

    if (!url || !identity) return null;
    // The shared placement is this community's offer, in this build, once its server has said the key it signs with.
    const offer = offerIn(status);
    const sharedOffer = offer === 'shared';
    const sharedState = sharedCopyState(status, side);
    const unfinished = sharedState === 'unfinished';
    // What it keeps decides the row's words and its Remove; only a member with nothing here goes by the offer.
    const shared = status?.kept ? status.placement === 'shared' : sharedOffer || unfinished;
    // On means it can bring the member back now: a whole copy, or both halves of one copy.
    const kept = status?.kept === true && !unfinished;
    const unopenable = status?.kept ? null : status?.unopenable ?? null;
    // The server's own word on whether it offers this (a door anyone can walk through is refused there, whatever the
    // rule). Until it has answered, nothing; with no answer, only what `noAnswerHere` says.
    const offered = status ? offer !== null : noAnswerHere;
    // Not offered and nothing kept here: nothing to show (the global community, a build with no vault, "Nowhere").
    if (!offered && !kept && !unopenable && !unfinished) return null;
    const place = placeOf(url, communityName);
    // What the row's words say a tap makes: a tap sends that or nothing (`turnOn`). Half a pair kept where the rule has moved
    // to "this server" has only Remove: its words are half and half, and the offer is the whole key.
    const promised = shared ? 'shared' : 'whole';
    // Turning it on again makes a copy the server can open, where it has its key and offers it; with its key gone, it
    // can't keep one (the server refuses), so only Remove is offered.
    const canTurnOn = offered && !kept && unopenable?.reason !== 'recovery_seal_key_missing' && (!status || offer === promised);

    const turnOn = async () => {
        setError(null);
        setJustOn(false);
        if (!(await authenticateUser(t(COMMUNITY_ADMINS_ROW.lockReason)))) return;
        setBusy(true);
        let sharedBegun = false;
        try {
            // What goes must be what the server offers now and what the member read: a rule read earlier, or an answer from
            // before the screen was left open, is a guess, and a whole key sent on one can't be taken back. If the two
            // differ nothing is sent, and the read below draws what it says now, for the member to read.
            const now = await communityCopyStatus(url, identity);
            if (!now) throw new Error(COMMUNITY_COPY_TEXT.unreachable);
            if (offerIn(now) !== promised) throw new Error(COMMUNITY_COPY_TEXT.notKept);
            if (promised === 'whole') {
                await turnOnCommunityCopy(url, identity);
            } else {
                sharedBegun = true;
                await turnOnSharedCopy(url, identity, now.nodeKey as string);
            }
            await AsyncStorage.setItem(turnedOnKey(url), '1').catch(() => {});
            setJustOn(true);
        } catch (e) {
            // One side may have it already: remembered, so the row says "Not finished" from now on, not nothing.
            if (sharedBegun) await AsyncStorage.setItem(turnedOnKey(url), '1').catch(() => {});
            setError(keyLineWords(e instanceof Error ? e.message : String(e)));
        } finally {
            await read();
            setBusy(false);
        }
    };

    const remove = () => {
        // A copy the server can't open is no way back now: removing it takes none away, and the ask says so.
        const [title, body] = unopenable
            ? [t(COMMUNITY_ADMINS_ROW.removeCopyTitle), t(COMMUNITY_ADMINS_ROW.removeCopyBody, { community: place })]
            : [t(COMMUNITY_ADMINS_ROW.removeTitle), shared
                ? t(COMMUNITY_ADMINS_ROW.removeBodyShared, { community: place })
                : t(COMMUNITY_ADMINS_ROW.removeBody, { community: place })];
        Alert.alert(title, body, [
            { text: t(COMMUNITY_ADMINS_ROW.keep), style: 'cancel' },
            {
                text: t(COMMUNITY_ADMINS_ROW.remove), style: 'destructive', onPress: async () => {
                    setBusy(true);
                    setError(null);
                    setJustOn(false);
                    try {
                        if (shared) await removeSharedCopy(url, identity, status?.nodeKey ?? null);
                        else await removeCommunityCopy(url, identity);
                        await AsyncStorage.removeItem(turnedOnKey(url)).catch(() => {});
                        // What it last said is over: never On on an answer from before the removal, if the read below gets none.
                        setStatus(null);
                        setSide(null);
                    } catch (e) {
                        setError(keyLineWords(e instanceof Error ? e.message : String(e)));
                    } finally {
                        await read();
                        setBusy(false);
                    }
                },
            },
        ]);
    };

    const dayOf = (iso: string | null | undefined): string => {
        const d = iso ? new Date(iso) : null;
        return d && Number.isFinite(d.getTime()) ? formatDate(d, 'day-month-year') : '…';
    };
    return (
        <View style={styles.row} testID="community-admins-row">
            <Text style={styles.title} accessibilityRole="header">{t(COMMUNITY_ADMINS_ROW.title)}</Text>
            <Text style={styles.body}>{shared ? t(COMMUNITY_ADMINS_ROW.bodyShared) : t(COMMUNITY_ADMINS_ROW.body)}</Text>
            {kept && (
                <Text style={styles.state} testID="community-admins-on">
                    {t(COMMUNITY_ADMINS_ROW.on, { community: place, date: dayOf(status?.since) })}
                </Text>
            )}
            {unfinished && <Text style={styles.state} testID="community-admins-unfinished">{t(COMMUNITY_ADMINS_ROW.notFinished)}</Text>}
            {unopenable && (
                <View style={styles.cantOpen} testID="community-admins-cant-open">
                    <Text style={styles.cantOpenState}>{t(COMMUNITY_ADMINS_ROW.cantOpen, { community: place, date: dayOf(unopenable.since) })}</Text>
                    <Text style={styles.cantOpenNote}>
                        {unopenable.reason === 'recovery_seal_key_missing'
                            ? t(COMMUNITY_ADMINS_ROW.cantOpenKeyMissing)
                            : offered
                                ? t(COMMUNITY_ADMINS_ROW.cantOpenTurnOnAgain)
                                : t(COMMUNITY_ADMINS_ROW.cantOpenNotOffered, { community: place })}
                    </Text>
                </View>
            )}
            {kept && !offered && <Text style={styles.note}>{t(COMMUNITY_ADMINS_ROW.noLongerOffered, { community: place })}</Text>}
            {justOn && kept && <Text style={styles.note} accessibilityLiveRegion="polite">{t(COMMUNITY_ADMINS_ROW.turnedOn)}</Text>}
            {error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}
            <View style={styles.buttons}>
                {busy ? (
                    <ActivityIndicator />
                ) : (
                    <>
                        {canTurnOn && (
                            <Pressable style={styles.primary} onPress={turnOn} accessibilityRole="button" testID="community-admins-turn-on">
                                <Text style={styles.primaryText}>{unopenable || unfinished ? t(COMMUNITY_ADMINS_ROW.turnOnAgain) : t(COMMUNITY_ADMINS_ROW.turnOn)}</Text>
                            </Pressable>
                        )}
                        {(kept || unopenable || unfinished) && (
                            <Pressable style={styles.secondary} onPress={remove} accessibilityRole="button" testID="community-admins-remove">
                                <Text style={styles.secondaryText}>{t(COMMUNITY_ADMINS_ROW.remove)}</Text>
                            </Pressable>
                        )}
                    </>
                )}
            </View>
        </View>
    );
}
