/**
 * Linking a computer asks the phone's lock first (app/pair-device.tsx; PR #1205's pair-device note).
 *
 * Scanning a desktop's pairing QR and tapping Confirm & Link Device sends the whole account (private key and 12 words,
 * encrypted to that desktop) with no check: anyone holding the unlocked phone, with a computer, could take the account.
 *
 * - The check is Settings' (LocalAuth.authenticateUser), asked before anything is read or sent. A phone with no lock is
 *   let through, as Settings lets it through.
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

    it("asks Settings' check", () => {
        expect(pair()).toContain("import { authenticateUser } from '../utils/LocalAuth';");
        expect(pair()).not.toContain('expo-local-authentication');
    });

    it('asks the lock before it reads the words or sends anything, and a check that does not pass does neither', () => {
        const body = confirm();
        const asked = body.indexOf("const passed = await authenticateUser('Confirm authentication to send your account to this computer.');");
        const refused = body.indexOf('if (!passed || scannedDataRef.current !== scanned) return;');
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
        const afterCheck = body.slice(body.indexOf('if (!passed || scannedDataRef.current !== scanned) return;'));
        expect(afterCheck).not.toContain('scannedData.');
        expect(afterCheck).toContain('scanned.desktopPubHex');
        expect(afterCheck).toContain('scanned.sessionId');
    });

    it('a second tap while the check is up asks once', () => {
        const body = confirm();
        expect(body).toMatch(/if \(!scannedData \|\| !identity \|\| isTransferring \|\| lockBusyRef\.current\) return;/);
        expect(body.indexOf('lockBusyRef.current = true;')).toBeLessThan(body.indexOf('await authenticateUser('));
        expect(body.indexOf('lockBusyRef.current = false;')).toBeGreaterThan(body.indexOf('await authenticateUser('));
    });
});
