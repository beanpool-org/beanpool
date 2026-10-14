import React from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors as lightColors, type AppColors } from '../constants/colors';
import { anchorUrl } from '../utils/node-post';
import { getSavedNodes } from '../utils/nodes';
import {
    KIT_FAILED_LINE, KIT_PRINT_LABEL, KIT_SAVE_LABEL, askBeforeSavingKit, kitCommunityFrom, printRecoveryKit,
    saveRecoveryKitPdf, type KitResult, type RecoveryKit,
} from '../utils/recovery-kit';

/**
 * Print your recovery kit / Save as PDF, under the 12 words wherever the app shows them to the member
 * (utils/recovery-kit.ts). Optional: nothing waits on them. Stacked full width, so at 320dp with 1.3x text each
 * label wraps rather than clips; 48dp targets.
 */
export function RecoveryKitButtons({ words, colors = lightColors }: { words: readonly string[] | null; colors?: AppColors }): React.JSX.Element | null {
    const s = styles(colors);
    const [busy, setBusy] = React.useState(false);
    if (!words || words.length !== 12) return null;

    const run = async (action: (kit: RecoveryKit) => Promise<KitResult>) => {
        if (busy) return;
        setBusy(true);
        try {
            const community = kitCommunityFrom(await anchorUrl().catch(() => null), await getSavedNodes().catch(() => []));
            const result = community
                ? await action({ words, ...community, date: new Date() })
                : 'failed';
            if (result === 'failed') Alert.alert('Recovery kit', KIT_FAILED_LINE);
        } finally {
            setBusy(false);
        }
    };

    return (
        <View style={s.block}>
            <Pressable
                style={[s.btn, busy && s.disabled]}
                onPress={() => run((kit) => printRecoveryKit(kit))}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={KIT_PRINT_LABEL}
            >
                <Text style={s.btnText}>🖨️ {KIT_PRINT_LABEL}</Text>
            </Pressable>
            <Pressable
                style={[s.btn, busy && s.disabled]}
                onPress={() => run((kit) => saveRecoveryKitPdf(kit, () => askBeforeSavingKit(Alert.alert)))}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={KIT_SAVE_LABEL}
            >
                <Text style={s.btnText}>📄 {KIT_SAVE_LABEL}</Text>
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
        btn: {
            minHeight: 48, alignItems: 'center', justifyContent: 'center', marginBottom: 8,
            backgroundColor: colors.surface.card, borderColor: colors.border.default, borderWidth: 1, borderRadius: 10,
            paddingHorizontal: 14, paddingVertical: 10,
        },
        btnText: { flexShrink: 1, color: colors.text.heading, fontSize: 15, fontWeight: '600', textAlign: 'center' },
        disabled: { opacity: 0.5 },
    });
}
