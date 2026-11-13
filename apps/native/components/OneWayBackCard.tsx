import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
// Static colours: only the default of the `colors` prop. Every caller passes its screen's set (measured 12 Nov 2026, colour themes T2), so a colour set reaches it through the prop.
import { colors as lightColors, type AppColors } from '../constants/colors';
import { useIdentity } from '../app/IdentityContext';
import { LinkSignInSheet } from './LinkSignInSheet';
import { QUIET_OPACITY, quietWrapperProps } from './home/quiet';
import {
    askOneWayBackStandingShared,
    dismissOneWayBack,
    isGlobalInUse,
    noteOneWayBackAsked,
    oneWayBackAskNow,
    oneWayBackCommunity,
    oneWayBackFromNode,
    oneWayBackPlace,
    readOneWayBack,
    readOneWayBackAsked,
    standingFromAsked,
    withAccountDismissal,
    type OneWayBack,
    type OneWayBackAsked,
    type OneWayBackPlace,
    type OneWayBackStanding,
} from '../utils/one-way-back';
import { anchorUrl } from '../utils/node-post';
import { vaultCopyKnown } from '../utils/vault';
import { GLOBAL_NODE_URL } from '../utils/global-node-url';
import { getSavedNodes } from '../utils/nodes';
import { communityName } from '../utils/community-name';
import { keepWords } from '../utils/words-kept';
import { t, word } from '@beanpool/core';

/**
 * utils/one-way-back.ts ONE_WAY_BACK_TEXT, as word() keys shown through t() (that file signs its reads, so it never reaches
 * the words layer). The same English: utils/__tests__/rest-words-render.test.ts holds the two equal.
 */
export const ONE_WAY_BACK_LINES = {
    title: word('Your account has one way back'),
    body: word('Your account has one way back: your 12 words. Check you still have them, or add a sign-in.'),
    addSignIn: word('Add a sign-in'),
    checkWords: word('Show my 12 words'),
    checked: word('I still have my 12 words'),
    notNow: word('Not now'),
} as const;

/**
 * The card's words for every other member whose 12 words are the only way back (DESIGN-home-default-fable.md §2.5): "one
 * way back" isn't true where an admin can set a member up again with a new key. The long form where a sign-in can be
 * added, the short one where it can't (the node takes none from them). The 12-words door's card keeps its own words.
 */
export const WORDS_HOW_BACK_LINES = {
    withSignIn: word('Your 12 words are how you get back in. Check you still have them, or add a sign-in.'),
    noSignIn: word('Your 12 words are how you get back in. Check you still have them.'),
} as const;

const sameCommunity = (a: string, b: string) => a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase();

/** Where the landing card's actions are on screen (window coordinates, dp), for the floating "+ ADD POST" button. */
export interface OneWayBackActionsAt {
    top: number;
    bottom: number;
}

/**
 * "Your account has one way back: your 12 words" (two-doors design §2.5, utils/one-way-back.ts), for a member who joined
 * the global community with 12 words. A plain card, never a dot and never a gate.
 *
 * - `landing`: the card on the landing screen while utils/one-way-back.ts says `card`: Add a sign-in, Show my 12 words
 *   (Settings' Account Protection, behind the phone's lock), and Not now (it comes back once after the first post and
 *   once after a week).
 * - `settings`: Account Protection's block until a sign-in is added or the member says they still have their words;
 *   after "I still have my 12 words", adding a sign-in is still offered there, without the warning.
 *
 * Who it is for is the community's own word (`GET /api/community/me`, utils/one-way-back.ts `askOneWayBackStanding`),
 * so it shows on ANY phone holding a 12-words account, not only the one the join was made on (#1454 review, finding
 * 2), and goes once a sign-in was added anywhere. While the node is asked, and when it can't say, the phone's own record.
 * The asking is bounded (`oneWayBackAskNow`): at most once every 30 minutes per account, whatever the answer, and
 * never once a sign-in is known (PR #1452 re-review, finding 3).
 *
 * Where the key vault keeps a copy of the key, that copy is a way back in every community: the card never says "one
 * way back", and Settings only offers a sign-in quietly, as after "I still have my 12 words" (re-review, finding 2).
 *
 * `onActionsAt` (landing): where the actions rest on screen, so the "+ ADD POST" button can step aside while it would
 * float over them (re-review, finding 4); null when the card isn't up.
 *
 * On Home (the landing screen since H2, design §3.1 `safety`):
 * - `homeWord`: the community's word on this account from Home's own answer (`cards.safety`), used in place of asking
 *   `GET /api/community/me` when it is about the community the card is about, so a landing costs Home's one request.
 * - `accountDismissedAt`: the account's dismissal (`home.layout` `dismissed.safety`), from another phone or the web app.
 * - `onDismiss(at)`: the card was put away at `at` (the same moment the phone's record keeps), for Home to keep on the
 *   account. `onUp`: whether the card is drawn now, so Home's "…" moves count only the cards on screen.
 */
