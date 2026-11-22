/**
 * Device check (temporary: the TestFlight probe branch only, never merged). Two things only a real iPhone can answer:
 *
 * - **A. Invite paste** (DESIGN-ios-invite-paste-fable.md §4.4, P0 items 2, 3 and 5): what `hasStringAsync` and
 *   `hasUrlAsync` answer after an invite page's copy, whether the link arrived at all, and how Apple's paste button draws
 *   and works with its icon only.
 * - **B. Quiet notifications** (DESIGN-notify-and-backup-asks-fable-amend2.md §12 item 16, N7): after quiet delivery is on,
 *   does a full ask still bring the phone's own question?
 *
 * The clipboard is read (`getStringAsync`, `getUrlAsync`, Apple's button) only at a tap; the two presence checks read
 * nothing. Nothing here registers a push token, writes the phone's notifications record or tells a community anything.
 * The results leave the phone only where the person pastes them. The rows are utils/device-check.ts's.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { t } from '@beanpool/core';
import { useStyles, useTheme } from '../app/ThemeContext';
import {
    answer, inviteNotes, inviteRows, iphoneOnly, notifyNote, notifyRows, pastedOnly, resultsText, sectionA, sectionB,
    type DeviceCheckAnswers, type DeviceCheckRow,
} from '../utils/device-check';

const IPHONE = Platform.OS === 'ios';

async function notifications() {
    const mod = await import('expo-notifications');
    return mod.default ?? mod;
}

/** The options of a full ask; the quiet one adds `allowProvisional`. */
const ASK_FULLY = { allowAlert: true, allowBadge: true, allowSound: true };

