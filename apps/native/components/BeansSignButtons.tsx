import React from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { BEANS_SIGN_WORDS as W, t, type BeansSignSize } from '@beanpool/core';
// Static colours: only the default of the `colors` prop. Every caller passes its screen's set (measured 12 Nov 2026, colour themes T2), so a colour set reaches it through the prop.
import { colors as lightColors, type AppColors } from '../constants/colors';
import { anchorUrl } from '../utils/node-post';
import { getSavedNodes } from '../utils/nodes';
import { kitCommunityFrom } from '../utils/recovery-kit';
import { shareBeansSign, type SignResult } from '../utils/beans-sign';

/**
 * "A sign for your window or stall": the two "Beans accepted here" signs, A4 for a window and A6 for a stall, made as a PDF on this
 * phone and handed to the share sheet (utils/beans-sign.ts). On the community's Settings and on an enterprise's Manage console
 * (its keepers). Optional: nothing waits on them. Stacked full width, so at 320dp with 1.3x text each label wraps rather than
 * clips; 48dp targets. `make` is the phone's own unless a test hands in a stand-in.
 */
export function BeansSignButtons({ colors = lightColors, make = shareBeansSign }: {
    colors?: AppColors;
    make?: typeof shareBeansSign;
}): React.JSX.Element {
    const s = styles(colors);
    const [busy, setBusy] = React.useState(false);
    const a4Label = t(W.a4);
    const a6Label = t(W.a6);

    const run = async (size: BeansSignSize) => {
        if (busy) return;
        setBusy(true);
        try {
            const community = kitCommunityFrom(await anchorUrl().catch(() => null), await getSavedNodes().catch(() => []));
            const result: SignResult = await make(size, community);
            if (result === 'failed') Alert.alert(t(W.title), t(W.failed));
        } finally {
            setBusy(false);
        }
    };

    return (
        <View style={s.block} testID="beans-sign">
            <Text style={s.heading} accessibilityRole="header">{t(W.heading)}</Text>
            <Pressable style={[s.btn, busy && s.disabled]} onPress={() => run('a4')} disabled={busy} accessibilityRole="button" accessibilityLabel={a4Label} testID="beans-sign-a4">
                <Text style={s.btnText}>🪟 {a4Label}</Text>
            </Pressable>
            <Pressable style={[s.btn, busy && s.disabled]} onPress={() => run('a6')} disabled={busy} accessibilityRole="button" accessibilityLabel={a6Label} testID="beans-sign-a6">
                <Text style={s.btnText}>🧺 {a6Label}</Text>
            </Pressable>
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
        block: { marginTop: 4, marginBottom: 8 },
        heading: { color: colors.text.heading, fontSize: 16, fontWeight: 'bold', marginBottom: 8 },
        btn: {
            minHeight: 48, alignItems: 'center', justifyContent: 'center', marginBottom: 8,
            backgroundColor: colors.surface.card, borderColor: colors.border.default, borderWidth: 1, borderRadius: 10,
            paddingHorizontal: 14, paddingVertical: 10,
        },
        btnText: { flexShrink: 1, color: colors.text.heading, fontSize: 15, fontWeight: '600', textAlign: 'center' },
        disabled: { opacity: 0.5 },
    });
}
