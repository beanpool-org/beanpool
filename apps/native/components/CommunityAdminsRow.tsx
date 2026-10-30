/**
 * Account Protection's third way back: "Your community's admins" (vault rethink VR3, community-held placement;
 * scratch/fable-design/DESIGN-vault-rethink-fable.md §4.3 and §4.5). Turn on, after the phone's lock; On since when;
 * Remove. Shown only where the community keeps copies itself and never in the global community (utils/community-copy.ts
 * offersCommunityCopy), and also wherever the community already keeps this member's copy (the rule may have moved since:
 * the copy is the member's until they remove it, design §4.4).
 *
 * Says who can open the copy, plainly: the community's server, so the people who run it; nobody else. Never a false
 * success: On only once the server answered that it keeps the copy. Holds at 320 dp and 1.3× text: every line wraps.
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
import { onCommunitySwitched } from '../utils/community-switch';
import {
    communityCopyStatus, offersCommunityCopy, removeCommunityCopy, turnOnCommunityCopy, type CommunityCopyStatus,
} from '../utils/community-copy';
import { keyLineWords } from './key-lines';

/** The row's words (design §4.5 and §4.4), through t(). */
export const COMMUNITY_ADMINS_ROW = {
    title: word("👥 Your community's admins"),
    body: word("Go and see an admin in person and they can bring your account back: the same key, Beans and all. No Google or Apple needed. Your community's server keeps the locked copy. The people who run it can open it; nobody else."),
    turnOn: word('Turn on'),
    on: word('On in {community} since {date}'),
    remove: word('Remove'),
    lockReason: word("Confirm it's you to let your community's admins bring your account back."),
    removeTitle: word('Remove this way back?'),
    removeBody: word("{community}'s server deletes its copy of your account. Your admins can no longer bring you back; your 12 words still work."),
    keep: word('Keep it'),
    noLongerOffered: word('{community} no longer offers this to new members. Your copy there still works until you remove it.'),
    turnedOn: word('On. If you lose this phone, go and see one of your admins with your new phone.'),
} as const;

/**
 * This phone turned it on at this community: the row asks the community about the copy only then, or where it is
 * offered, so no other community is asked on every visit to Account Protection.
 */
