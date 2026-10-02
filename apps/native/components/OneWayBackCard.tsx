import React, { useCallback, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { colors as lightColors, type AppColors } from '../constants/colors';
import { useIdentity } from '../app/IdentityContext';
import { LinkSignInSheet } from './LinkSignInSheet';
import {
    ONE_WAY_BACK_TEXT,
    askOneWayBackStanding,
    dismissOneWayBack,
    finishOneWayBack,
    oneWayBackCommunity,
    oneWayBackFromNode,
    oneWayBackPlace,
    readOneWayBack,
    type OneWayBack,
    type OneWayBackPlace,
    type OneWayBackStanding,
} from '../utils/one-way-back';
import { anchorUrl } from '../utils/node-post';

/**
 * The Market's "+ ADD POST" button floats over the feed's bottom right (app/(tabs)/index.tsx `styles.fab`: 32dp from the
 * bottom, about 58dp tall, 24dp from the right, up to about 150dp wide at the app's largest text). On a small screen with
 * large text (320dp at 1.3x) the landing card's actions sit under it until the feed is scrolled (PR #1452 review). Where
 * they would, they keep out of its column instead.
 */
const FAB_BAND_DP = 100;
const FAB_CLEARANCE_DP = 150;

/** The node's word, kept a few minutes per account and community: the card asks again on focus only after that. */
const STANDING_KEPT_MS = 5 * 60 * 1000;
const standings = new Map<string, { at: number; standing: OneWayBackStanding }>();

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
 */
export function OneWayBackCard({ place, colors = lightColors }: { place: 'landing' | 'settings'; colors?: AppColors }): React.JSX.Element | null {
    const { identity } = useIdentity();
    const [record, setRecord] = useState<OneWayBack | null>(null);
    const [shown, setShown] = useState<OneWayBackPlace>('none');
    const [hasPosted, setHasPosted] = useState(false);
    const [linking, setLinking] = useState(false);
    const s = styles(colors);

    const latest = useRef(0);
    const { height: windowHeight } = useWindowDimensions();
    const actionsRef = useRef<View>(null);
    const [clearOfFab, setClearOfFab] = useState(false);
    // Where the landing card's actions rest on screen: under the floating button's band, they move out of its column.
    // Measured again shortly after layout, as the feed's top inset settles. Once moved, they stay moved.
    const measureActions = useCallback(() => {
        if (place !== 'landing') return;
        actionsRef.current?.measureInWindow((_x, y, _w, h) => {
            if (h > 0 && y + h > windowHeight - FAB_BAND_DP) setClearOfFab(true);
        });
    }, [place, windowHeight]);
    const onActionsLayout = useCallback(() => {
        measureActions();
        setTimeout(measureActions, 300);
    }, [measureActions]);

    const refresh = useCallback(async (askNode: 'cached' | 'now' = 'cached') => {
        const call = ++latest.current;
        const key = identity?.publicKey;
        const stored = await readOneWayBack(key);
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
            setRecord(found);
            setHasPosted(posted);
            setShown(oneWayBackPlace(found, Date.now(), posted));
        };
        await show(stored);
        if (!identity || !key) return;
        const where = oneWayBackCommunity(stored, await anchorUrl().catch(() => null));
        if (!where) return;
        const cacheKey = `${key}@${where}`;
        const kept = standings.get(cacheKey);
        // A sign-in added on this phone since the word was kept: asked again, never reopened from an old word.
        const usable = kept && Date.now() - kept.at < STANDING_KEPT_MS && !(stored?.done === 'linked' && kept.standing.words);
        let standing = askNode === 'cached' && usable ? kept.standing : null;
        if (!standing) {
            standing = await askOneWayBackStanding(where, identity);
            if (standing) standings.set(cacheKey, { at: Date.now(), standing });
        }
        if (!standing || call !== latest.current) return;
        await show(await oneWayBackFromNode(key, where, standing));
    }, [identity]);

    useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

    if (!identity || !record || record.done === 'linked') return null;
    if (place === 'landing' && shown !== 'card') return null;

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

    // Settings, after the member said they still have their words: the sign-in is still offered, quietly.
    if (record.done === 'checked') {
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
                        onPress={async () => { await dismissOneWayBack(identity.publicKey, hasPosted); void refresh(); }}
                        hitSlop={12}
                        accessibilityRole="button"
                        accessibilityLabel={ONE_WAY_BACK_TEXT.notNow}
                    >
                        <Text style={s.close}>✕</Text>
                    </Pressable>
                )}
            </View>
            {/* Not flattened away (Android), so it can be measured on screen. */}
            <View ref={actionsRef} collapsable={false} onLayout={onActionsLayout} style={clearOfFab ? s.clearOfFab : null}>
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
        clearOfFab: { marginRight: FAB_CLEARANCE_DP },
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
