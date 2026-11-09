import React, { useCallback, useEffect, useRef } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { invitePictureCode } from '@beanpool/core';
import { palette } from '../constants/colors';

/**
 * The QR picture Share sends with an invite (utils/invite-picture-share.ts; the web app's lib/invite-picture.ts is the same
 * picture): the invite's QR on white with its code printed under it, drawn out of sight and captured to a PNG file in the
 * cache. 320 × 360 dp, captured at twice that (640 × 720 px). It is the same on every phone and in every theme, because it is
 * read in someone else's chat: dark on white, and its code never scaled with the phone's text size.
 *
 * Mounted only while a share is being made. `onCaptured` gets the file's address, or null when it could not be made.
 */
const WIDTH_DP = 320;
const HEIGHT_DP = 360;
const QR_DP = 256;
const OUT_PX = { width: WIDTH_DP * 2, height: HEIGHT_DP * 2 };
/** The map pins' own wait (components/UnifiedMapPin.tsx): the QR's SVG has drawn by the time it is over. */
const DRAW_MS = 200;

export function InvitePictureShot({ code, value, onCaptured }: { code: string; value: string; onCaptured: (uri: string | null) => void }) {
    const shot = useRef<View>(null);
    const started = useRef(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const done = useRef(onCaptured);
    done.current = onCaptured;

    const capture = useCallback(async () => {
        if (started.current) return;
        started.current = true;
        try {
            // Loaded here, not at the top: the screen that mounts this card is loaded by many tests, and the capture module
            // is a native one that only a phone loads.
            const { captureRef } = await import('react-native-view-shot');
            const uri = await captureRef(shot, { format: 'png', quality: 1, result: 'tmpfile', ...OUT_PX });
            done.current(uri || null);
        } catch {
            done.current(null);
        }
    }, []);

    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

    return (
        <View style={styles.offscreen} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <View
                ref={shot}
                collapsable={false}
                onLayout={() => { if (!timer.current) timer.current = setTimeout(() => { void capture(); }, DRAW_MS); }}
                style={styles.sheet}
            >
                <QRCode value={value} size={QR_DP} color={palette.black} backgroundColor={palette.white} />
                <Text allowFontScaling={false} numberOfLines={1} style={styles.code}>{invitePictureCode(code)}</Text>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    // Out of sight, but drawn: a view that is not laid out cannot be captured (as the map pins').
    offscreen: { position: 'absolute', left: -9999, top: -9999, opacity: 1 },
    sheet: { width: WIDTH_DP, height: HEIGHT_DP, backgroundColor: palette.white, alignItems: 'center', justifyContent: 'center' },
    code: {
        marginTop: 16,
        height: 24,
        lineHeight: 24,
        fontSize: 20,
        fontWeight: '700',
        color: palette.green950,
        fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    },
});
