import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { colors as lightColors, type AppColors } from '../constants/colors';
import { useIdentity } from '../app/IdentityContext';
import { LinkSignInSheet } from './LinkSignInSheet';
import {
    ONE_WAY_BACK_TEXT,
    dismissOneWayBack,
    finishOneWayBack,
    oneWayBackPlace,
    readOneWayBack,
    type OneWayBack,
    type OneWayBackPlace,
} from '../utils/one-way-back';

/**
 * "Your account has one way back: your 12 words" (two-doors design §2.5, utils/one-way-back.ts), for a member who joined
 * the global community with 12 words. A plain card, never a dot and never a gate.
 *
 * - `landing`: the card on the landing screen while utils/one-way-back.ts says `card`: Add a sign-in, Show my 12 words
 *   (Settings' Account Protection, behind the phone's lock), and Not now (it comes back once after the first post and
 *   once after a week).
 * - `settings`: Account Protection's block until a sign-in is added or the member says they still have their words;
 *   after "I still have my 12 words", adding a sign-in is still offered there, without the warning.
 */
export function OneWayBackCard({ place, colors = lightColors }: { place: 'landing' | 'settings'; colors?: AppColors }): React.JSX.Element | null {
    const { identity } = useIdentity();
    const [record, setRecord] = useState<OneWayBack | null>(null);
    const [shown, setShown] = useState<OneWayBackPlace>('none');
    const [hasPosted, setHasPosted] = useState(false);
    const [linking, setLinking] = useState(false);
    const s = styles(colors);

    const refresh = useCallback(async () => {
        const key = identity?.publicKey;
        const found = await readOneWayBack(key);
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
        setRecord(found);
        setHasPosted(posted);
        setShown(oneWayBackPlace(found, Date.now(), posted));
    }, [identity?.publicKey]);

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
            onLinked={() => { void refresh(); }}
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
