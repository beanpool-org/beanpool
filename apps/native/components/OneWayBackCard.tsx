import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { colors as lightColors, type AppColors } from '../constants/colors';
import { useIdentity } from '../app/IdentityContext';
import { LinkSignInSheet } from './LinkSignInSheet';
import {
    ONE_WAY_BACK_TEXT,
    askOneWayBackStandingShared,
    dismissOneWayBack,
    finishOneWayBack,
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
export function OneWayBackCard({ place, colors = lightColors, onActionsAt, homeWord, accountDismissedAt, onDismiss, onUp }: {
    place: 'landing' | 'settings';
    colors?: AppColors;
    onActionsAt?: (at: OneWayBackActionsAt | null) => void;
    homeWord?: { url: string; standing: OneWayBackStanding } | null;
    accountDismissedAt?: string | null;
    onDismiss?: (at: number) => void;
    onUp?: (up: boolean) => void;
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
        const where = oneWayBackCommunity(stored, inUse);
        if (!where) return;
        const now = Date.now();
        const asked = await readOneWayBackAsked(key);
        const decision = oneWayBackAskNow(stored, isGlobalInUse(inUse), asked, now, askNode === 'now');
        if (decision === 'never') return;
        let word: OneWayBackAsked | null = asked;
        const fromHome = homeWordRef.current;
        if (askNode !== 'now' && fromHome && sameCommunity(fromHome.url, where)) {
            // Home's answer already holds the community's word on this account: no second request.
            word = { at: now, answer: fromHome.standing.words ? 'words' : 'ordinary', joinedAt: fromHome.standing.joinedAt };
            await noteOneWayBackAsked(key, word);
        } else if (decision === 'ask') {
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

    useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));
    // Home's answer arrived with the community's word, or the account's dismissal changed: read again.
    const wordKey = homeWord ? `${homeWord.url}|${homeWord.standing.words}` : '';
    const mounted = useRef(false);
    useEffect(() => {
        if (!mounted.current) { mounted.current = true; return; }
        void refresh();
    }, [wordKey, accountDismissedAt, refresh]);

    const quiet = record?.done === 'checked' || vaultCopy;
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

    const sheet = (
        <LinkSignInSheet
            visible={linking}
            identity={identity}
            url={record.url}
            colors={colors}
            onClose={() => setLinking(false)}
            onLinked={() => { void refresh('now'); }}
        />
    );

    // Settings, after the member said they still have their words, or where the key vault keeps a copy: the sign-in is
    // still offered, quietly (it lifts the 12-words limits).
    if (quiet) {
        if (place !== 'settings') return null;
        return (
            <View style={s.quietCard}>
                <Text style={s.body}>A sign-in can be a second way back, and it lifts the limits on new 12-words accounts.</Text>
                <Pressable style={s.secondary} onPress={() => setLinking(true)} accessibilityRole="button">
                    <Text style={s.secondaryText}>{ONE_WAY_BACK_TEXT.addSignIn}</Text>
                </Pressable>
                {sheet}
            </View>
        );
    }

    return (
        <View style={[s.card, place === 'landing' && s.landing]} accessibilityRole="summary" accessibilityLabel={ONE_WAY_BACK_TEXT.title}>
            {/* The design's one sentence, as it is: no heading that says it twice. */}
            <View style={s.row}>
                <Text style={s.title}>🔑 {ONE_WAY_BACK_TEXT.body}</Text>
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
                        accessibilityLabel={ONE_WAY_BACK_TEXT.notNow}
                    >
                        <Text style={s.close}>✕</Text>
                    </Pressable>
                )}
            </View>
            {/* Not flattened away (Android), so it can be measured on screen. */}
            <View ref={actionsRef} collapsable={false} onLayout={onActionsLayout}>
            <Pressable style={s.primary} onPress={() => setLinking(true)} accessibilityRole="button">
                <Text style={s.primaryText}>{ONE_WAY_BACK_TEXT.addSignIn}</Text>
            </Pressable>
            {place === 'landing' ? (
                <Pressable
                    style={s.secondary}
                    onPress={() => router.push({ pathname: '/(tabs)/settings', params: { section: 'protection' } })}
                    accessibilityRole="button"
                >
                    <Text style={s.secondaryText}>{ONE_WAY_BACK_TEXT.checkWords}</Text>
                </Pressable>
            ) : (
                <Pressable
                    style={s.secondary}
                    onPress={async () => { await finishOneWayBack(identity.publicKey, 'checked'); void refresh(); }}
                    accessibilityRole="button"
                    accessibilityHint="Says you checked you still have your 12 words written down"
                >
                    <Text style={s.secondaryText}>✓ {ONE_WAY_BACK_TEXT.checked}</Text>
                </Pressable>
            )}
            </View>
            {sheet}
        </View>
    );
}

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
        primary: { minHeight: 44, marginTop: 10, backgroundColor: colors.brand.primary, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
        primaryText: { color: colors.text.inverse, fontSize: 14, fontWeight: '800', textAlign: 'center' },
        secondary: { minHeight: 44, marginTop: 6, borderRadius: 10, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, paddingVertical: 10, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
        secondaryText: { color: colors.text.body, fontSize: 14, fontWeight: '700', textAlign: 'center' },
    });
}
