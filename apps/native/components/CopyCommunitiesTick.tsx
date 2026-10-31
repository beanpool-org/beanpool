/**
 * The tick beside Protect with (vault rethink VR5, design §3 item 5): whether the copy a connect makes also carries this
 * account's list of communities, locked the same way. On unless the member unticks it (Marty's pick 9 of 27 Oct); it
 * applies to the next copy made, so it is said here, before Protect with is tapped. utils/copy-communities.ts keeps it
 * for next time; what it shows goes to the sheet through the screen (`onChange`), never from what is kept alone.
 */
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { t, word } from '@beanpool/core';
import type { AppColors } from '../constants/colors';
import { copyListsCommunities, setCopyListsCommunities } from '../utils/copy-communities';

/** The tick's words, marked for the catalogs. */
export const COPY_COMMUNITIES_WORDS = {
    tick: word('Also keep my list of communities in the copy, locked the same way, so a new phone knows where to go.'),
    // Under a sign-in already connected: its copy was made before, so the tick says it isn't in that copy yet. A phone
    // with the 12 words can make that copy again (Connect again); one without them has no Connect again.
    appliesNext: word('This applies to the next copy made: Protect with, or Connect again. A copy already kept stays as it was until then.'),
    appliesNextNoWords: word('This applies to a sign-in you connect from now on. A copy already kept stays as it was.'),
};

export function CopyCommunitiesTick({ publicKey, colors, onChange, connected }: {
    publicKey: string;
    colors: AppColors;
    /** What the tick shows, each time it changes: the screen hands it to the sheet (SsoEnrolSheet `listCommunities`). */
    onChange?: (on: boolean) => void;
    /** A sign-in is connected already: say the tick is for the next copy (`words`: Connect again is there), not that one. */
    connected?: 'words' | 'noWords';
}): React.JSX.Element {
    const [on, setOn] = useState(true);
    useEffect(() => {
        let live = true;
        copyListsCommunities(publicKey).then((v) => { if (live) setOn(v); }).catch(() => {});
        return () => { live = false; };
    }, [publicKey]);
    useEffect(() => { onChange?.(on); }, [on, onChange]);
    const s = styles(colors);
    const toggle = () => {
        const next = !on;
        setOn(next);
        void setCopyListsCommunities(publicKey, next);
    };
    return (
        <>
            <Pressable
                style={s.tick}
                onPress={toggle}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={t(COPY_COMMUNITIES_WORDS.tick)}
                testID="copy-communities-tick"
            >
                <View style={[s.box, on && s.boxOn]}>
                    {on && <Text style={s.boxMark} accessibilityElementsHidden importantForAccessibility="no">✓</Text>}
                </View>
                <Text style={s.tickText}>{t(COPY_COMMUNITIES_WORDS.tick)}</Text>
            </Pressable>
            {connected && (
                <Text style={s.applies} testID="copy-communities-applies">
                    {t(connected === 'words' ? COPY_COMMUNITIES_WORDS.appliesNext : COPY_COMMUNITIES_WORDS.appliesNextNoWords)}
                </Text>
            )}
        </>
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

// The same say-so row as Ways back's "written down" (components/WaysBackList.tsx): words wrap beside the box, 44 dp tall.
const make = (colors: AppColors) => StyleSheet.create({
    tick: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, marginTop: 8 },
    // The box's edge in the words' own grey: a control's outline needs 3:1.
    box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: colors.text.secondary, alignItems: 'center', justifyContent: 'center' },
    boxOn: { backgroundColor: colors.brand.fill, borderColor: colors.brand.fill },
    boxMark: { color: colors.text.onBrand, fontSize: 14, fontWeight: '800' },
    tickText: { flex: 1, fontSize: 13, lineHeight: 18, color: colors.text.body },
    // Under the words, past the box and its gap.
    applies: { marginLeft: 34, fontSize: 12, lineHeight: 17, color: colors.text.secondary },
});