const turnedOnKey = (url: string): string => `beanpool_community_copy_on_${url}`;

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
        buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 },
        primary: { minHeight: 44, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, backgroundColor: c.brand.fill, alignItems: 'center', justifyContent: 'center' },
        primaryText: { color: c.text.inverse, fontWeight: 'bold', fontSize: 14, textAlign: 'center' },
        secondary: { minHeight: 44, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: c.border.strong, backgroundColor: c.surface.card, alignItems: 'center', justifyContent: 'center' },
        secondaryText: { color: c.text.body, fontWeight: '600', fontSize: 14, textAlign: 'center' },
    }));
    const [url, setUrl] = useState<string | null>(null);
    const [offered, setOffered] = useState(false);
    const [status, setStatus] = useState<CommunityCopyStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [justOn, setJustOn] = useState(false);
    // Which key at which community the state above was read for. Settings stays mounted across a community switch, so a
    // new one starts from nothing: the community left's "On", note or error never shows as the one now in use's (where
    // Remove would ask it to delete a copy it never held), and an answer from the one left never lands after the switch.
    const readFor = useRef<string | null>(null);

    const read = useCallback(async () => {
        const at = await getAnchorUrl().catch(() => null);
        const scope = at && identity ? `${identity.publicKey} ${at}` : null;
        if (scope !== readFor.current) {
            readFor.current = scope;
            setOffered(false);
            setStatus(null);
            setJustOn(false);
            setError(null);
        }
        setUrl(at);
        if (!at) return;
        const rule = await copiesRuleForScreen(at).catch(() => null);
        if (readFor.current !== scope) return;
        const offeredHere = offersCommunityCopy(at, rule);
        setOffered(offeredHere);
        const turnedOnHere = await AsyncStorage.getItem(turnedOnKey(at)).catch(() => null);
        if (!identity || (!offeredHere && !turnedOnHere)) return;
        const now = await communityCopyStatus(at, identity);
        if (readFor.current !== scope) return;
        setStatus(now);
        if (now && !now.kept && turnedOnHere) await AsyncStorage.removeItem(turnedOnKey(at)).catch(() => {});
    }, [identity]);
    // Asked again each time Account Protection comes into view: "Where your account can be brought back from" removes it too.
    useFocusEffect(useCallback(() => { void read(); }, [read]));
    // And at once on a switch made while Settings shows (its Advanced switch stays on this screen).
    useEffect(() => onCommunitySwitched(() => { void read(); }), [read]);

    if (!url || !identity) return null;
    const kept = status?.kept === true;
    // Not offered and nothing kept here: nothing to show (the global community, "BeanPool's key vault", "Nowhere").
    if (!offered && !kept) return null;
    const place = placeOf(url, communityName);

    const turnOn = async () => {
        setError(null);
        setJustOn(false);
        if (!(await authenticateUser(t(COMMUNITY_ADMINS_ROW.lockReason)))) return;
        setBusy(true);
        try {
            await turnOnCommunityCopy(url, identity);
            await AsyncStorage.setItem(turnedOnKey(url), '1').catch(() => {});
            setStatus(await communityCopyStatus(url, identity));
            setJustOn(true);
        } catch (e) {
            setError(keyLineWords(e instanceof Error ? e.message : String(e)));
        } finally {
            setBusy(false);
        }
    };

    const remove = () => {
        Alert.alert(t(COMMUNITY_ADMINS_ROW.removeTitle), t(COMMUNITY_ADMINS_ROW.removeBody, { community: place }), [
            { text: t(COMMUNITY_ADMINS_ROW.keep), style: 'cancel' },
            {
                text: t(COMMUNITY_ADMINS_ROW.remove), style: 'destructive', onPress: async () => {
                    setBusy(true);
                    setError(null);
                    setJustOn(false);
                    try {
                        await removeCommunityCopy(url, identity);
                        await AsyncStorage.removeItem(turnedOnKey(url)).catch(() => {});
                        setStatus(await communityCopyStatus(url, identity));
                    } catch (e) {
                        setError(keyLineWords(e instanceof Error ? e.message : String(e)));
                    } finally {
                        setBusy(false);
                    }
                },
            },
        ]);
    };

    const since = status?.since ? new Date(status.since) : null;
    return (
        <View style={styles.row} testID="community-admins-row">
            <Text style={styles.title} accessibilityRole="header">{t(COMMUNITY_ADMINS_ROW.title)}</Text>
            <Text style={styles.body}>{t(COMMUNITY_ADMINS_ROW.body)}</Text>
            {kept && (
                <Text style={styles.state} testID="community-admins-on">
                    {t(COMMUNITY_ADMINS_ROW.on, { community: place, date: since && Number.isFinite(since.getTime()) ? formatDate(since, 'day-month-year') : '…' })}
                </Text>
            )}
            {kept && !offered && <Text style={styles.note}>{t(COMMUNITY_ADMINS_ROW.noLongerOffered, { community: place })}</Text>}
            {justOn && kept && <Text style={styles.note} accessibilityLiveRegion="polite">{t(COMMUNITY_ADMINS_ROW.turnedOn)}</Text>}
            {error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}
            <View style={styles.buttons}>
                {busy ? (
                    <ActivityIndicator />
                ) : kept ? (
                    <Pressable style={styles.secondary} onPress={remove} accessibilityRole="button" testID="community-admins-remove">
                        <Text style={styles.secondaryText}>{t(COMMUNITY_ADMINS_ROW.remove)}</Text>
                    </Pressable>
                ) : (
                    <Pressable style={styles.primary} onPress={turnOn} accessibilityRole="button" testID="community-admins-turn-on">
                        <Text style={styles.primaryText}>{t(COMMUNITY_ADMINS_ROW.turnOn)}</Text>
                    </Pressable>
                )}
            </View>
        </View>
    );
}