export function OneWayBackCard({ place, colors = lightColors, onActionsAt, homeWord, accountDismissedAt, onDismiss, onUp, band }: {
    place: 'landing' | 'settings';
    colors?: AppColors;
    onActionsAt?: (at: OneWayBackActionsAt | null) => void;
    homeWord?: { url: string; standing: OneWayBackStanding } | null;
    accountDismissedAt?: string | null;
    onDismiss?: (at: number) => void;
    onUp?: (up: boolean) => void;
    /**
     * Home in Arrange: the band this card has only there (its caption and ↑ ↓, across the top of its frame). With a band the
     * rest of the card goes quiet, dimmed and untouchable, until Done (DESIGN-home-arrange-in-place-fable.md §2.1).
     */
    band?: React.ReactNode;
}): React.JSX.Element | null {
    const { identity } = useIdentity();
    const [record, setRecord] = useState<OneWayBack | null>(null);
    const [shown, setShown] = useState<OneWayBackPlace>('none');
    const [hasPosted, setHasPosted] = useState(false);
    const [linking, setLinking] = useState(false);
    const [vaultCopy, setVaultCopy] = useState(false);
    const s = styles(colors);

    const latest = useRef(0);
    const actionsRef = useRef<View>(null);
    const reportAt = useRef(onActionsAt);
    reportAt.current = onActionsAt;
    const homeWordRef = useRef(homeWord);
    homeWordRef.current = homeWord;
    const accountDismissedRef = useRef(accountDismissedAt);
    accountDismissedRef.current = accountDismissedAt;
    // Where the landing card's actions rest on screen, for the floating button. Measured again shortly after layout,
    // as the feed's top inset settles.
    const measureActions = useCallback(() => {
        if (place !== 'landing' || !reportAt.current) return;
        actionsRef.current?.measureInWindow?.((_x, y, _w, h) => {
            if (h > 0) reportAt.current?.({ top: y, bottom: y + h });
        });
    }, [place]);
    const onActionsLayout = useCallback(() => {
        measureActions();
        setTimeout(measureActions, 300);
    }, [measureActions]);

    const refresh = useCallback(async (askNode: 'kept' | 'now' = 'kept') => {
        const call = ++latest.current;
        const key = identity?.publicKey;
        const [stored, vault] = await Promise.all([
            readOneWayBack(key),
            key ? vaultCopyKnown(key).catch(() => false) : Promise.resolve(false),
        ]);
        if (call !== latest.current) return;
        // The phone's own record at once; then the node's word, which decides when it comes.
        const show = async (found: OneWayBack | null) => {
            if (call !== latest.current) return;
            let posted = false;
            if (found && !found.done && key) {
                try {
                    // The member's own posts on this phone: the card comes back once after the first.
                    const { getMyPosts } = await import('../utils/db');
                    posted = (await getMyPosts(key)).length > 0;
                } catch {
                    posted = false;
                }
            }
            if (call !== latest.current) return;
            // A dismissal on the account (another phone, the web app) counts as this phone's own.
            const kept = withAccountDismissal(found, accountDismissedRef.current, posted);
            setRecord(kept);
            setVaultCopy(vault);
            setHasPosted(posted);
            setShown(oneWayBackPlace(kept, Date.now(), posted));
        };
        await show(stored);
        if (!identity || !key) return;
        const inUse = await anchorUrl().catch(() => null);
        const fromHome = homeWordRef.current;
        // Home's word is about the community Home reads: a record of every member's reminder starts there (§2.5).
        const where = oneWayBackCommunity(stored, inUse) ?? fromHome?.url ?? null;
        if (!where) return;
        const now = Date.now();
        if (fromHome && sameCommunity(fromHome.url, where) && (askNode !== 'now' || stored?.by === 'wayBack')) {
            // Home's answer already holds the community's word on this account (me.wayBack, cards.safety): no second request.
            await noteOneWayBackAsked(key, { at: now, answer: fromHome.standing.words ? 'words' : 'ordinary', joinedAt: fromHome.standing.joinedAt });
            if (call !== latest.current) return;
            await show(await oneWayBackFromNode(key, where, fromHome.standing, now, { vaultCopy: vault }));
            return;
        }
        // A reminder by `me.wayBack` is moved by Home's word alone: /api/community/me's `rules` says how they joined, and its
        // "ordinary" is not a sign-in added (it would end the reminder of every member who came by invite).
        if (stored?.by === 'wayBack') return;
        const asked = await readOneWayBackAsked(key);
        const decision = oneWayBackAskNow(stored, isGlobalInUse(inUse), asked, now, askNode === 'now');
        if (decision === 'never') return;
        let word: OneWayBackAsked | null = asked;
        if (decision === 'ask') {
            const answer = await askOneWayBackStandingShared(where, identity);
            word = answer === null ? { at: now, answer: 'none' }
                : answer === 'not_member' ? { at: now, answer: 'not_member' }
                    : { at: now, answer: answer.words ? 'words' : 'ordinary', joinedAt: answer.joinedAt };
            await noteOneWayBackAsked(key, word);
        }
        const standing = standingFromAsked(word);
        if (!standing || call !== latest.current) return;
        await show(await oneWayBackFromNode(key, where, standing, now, { vaultCopy: vault }));
    }, [identity]);

    // The community the record is about, where it isn't the global community (a door anyone can join, joined with 12
    // words: app/join-open-door.tsx), named as the door screens name it: its saved name, else its host. The sheet says it
    // where it would say "the global community".
    const recordUrl = record?.url;
    const [doorName, setDoorName] = useState<string | undefined>(undefined);
    useEffect(() => {
        if (!recordUrl || sameCommunity(recordUrl, GLOBAL_NODE_URL)) {
            setDoorName(undefined);
            return;
        }
        let live = true;
        setDoorName(communityName({ url: recordUrl }));
        void getSavedNodes().catch(() => []).then((saved) => {
            const alias = saved.find((n) => sameCommunity(n.url, recordUrl))?.alias ?? null;
            if (live) setDoorName(communityName({ url: recordUrl, alias }));
        });
        return () => { live = false; };
    }, [recordUrl]);

    useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));
    // Home's answer arrived with the community's word, or the account's dismissal changed: read again. `kept` too: a
    // say-so made on another device lands while `words` stays true, and ends the card on this visit (review of #3113).
    const wordKey = homeWord ? `${homeWord.url}|${homeWord.standing.words}|${!!homeWord.standing.kept}` : '';
    const mounted = useRef(false);
    useEffect(() => {
        if (!mounted.current) { mounted.current = true; return; }
        void refresh();
    }, [wordKey, accountDismissedAt, refresh]);

    const quiet = record?.done === 'checked' || vaultCopy;
    // "Add a sign-in" only where the node takes one from this member (the 12-words door's rule; review of #3110, round 2):
    // Home's word says so where it is about this record's community, else the record's own kind.
    const homeHere = !!homeWord && !!record && sameCommunity(homeWord.url, record.url);
    const canLink = homeHere ? homeWord!.standing.door !== false : record?.by !== 'wayBack';
    // The door's own words, or every other member's (§2.5).
    const everyMember = record?.by === 'wayBack' || (homeHere && homeWord!.standing.door === false);
    const up = !!identity && !!record && record.done !== 'linked' && (place === 'settings' || (shown === 'card' && !quiet));
    // The floating button learns when the landing card goes (put away, done, or a vault copy found).
    useEffect(() => {
        if (place === 'landing' && !up) reportAt.current?.(null);
    }, [place, up]);
    const reportUp = useRef(onUp);
    reportUp.current = onUp;
    useEffect(() => { reportUp.current?.(up && !(quiet && place !== 'settings')); }, [up, quiet, place]);
    useEffect(() => () => { if (place === 'landing') reportAt.current?.(null); }, [place]);

    if (!identity || !record || !up) return null;
    const bodyLine = !everyMember ? t(ONE_WAY_BACK_LINES.body) : canLink ? t(WORDS_HOW_BACK_LINES.withSignIn) : t(WORDS_HOW_BACK_LINES.noSignIn);
    const checkedLine = t(ONE_WAY_BACK_LINES.checked);
    // Said here, kept on the account so every device and the web agree (utils/words-kept.ts), then the card reads again.
    const stillHave = async () => { await keepWords(record.url, identity); void refresh(); };

    const sheet = (
        <LinkSignInSheet
            visible={linking}
            identity={identity}
            url={record.url}
            community={doorName}
            colors={colors}
            onClose={() => setLinking(false)}
            onLinked={() => { void refresh('now'); }}
        />
    );

    // Settings, after the member said they still have their words, or where the key vault keeps a copy: the sign-in is
    // still offered, quietly (it lifts the 12-words limits).
    if (quiet) {
        if (place !== 'settings' || !canLink) return null;
        return (
            <View style={s.quietCard}>
                <Text style={s.body}>{t('A sign-in can be a second way back, and it lifts the limits on new 12-words accounts.')}</Text>
                <Pressable style={s.secondary} onPress={() => setLinking(true)} accessibilityRole="button">
                    <Text style={s.secondaryText}>{t(ONE_WAY_BACK_LINES.addSignIn)}</Text>
                </Pressable>
                {sheet}
            </View>
        );
    }

    const content = (
        <>
            {/* The design's one sentence, as it is: no heading that says it twice. */}
            <View style={s.row}>
                <Text style={s.title}>🔑 {bodyLine}</Text>
                {place === 'landing' && (
                    <Pressable
                        onPress={async () => {
                            // One moment for the phone's record and the account's (Home keeps it in `home.layout`).
                            const at = Date.now();
                            await dismissOneWayBack(identity.publicKey, hasPosted, at);
                            onDismiss?.(at);
                            void refresh();
                        }}
                        hitSlop={12}
                        accessibilityRole="button"
                        accessibilityLabel={t(ONE_WAY_BACK_LINES.notNow)}
                    >
                        <Text style={s.close}>✕</Text>
                    </Pressable>
                )}
            </View>
            {/* Not flattened away (Android), so it can be measured on screen. */}
            <View ref={actionsRef} collapsable={false} onLayout={onActionsLayout}>
            {canLink && (
                <Pressable style={s.primary} onPress={() => setLinking(true)} accessibilityRole="button" testID="one-way-back-add-sign-in">
                    <Text style={s.primaryText}>{t(ONE_WAY_BACK_LINES.addSignIn)}</Text>
                </Pressable>
            )}
            {place === 'landing' && !canLink && (
                // No sign-in to offer: what works is the words themselves, and saying they are still kept.
                <Pressable style={s.secondary} onPress={() => { void stillHave(); }} accessibilityRole="button"
                    accessibilityHint={t('Says you checked you still have your 12 words written down')} testID="one-way-back-still-have">
                    <Text style={s.secondaryText}>✓ {checkedLine}</Text>
                </Pressable>
            )}
            {place === 'landing' ? (
                <Pressable
                    style={s.secondary}
                    onPress={() => router.push({ pathname: '/(tabs)/settings', params: { section: 'protection' } })}
                    accessibilityRole="button"
                >
                    <Text style={s.secondaryText}>{t(ONE_WAY_BACK_LINES.checkWords)}</Text>
                </Pressable>
            ) : (
                <Pressable
                    style={s.secondary}
                    onPress={() => { void stillHave(); }}
                    accessibilityRole="button"
                    accessibilityHint={t('Says you checked you still have your 12 words written down')}
                    testID="one-way-back-still-have"
                >
                    <Text style={s.secondaryText}>✓ {checkedLine}</Text>
                </Pressable>
            )}
            </View>
        </>
    );

    return (
        // Its name for TalkBack says what its sentence says: "one way back" isn't true for every member (§2.5).
        <View style={[s.card, place === 'landing' && s.landing]} accessibilityRole="summary" accessibilityLabel={everyMember ? bodyLine : t(ONE_WAY_BACK_LINES.title)}>
            {band}
            {/* One wrapper whether or not Home's band is up (home/quiet.ts): the card's inside is never rebuilt when Arrange opens. */}
            <View {...quietWrapperProps(!!band)} style={band ? quietInside : undefined}>{content}</View>
            {sheet}
        </View>
    );
}

