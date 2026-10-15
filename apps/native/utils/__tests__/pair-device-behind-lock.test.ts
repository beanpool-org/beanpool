/**
 * Linking a computer asks the phone's lock first (app/pair-device.tsx; PR #1205's pair-device note).
 *
 * Scanning a desktop's pairing QR and tapping Confirm & Link Device sends the whole account (private key and 12 words,
 * encrypted to that desktop) with no check: anyone holding the unlocked phone, with a computer, could take the account.
 *
 * - The check is Manage's (node-admin.requireDeviceUnlock), asked before anything is read or sent. It fails closed: a phone
 *   with no screen lock sends nothing and is told, in plain words, how to set one (fable-security-signin finding 1: the
 *   old check, LocalAuth.authenticateUser, let a lockless phone through).
 * - The relay hands back two digits; the phone shows them and the other device types them before it gets anything.
 * - A check that doesn't pass reads nothing and sends nothing, and the sheet stays as it was.
 * - One that answers after the sheet was closed (or another code scanned) sends nothing; a second tap asks once.
 *
 * The screen cannot be rendered here (see vitest.config.ts): its wiring is read from its source.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Code only: what a comment says is not what the screen does. */
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const pair = () => code(fs.readFileSync(path.resolve(__dirname, '../../app/pair-device.tsx'), 'utf-8'));
/** From `start` to the first `end` after it. */
function slice(s: string, start: string, end: string): string {
    const from = s.indexOf(start);
    expect(from, `missing: ${start}`).toBeGreaterThan(-1);
    const to = s.indexOf(end, from + start.length);
    expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(from);
    return s.slice(from, to);
}
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe('pair-device: Confirm & Link Device', () => {
    const confirm = () => slice(pair(), 'async function handleConfirmLink() {', '\n    }\n');

    it("asks Manage's check, which fails closed, not the one that lets a lockless phone through", () => {
        expect(pair()).toContain("import { requireDeviceUnlock } from '../utils/node-admin';");
        expect(pair()).not.toContain('authenticateUser');
        expect(pair()).not.toContain('expo-local-authentication');
    });

    it('refuses on a phone with no screen lock, saying how to set one, and sends nothing', () => {
        const body = confirm();
        const noLock = slice(body, "if (unlock === 'no-device-lock'", 'return;');
        expect(noLock).toContain('setErrorMessage(t(');
        expect(noLock).toMatch(/no screen lock[\s\S]*Set a PIN, pattern or password/);
        // Before anything is read, sealed or sent.
        for (const later of ['setIsTransferring(true)', 'await getMnemonic(identity)', 'encryptPairingPayload(', 'await fetch(']) {
            expect(body.indexOf(later)).toBeGreaterThan(body.indexOf(noLock));
        }
        expect(body).toContain("if (unlock !== 'ok' || scannedDataRef.current !== scanned) return;");
    });

    it('shows the two digits the relay gives back, and stops on a relay that gives none', () => {
        const body = confirm();
        expect(body).toContain('setConfirmCode(code)');
        expect(body).toMatch(/if \(!code\) throw new Error\(t\(/);
        expect(pair()).toContain("t('Type these two digits on the other device')");
        expect(body).not.toContain('router.back()');
    });

    it("the sheet says the key AND the 12 words go, and to scan only a code on a screen in front of you", () => {
        expect(pair()).toContain("The other device receives this account\\'s key AND your 12 words");
        expect(pair()).toContain('Only scan a code on a screen in front of you');
    });

    it('asks the lock before it reads the words or sends anything, and a check that does not pass does neither', () => {
        const body = confirm();
        const asked = body.indexOf("const unlock = await requireDeviceUnlock('', t('Confirm it is you to send your account to another device.'));");
        const refused = body.indexOf("if (unlock !== 'ok' || scannedDataRef.current !== scanned) return;");
        const busy = body.indexOf('setIsTransferring(true)');
        const words = body.indexOf('await getMnemonic(identity)');
        const sealed = body.indexOf('encryptPairingPayload(');
        const sent = body.indexOf('await fetch(');
        expect(asked).toBeGreaterThan(-1);
        expect(refused).toBeGreaterThan(asked);
        for (const after of [busy, words, sealed, sent]) expect(after).toBeGreaterThan(refused);
        // The one read of the words, and the one send, are these.
        expect(count(pair(), 'getMnemonic(')).toBe(1);
        expect(count(pair(), 'encryptPairingPayload(')).toBe(1);
    });

    it('sends to the code the member confirmed, not one scanned while the check was up', () => {
        const body = confirm();
        expect(body).toContain('const scanned = scannedData;');
        expect(pair()).toMatch(/const scannedDataRef = useRef\(scannedData\);\s*scannedDataRef\.current = scannedData;/);
        const afterCheck = body.slice(body.indexOf("if (unlock !== 'ok' || scannedDataRef.current !== scanned) return;"));
        expect(afterCheck).not.toContain('scannedData.');
        expect(afterCheck).toContain('scanned.desktopPubHex');
        expect(afterCheck).toContain('scanned.sessionId');
    });

    it('a second tap while the check is up asks once', () => {
        const body = confirm();
        expect(body).toMatch(/if \(!scannedData \|\| !identity \|\| isTransferring \|\| lockBusyRef\.current\) return;/);
        expect(body.indexOf('lockBusyRef.current = true;')).toBeLessThan(body.indexOf('await requireDeviceUnlock('));
        expect(body.indexOf('lockBusyRef.current = false;')).toBeGreaterThan(body.indexOf('await requireDeviceUnlock('));
    });
});
