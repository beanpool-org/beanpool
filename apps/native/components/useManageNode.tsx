/**
 * The "Manage <community>" press, shared by Settings (NodeAdminEntry) and the header's 🛡️ needs-you icon:
 * phone unlock → signed challenge → one-time sign-in link → the node's /settings (optionally at a section)
 * in an in-app browser tab, with the node's own 2FA prompt when it asks. utils/node-admin.ts has the steps.
 *
 * Returns `start` for the press and `dialog`, the 2FA prompt, which the caller renders.
 */
import React, { useState } from 'react';
import { Alert, Keyboard } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useIdentity } from '../app/IdentityContext';
import { anchorUrl as getAnchorUrl } from '../utils/node-post';
import { TotpCodeDialog, looksLikeTotpCode } from './TotpCodeDialog';
import { manageNode, NO_DEVICE_LOCK_MESSAGE, type ManageOutcome, type SettingsSection } from '../utils/node-admin';

export function useManageNode() {
    const { identity } = useIdentity();
    const [busy, setBusy] = useState(false);
    const [name, setName] = useState('this community');
    const [totp, setTotp] = useState<{ continueWith: (code: string) => Promise<ManageOutcome>; wrongCode: boolean } | null>(null);
    const [code, setCode] = useState('');

    const handle = (out: ManageOutcome, communityName: string) => {
        switch (out.kind) {
            case 'opened':
                setTotp(null);
                setCode('');
                return;
            case 'totp-required':
                setTotp({ continueWith: out.continueWith, wrongCode: out.wrongCode });
                setCode('');
                return;
            case 'no-device-lock':
                Alert.alert('Set a screen lock first', NO_DEVICE_LOCK_MESSAGE);
                return;
            case 'unlock-failed':
                return; // They cancelled, or the phone said no. Nothing to explain.
            case 'refused':
                setTotp(null);
                Alert.alert(`Can't open ${communityName}'s settings`, out.message);
                return;
            case 'error':
                setTotp(null);
                Alert.alert(`Can't open ${communityName}'s settings`, out.message);
                return;
        }
    };

    const start = async (communityName: string, section?: SettingsSection) => {
        if (busy || !identity) return;
        setBusy(true);
        setName(communityName);
        try {
            const url = await getAnchorUrl();
            if (!url) { Alert.alert('Not connected', 'Connect to your community first.'); return; }
            handle(await manageNode({
                nodeUrl: url,
                identity,
                communityName,
                section,
                openUrl: (u) => WebBrowser.openBrowserAsync(u),
            }), communityName);
        } finally {
            setBusy(false);
        }
    };

    const submitCode = async () => {
        if (!totp || busy || !looksLikeTotpCode(code)) return;
        Keyboard.dismiss();
        setBusy(true);
        try {
            handle(await totp.continueWith(code), name);
        } finally {
            setBusy(false);
        }
    };

    const dialog = (
        <TotpCodeDialog
            visible={!!totp}
            communityName={name}
            wrongCode={!!totp?.wrongCode}
            busy={busy}
            code={code}
            onChangeCode={setCode}
            onSubmit={submitCode}
            onCancel={() => { setTotp(null); setCode(''); }}
            submitLabel="Open settings"
        />
    );

    return { busy, start, dialog };
}
