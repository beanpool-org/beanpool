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
import { t, word, type WordKey } from '@beanpool/core';
import { settingsLineWords } from './settings/settings-lines';
import type { BeanPoolIdentity } from '../utils/identity';

/**
 * utils/node-admin.ts signs the sign-in with the member's key, so it never reaches the words layer: its own sentences are
 * worded again here, by their exact English, and shown in the member's language. A node's own words are shown as it
 * sent them (slice S4). Its phone-lock prompt ("Confirm it's you to manage …") stays English: it is written inside
 * node-admin.ts, and this press has no way to hand it other words without changing that file.
 */
const MANAGE_LINES: Readonly<Record<string, WordKey>> = {
    // NO_DEVICE_LOCK_MESSAGE.
    "Managing or moderating a community opens its settings signed in as you, so BeanPool asks for your phone's own unlock first — fingerprint, face or PIN. This phone has no screen lock set, so anyone holding it could do the same. Set a screen lock in your phone’s settings, then try again.": word("Managing or moderating a community opens its settings signed in as you, so BeanPool asks for your phone's own unlock first — fingerprint, face or PIN. This phone has no screen lock set, so anyone holding it could do the same. Set a screen lock in your phone’s settings, then try again."),
    // requestSettingsLink's own refusals, when the node gave no words.
    'The node refused the request.': word('The node refused the request.'),
    'You do not hold an owner, admin or moderator role on this node.': word('You do not hold an owner, admin or moderator role on this node.'),
    'Could not reach the node.': word('Could not reach the node.'),
    // utils/member-statements.ts UNSIGNABLE_CHALLENGE_MESSAGE: a challenge the phone won't sign.
    "This community's server asked BeanPool to sign something that isn't a sign-in, so nothing was signed. Try again later, or ask the community’s owner to update its server.": word("This community's server asked BeanPool to sign something that isn't a sign-in, so nothing was signed. Try again later, or ask the community’s owner to update its server."),
};

/** One of node-admin's sentences in the member's language; the node's own words (or a member's) exactly as given. */
export function manageLineWords(english: string): string {
    if (Object.prototype.hasOwnProperty.call(MANAGE_LINES, english)) return t(MANAGE_LINES[english]);
    const status = english.match(/^The node did not answer \((\d+)\)\.$/);
    if (status) return t('The node did not answer ({status}).', { status: status[1] });
    // utils/node-url.ts UNSAFE_NODE_ADDRESS_MESSAGE, among Settings' own.
    return settingsLineWords(english);
}

/**
 * `account`: the key to sign in with when it is not yet the app's (the claim's owner card at the end of the join wizard,
 * app/welcome.tsx, before the wizard hands the account to the app). Otherwise the app's own account.
 */
export function useManageNode(account?: BeanPoolIdentity | null) {
    const { identity: appAccount } = useIdentity();
    const identity = account ?? appAccount;
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
                Alert.alert(t('Set a screen lock first'), manageLineWords(NO_DEVICE_LOCK_MESSAGE));
                return;
            case 'unlock-failed':
                return; // They cancelled, or the phone said no. Nothing to explain.
            case 'refused':
                setTotp(null);
                Alert.alert(t("Can't open {name}'s settings", { name: communityName }), manageLineWords(out.message));
                return;
            case 'error':
                setTotp(null);
                Alert.alert(t("Can't open {name}'s settings", { name: communityName }), manageLineWords(out.message));
                return;
        }
    };

    const start = async (communityName: string, section?: SettingsSection) => {
        if (busy || !identity) return;
        setBusy(true);
        setName(communityName);
        try {
            const url = await getAnchorUrl();
            if (!url) { Alert.alert(t('Not connected'), t('Connect to your community first.')); return; }
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
            submitLabel={t('Open settings')}
        />
    );

    return { busy, start, dialog };
}
