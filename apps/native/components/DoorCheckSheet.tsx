import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { t } from '@beanpool/core';
import type { AppColors } from '../constants/colors';
import { CHECK_PAGE_ORIGINS, checkPageMayLoad, doorCheckUrl, readCheckMessage, type AskDoorCheck, type DoorCheck, type DoorCheckResult } from '../utils/door-check';

/** How long the page has to bring up its widget before the check counts as not loading. */
export const CHECK_LOAD_WAIT_MS = 30_000;

/**
 * The person check at the tap that needs it (utils/door-check.ts): the check's own page, in an embedded browser. Never a
 * dead end: Close, a page that fails, or a widget that doesn't come in time each end it, and the door's screen says what
 * happened beside the sign-in. At 320dp with 1.3x text the title wraps; the widget is the page's, and fits.
 */
export function DoorCheckSheet({ check, publicKey, dark, colors, onDone }: {
    check: DoorCheck;
    publicKey: string;
    dark: boolean;
    colors: AppColors;
    onDone: (result: DoorCheckResult) => void;
}): React.JSX.Element {
    const uri = useMemo(() => doorCheckUrl(check, publicKey, dark ? 'dark' : 'light'), [check, publicKey, dark]);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const stopTimer = useCallback(() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
    }, []);
    useEffect(() => {
        timer.current = setTimeout(() => onDone({ kind: 'failed' }), CHECK_LOAD_WAIT_MS);
        return stopTimer;
    }, [onDone, stopTimer]);

    const heard = useCallback((data: string, url: string) => {
        const said = readCheckMessage(data, url, check.page);
        if (!said) return;
        stopTimer();
        if ('token' in said) onDone({ kind: 'token', token: said.token });
        else if ('error' in said) onDone({ kind: 'failed' });
    }, [check.page, onDone, stopTimer]);

    const close = () => onDone({ kind: 'closed' });
    return (
        <Modal visible animationType="slide" onRequestClose={close}>
            {/* surface.app, as every full-screen sheet: surface.page is see-through under the pattern background. */}
            <SafeAreaView style={[styles.sheet, { backgroundColor: colors.surface.app }]} edges={['top', 'bottom', 'left', 'right']}>
                <View style={[styles.header, { borderBottomColor: colors.border.default }]}>
                    <Text style={[styles.title, { color: colors.text.heading }]} accessibilityRole="header">{t('A quick check')}</Text>
                    <Pressable style={styles.close} onPress={close} accessibilityRole="button" accessibilityLabel={t('Close')}>
                        <Text style={[styles.closeText, { color: colors.text.heading }]}>{t('Close')}</Text>
                    </Pressable>
                </View>
                <Text style={[styles.line, { color: colors.text.secondary }]}>
                    {t('Lots of people are joining right now, so Cloudflare checks you are a person. It only takes a moment.')}
                </Text>
                <WebView
                    source={{ uri }}
                    style={[styles.page, { backgroundColor: colors.surface.app }]}
                    originWhitelist={CHECK_PAGE_ORIGINS}
                    javaScriptEnabled
                    domStorageEnabled
                    thirdPartyCookiesEnabled
                    setSupportMultipleWindows={false}
                    onShouldStartLoadWithRequest={(r) => checkPageMayLoad(r.url, r.isTopFrame, check.page)}
                    onMessage={(e) => heard(e.nativeEvent.data, e.nativeEvent.url)}
                    onError={() => onDone({ kind: 'failed' })}
                    onHttpError={() => onDone({ kind: 'failed' })}
                />
            </SafeAreaView>
        </Modal>
    );
}

/** A door screen's person check: `ask` opens it and answers when it is over, and `sheet` is drawn while it is open. */
export function useDoorCheck(colors: AppColors, dark: boolean): { ask: AskDoorCheck; sheet: React.JSX.Element | null } {
    const [open, setOpen] = useState<{ check: DoorCheck; publicKey: string; done: (r: DoorCheckResult) => void } | null>(null);
    const ask = useCallback<AskDoorCheck>((check, publicKey) => new Promise((done) => setOpen({ check, publicKey, done })), []);
    const finish = useCallback((result: DoorCheckResult) => {
        setOpen((now) => {
            now?.done(result);
            return null;
        });
    }, []);
    const sheet = open ? <DoorCheckSheet check={open.check} publicKey={open.publicKey} dark={dark} colors={colors} onDone={finish} /> : null;
    return { ask, sheet };
}

const styles = StyleSheet.create({
    sheet: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1 },
    title: { flex: 1, fontSize: 18, fontWeight: '700' },
    close: { minHeight: 44, justifyContent: 'center', paddingLeft: 16 },
    closeText: { fontSize: 16, fontWeight: '600' },
    line: { fontSize: 14, lineHeight: 20, paddingHorizontal: 16, paddingVertical: 12 },
    page: { flex: 1 },
});