const quietInside = { opacity: QUIET_OPACITY };

const cache = new WeakMap<AppColors, ReturnType<typeof make>>();
function styles(colors: AppColors) {
    let s = cache.get(colors);
    if (!s) {
        s = make(colors);
        cache.set(colors, s);
    }
    return s;
}

function make(colors: AppColors) {
    return StyleSheet.create({
        card: {
            backgroundColor: colors.feedback.warning.bg, borderColor: colors.feedback.warning.border, borderWidth: 1,
            borderRadius: 14, padding: 14, marginBottom: 12,
        },
        landing: { marginHorizontal: 16, marginBottom: 8 },
        quietCard: { borderTopWidth: 1, borderTopColor: colors.border.default, paddingTop: 12, marginBottom: 12 },
        row: { flexDirection: 'row', alignItems: 'flex-start' },
        title: { flex: 1, fontSize: 15, fontWeight: '700', color: colors.text.heading, lineHeight: 21 },
        close: { fontSize: 16, color: colors.text.secondary, fontWeight: '700', paddingLeft: 8 },
        body: { fontSize: 14, color: colors.text.body, lineHeight: 20, marginTop: 4 },
        primary: { minHeight: 44, marginTop: 10, backgroundColor: colors.brand.fill, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
        primaryText: { color: colors.text.inverse, fontSize: 14, fontWeight: '800', textAlign: 'center' },
        secondary: { minHeight: 44, marginTop: 6, borderRadius: 10, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, paddingVertical: 10, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
        secondaryText: { color: colors.text.body, fontSize: 14, fontWeight: '700', textAlign: 'center' },
    });
}
