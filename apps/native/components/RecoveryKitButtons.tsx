import React from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
// Static colours: only the default of the `colors` prop. Every caller passes its screen's set (measured 12 Nov 2026, colour themes T2), so a colour set reaches it through the prop.
import { colors as lightColors, type AppColors } from '../constants/colors';
import { anchorUrl } from '../utils/node-post';
import { getSavedNodes } from '../utils/nodes';
import {
    KIT_FAILED_LINE, KIT_PRINT_LABEL, KIT_SAVE_LABEL, askBeforeSavingKit, kitCommunityFrom, printRecoveryKit,
    saveRecoveryKitPdf, type KitResult, type RecoveryKit,
} from '../utils/recovery-kit';
import { t, word } from '@beanpool/core';
import { welcomeLineWords } from './welcome/welcome-lines';

/**
 * The one question after Print or Save as PDF comes back (the director's rule, review of #3113). The phone cannot see a
 * print or a save: Android's print resolves when its dialog opens, and the share sheet resolves when it is dismissed, on
 * both platforms. So the kit alone never counts as "I still have my 12 words": only the member's own Yes does, the same
 * record that line makes. Not yet records nothing, and nothing asks again until the kit is used again.
 */
export const KIT_KEPT_LINES = {
    ask: word('Did you keep it somewhere safe?'),
    yes: word("Yes, it's kept"),
    notYet: word('Not yet'),
} as const;

/**
 * The question before Save as PDF, as recovery-kit.ts asks it, said in the member's language: recovery-kit.ts makes the
 * printed words, so its sentences stay English there (components/welcome/welcome-lines.ts translates them here). What
 * each button does is unchanged.
 */
const kitAlert: Parameters<typeof askBeforeSavingKit>[0] = (title, message, buttons, options) => Alert.alert(
    welcomeLineWords(title),
    message === undefined ? undefined : welcomeLineWords(message),
    buttons?.map((b) => ({ ...b, text: welcomeLineWords(b.text) })),
    options,
);

/**
 * Print your recovery kit / Save as PDF, under the 12 words wherever the app shows them to the member
 * (utils/recovery-kit.ts). Optional: nothing waits on them. Stacked full width, so at 320dp with 1.3x text each
 * label wraps rather than clips; 48dp targets. The labels are in the member's language, and so is the printed kit (core's
 * printedKitLines(), asked for by utils/recovery-kit.ts when the page is made); its 12 words stay English in every language.
 */
export function RecoveryKitButtons({ words, colors = lightColors, onKept }: {
    words: readonly string[] | null;
    colors?: AppColors;
    /**
     * The member said Yes to {@link KIT_KEPT_LINES} after the kit came back: the words are kept, as "I still have my 12
     * words" says (DESIGN-home-default-fable.md §2.5). The caller records it for its account (utils/words-kept.ts
     * `keepWords`). Never called for the kit's own result. Without it, nothing is asked.
     */
    onKept?: () => void;
}): React.JSX.Element | null {
    const s = styles(colors);
    const [busy, setBusy] = React.useState(false);
    const [asking, setAsking] = React.useState(false);
    if (!words || words.length !== 12) return null;
    const printLabel = welcomeLineWords(KIT_PRINT_LABEL);
    const saveLabel = welcomeLineWords(KIT_SAVE_LABEL);

    const run = async (action: (kit: RecoveryKit) => Promise<KitResult>) => {
        if (busy) return;
        setBusy(true);
        try {
            const community = kitCommunityFrom(await anchorUrl().catch(() => null), await getSavedNodes().catch(() => []));
            const result = community
                ? await action({ words, ...community, date: new Date() })
                : 'failed';
            if (result === 'failed') Alert.alert(t('Recovery kit'), welcomeLineWords(KIT_FAILED_LINE));
            // 'done' only says the dialog or the sheet came back, not that anything was printed or saved: ask.
            else if (result === 'done' && onKept) setAsking(true);
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
                accessibilityLabel={printLabel}
            >
                <Text style={s.btnText}>🖨️ {printLabel}</Text>
            </Pressable>
            <Pressable
                style={[s.btn, busy && s.disabled]}
                onPress={() => run((kit) => saveRecoveryKitPdf(kit, () => askBeforeSavingKit(kitAlert)))}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={saveLabel}
            >
                <Text style={s.btnText}>📄 {saveLabel}</Text>
            </Pressable>
            {asking && (
                <View style={s.ask} accessibilityLiveRegion="polite" testID="kit-kept-ask">
                    <Text style={s.askText}>{t(KIT_KEPT_LINES.ask)}</Text>
                    {/* The two answers look alike: the kit doesn't push a Yes. Each takes a whole row where both don't fit. */}
                    <View style={s.answers}>
                        <Pressable
                            style={s.answer}
                            onPress={() => { setAsking(false); onKept?.(); }}
                            accessibilityRole="button"
                            testID="kit-kept-yes"
                        >
                            <Text style={s.btnText}>{t(KIT_KEPT_LINES.yes)}</Text>
                        </Pressable>
                        <Pressable style={s.answer} onPress={() => setAsking(false)} accessibilityRole="button" testID="kit-kept-not-yet">
                            <Text style={s.btnText}>{t(KIT_KEPT_LINES.notYet)}</Text>
                        </Pressable>
                    </View>
                </View>
            )}
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
        ask: { marginTop: 4 },
        askText: { color: colors.text.heading, fontSize: 15, fontWeight: '600', lineHeight: 21, marginBottom: 8 },
        answers: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 8 },
        answer: {
            flexGrow: 1, flexBasis: 120, minHeight: 48, alignItems: 'center', justifyContent: 'center', marginBottom: 8,
            backgroundColor: colors.surface.card, borderColor: colors.border.default, borderWidth: 1, borderRadius: 10,
            paddingHorizontal: 14, paddingVertical: 10,
        },
    });
}
