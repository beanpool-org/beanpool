import React, { useEffect, useState } from 'react';
import { Modal, StatusBar, type ModalProps } from 'react-native';

/**
 * A React Native Modal whose content is dark in every theme (a camera scanner, a full-size photo on near-black): it shows
 * light status-bar icons over that content, in Light too, and gives the screen's own bar back when it closes.
 *
 * Why a Modal needs this (Android, edge-to-edge, React Native 0.83): the Modal is its own dialog window, drawn under the
 * status bar, and when it shows it COPIES the screen's light/dark bar into that window, once
 * (ReactModalHostView.updateSystemAppearance). A StatusBar mounted inside the Modal comes too late: the stack applies it on
 * a setImmediate, after the dialog has copied the old one, and the dialog never reads the screen's bar again. So in Light the
 * camera showed dark icons on black (the review of #3274: rekey-code, claim-community and ScanCodeModal).
 *
 * So the light bar goes on first, then the Modal opens: on `visible`, a light entry is pushed on React Native's status-bar
 * stack (StatusBar.pushStackEntry: the newest entry wins, and its flush to the phone is queued now, on a setImmediate, which is
 * a microtask in bridgeless React Native), and the Modal itself is asked to show on a microtask queued after that flush: the
 * flush sends the light style to the phone before React even draws the Modal (React's render is a later task), so the dialog
 * copies light icons. Closing (or unmounting) takes the entry off, so the screen under it reads its own bar again.
 * status-bar-every-screen.test.ts holds every dark Modal in the app to this.
 */
export function LightBarModal({ visible = true, ...props }: ModalProps) {
    const [shown, setShown] = useState(false);
    useEffect(() => {
        if (!visible) {
            setShown(false);
            return;
        }
        let live = true;
        const entry = StatusBar.pushStackEntry({ barStyle: 'light-content' });
        queueMicrotask(() => { if (live) setShown(true); });
        return () => {
            live = false;
            StatusBar.popStackEntry(entry);
        };
    }, [visible]);
    return <Modal {...props} visible={visible && shown} />;
}