export function DeviceCheck({ onSignInProbe }: {
    /** A development build only: the Sign in with Apple probe this route also holds (app/apple-probe.tsx). */
    onSignInProbe?: () => void;
}) {
    const { colors } = useTheme();
    const s = useStyles(makeStyles);
    const [check, setCheck] = useState<DeviceCheckAnswers>(() => ({
        os: Platform.OS, version: String(Platform.Version), pasteButton: Clipboard.isPasteButtonAvailable,
    }));
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState<'done' | 'failed' | null>(null);
    /** Copy results put our own text on the clipboard: the presence answers stay the invite's until the next read. */
    const ownText = useRef(false);

    const add = useCallback((answers: Partial<DeviceCheckAnswers>) => setCheck((c) => ({ ...c, ...answers })), []);

    const askWhatIsCopied = useCallback(async () => {
        add({ hasString: await answer(async () => Clipboard.hasStringAsync()) });
        add({ hasUrl: await answer(async () => Clipboard.hasUrlAsync()) });
    }, [add]);

    const readPermission = useCallback(async () => {
        if (!IPHONE) return;
        const now = await answer(async () => (await notifications()).getPermissionsAsync());
        setCheck((c) => ({ ...c, opened: c.opened ?? now, now }));
    }, []);

    // As the screen opens and each time the phone comes back to it: nothing is read, and nothing is asked of the person.
    useEffect(() => {
        const look = () => {
            if (!ownText.current) void askWhatIsCopied();
            void readPermission();
        };
        look();
        const sub = AppState.addEventListener('change', (next) => { if (next === 'active') look(); });
        return () => sub.remove();
    }, [askWhatIsCopied, readPermission]);

    /** One tap at a time: a second would read or ask over the first. */
    const atTap = async (work: () => Promise<void>) => {
        if (busy) return;
        setBusy(true);
        try { await work(); } finally { setBusy(false); }
    };

    const readWhatIsCopied = () => atTap(async () => {
        ownText.current = false;
        await askWhatIsCopied();
        add({ text: await answer(() => Clipboard.getStringAsync()) });
        add({ url: await answer(() => Clipboard.getUrlAsync()) });
    });

    const askQuietly = () => atTap(async () => {
        add({
            quiet: await answer(async () => {
                const notif = await notifications();
                return notif.requestPermissionsAsync({ ios: { allowProvisional: true, ...ASK_FULLY } });
            }),
        });
        await readPermission();
    });

    const askFully = () => atTap(async () => {
        add({
            full: await answer(async () => {
                const notif = await notifications();
                return notif.requestPermissionsAsync({ ios: ASK_FULLY });
            }),
        });
        await readPermission();
    });

    const copyResults = async () => {
        ownText.current = true;
        const done = await answer(() => Clipboard.setStringAsync(resultsText(check)));
        if ('error' in done) ownText.current = false;
        setCopied('error' in done ? 'failed' : 'done');
    };

    const rows = (list: DeviceCheckRow[]) => list.map((r) => (
        <View key={r.id} style={s.row} testID={`device-check-${r.id}`}>
            <Text style={s.label}>{r.label}</Text>
            <Text style={s.body}>{r.said}</Text>
            {r.raw !== null && <Text style={s.raw} selectable>{r.raw}</Text>}
        </View>
    ));
    // Copy results never waits: a read or an ask that gets no answer can still be copied as it stands.
    const button = (words: string, onPress: () => void, testID: string, off = busy) => (
        <Pressable style={[s.button, off && s.disabled]} onPress={onPress} disabled={off} accessibilityRole="button" accessibilityState={{ disabled: off }} testID={testID}>
            <Text style={s.buttonText}>{words}</Text>
        </Pressable>
    );

    return (
        <SafeAreaView style={s.page} edges={['top', 'left', 'right', 'bottom']}>
            <ScrollView contentContainerStyle={s.scroll}>
                <Pressable style={s.back} onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))} accessibilityRole="button" testID="device-check-back">
                    <Text style={s.link}><Text aria-hidden={true}>← </Text>{t('Back')}</Text>
                </Pressable>
                <Text style={s.title} accessibilityRole="header">{t('Device check (temporary)')}</Text>

                <View style={s.section} testID="device-check-a">
                    <Text style={s.heading} accessibilityRole="header">{sectionA()}</Text>
                    <Text style={s.body}>{t('Copy an invite link from the test community in Safari, then come back here')}</Text>
                    <Text style={s.small}>{t('What you copied is shown here and goes into Copy results, so use a test invite only.')}</Text>
                    {button(t('Read what is copied'), () => void readWhatIsCopied(), 'device-check-read')}
                    {check.pasteButton ? (
                        <Clipboard.ClipboardPasteButton
                            onPress={(data) => add({ pasted: pastedOnly(data) })}
                            acceptedContentTypes={['plain-text', 'url']}
                            displayMode="iconOnly"
                            backgroundColor={colors.action.cta}
                            foregroundColor={colors.text.onBrand}
                            cornerStyle="large"
                            style={s.appleButton}
                        />
                    ) : (
                        <Text style={s.small}>{t("Apple's button needs an iPhone on iOS 16 or later.")}</Text>
                    )}
                    {rows(inviteRows(check))}
                    {inviteNotes().map((words) => <Text key={words} style={s.note}>{words}</Text>)}
                </View>

                <View style={s.section} testID="device-check-b">
                    <Text style={s.heading} accessibilityRole="header">{sectionB()}</Text>
                    {!IPHONE ? <Text style={s.body}>{iphoneOnly()}</Text> : (
                        <>
                            <View style={s.warning}>
                                <Text style={s.warningText}>
                                    {t('Only works on a phone where BeanPool has never asked about notifications (a fresh install). If it already asked, these buttons show the old answer.')}
                                </Text>
                            </View>
                            {button(t('1. Ask quietly'), () => void askQuietly(), 'device-check-ask-quietly')}
                            {button(t('2. Ask fully'), () => void askFully(), 'device-check-ask-fully')}
                            <Text style={s.note}>{notifyNote()}</Text>
                            {rows(notifyRows(check))}
                        </>
                    )}
                </View>

                {button(t('Copy results'), () => void copyResults(), 'device-check-copy', false)}
                <Text style={s.small}>{t('Copy results replaces what you copied, so do it last.')}</Text>
                {copied && (
                    <Text style={s.body} accessibilityLiveRegion="polite">
                        {copied === 'done' ? t('Results copied. Paste them in your message to us.') : t("The results couldn't be copied.")}
                    </Text>
                )}
                {onSignInProbe && (
                    <Pressable style={s.back} onPress={onSignInProbe} accessibilityRole="button">
                        <Text style={s.link}>{t('Sign in with Apple probe (development build)')}</Text>
                    </Pressable>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

function makeStyles({ colors }: ReturnType<typeof useTheme>) {
    return StyleSheet.create({
        page: { flex: 1, backgroundColor: colors.surface.page },
        scroll: { padding: 16, paddingBottom: 48 },
        back: { minHeight: 48, justifyContent: 'center', alignSelf: 'flex-start' },
        link: { color: colors.brand.primary, fontSize: 16, fontWeight: '700' },
        title: { fontSize: 22, fontWeight: '800', color: colors.text.heading, marginBottom: 12 },
        section: { borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card, borderRadius: 14, padding: 14, marginBottom: 16 },
        heading: { fontSize: 18, fontWeight: '800', color: colors.text.heading, marginBottom: 8 },
        body: { fontSize: 15, lineHeight: 21, color: colors.text.body },
        small: { fontSize: 13, lineHeight: 19, color: colors.text.secondary, marginTop: 6 },
        note: { fontSize: 14, lineHeight: 20, color: colors.text.heading, fontWeight: '600', marginTop: 10 },
        button: { minHeight: 52, borderRadius: 12, backgroundColor: colors.brand.fill, alignItems: 'center', justifyContent: 'center', padding: 12, marginTop: 12 },
        buttonText: { color: colors.text.onBrand, fontSize: 16, fontWeight: '800', textAlign: 'center' },
        disabled: { opacity: 0.5 },
        // Apple's button at the size the invite tile draws it (components/welcome/FrontDoor.tsx): full width, 52 dp.
        appleButton: { width: '100%', height: 52, marginTop: 12 },
        row: { borderTopWidth: 1, borderTopColor: colors.border.default, marginTop: 12, paddingTop: 10 },
        label: { fontSize: 15, fontWeight: '800', color: colors.text.heading, marginBottom: 2 },
        raw: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 12, lineHeight: 17, color: colors.text.secondary, marginTop: 4 },
        warning: { backgroundColor: colors.feedback.warning.bg, borderWidth: 1, borderColor: colors.feedback.warning.border, borderRadius: 12, padding: 12 },
        warningText: { color: colors.feedback.warning.fg, fontSize: 15, lineHeight: 21, fontWeight: '700' },
    });
}
