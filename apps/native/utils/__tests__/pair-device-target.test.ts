/**
 * "Use your account on another device" sends the key and the 12 words only to a server this phone already uses
 * (utils/pair-device-target.ts; fable-security-signin finding 1, round 2). The relay's two digits hold only on an honest
 * server: a hand-made QR naming the sender's own server could skip them, so a QR naming any other host sends nothing.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { transferTarget } from '../pair-device-target';

const OWN = 'https://mullum.example';
const SAVED = ['https://castlemaine.example', 'https://other.example:8443'];

describe('transferTarget: only a server this phone uses', () => {
    it('the community the phone is on, however the QR writes it', () => {
        expect(transferTarget('https://MULLUM.example/', OWN, [])).toEqual({ kind: 'ok', nodeUrl: 'https://MULLUM.example/' });
        expect(transferTarget('https://mullum.example:443', OWN, [])).toEqual({ kind: 'ok', nodeUrl: 'https://mullum.example:443' });
    });

    it('a saved community, port and all', () => {
        expect(transferTarget('https://castlemaine.example', OWN, SAVED).kind).toBe('ok');
        expect(transferTarget('https://other.example:8443', OWN, SAVED).kind).toBe('ok');
    });

    it('a QR naming a foreign host is refused, naming that host', () => {
        expect(transferTarget('https://attacker.example', OWN, SAVED)).toEqual({ kind: 'foreign', scannedHost: 'attacker.example' });
        // Same name, another port or scheme: another server.
        expect(transferTarget('https://other.example', OWN, SAVED).kind).toBe('foreign');
        expect(transferTarget('http://mullum.example', OWN, SAVED).kind).toBe('foreign');
        // A look-alike.
        expect(transferTarget('https://mullum.example.attacker.example', OWN, SAVED).kind).toBe('foreign');
        // Not a server address at all.
        expect(transferTarget('javascript:alert(1)', OWN, SAVED).kind).toBe('foreign');
    });

    it('a phone on no community sends to no QR server', () => {
        expect(transferTarget('https://attacker.example', null, []).kind).toBe('foreign');
        expect(transferTarget('', null, [])).toEqual({ kind: 'no-node' });
    });

    it("a QR with no server goes to the phone's own", () => {
        expect(transferTarget('', OWN, SAVED)).toEqual({ kind: 'ok', nodeUrl: OWN });
    });
});

/** Code only: what a comment says is not what the screen does. */
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const pair = () => code(fs.readFileSync(path.resolve(__dirname, '../../app/pair-device.tsx'), 'utf-8'));

describe('pair-device: the rule is wired in (the screen cannot be rendered here, see vitest.config.ts)', () => {
    it('checks at scan, against the phone\'s community and its saved ones, and says a foreign host plainly', () => {
        const scan = pair().slice(pair().indexOf('async function handleBarcodeScanned('), pair().indexOf('async function handleConfirmLink('));
        expect(scan).toContain("const target = transferTarget(parsed.nodeUrl, anchor, saved);");
        expect(scan).toContain("await AsyncStorage.getItem('beanpool_anchor_url')");
        expect(scan).toContain('await getSavedNodes()');
        expect(pair()).toContain("t('This code is from a server your phone doesn\\'t use ({host}), so nothing was sent.");
    });

    it('a target that is not ok asks nothing, reads nothing and sends nothing; the send goes to the checked server', () => {
        const body = pair().slice(pair().indexOf('async function handleConfirmLink() {'));
        const refused = body.indexOf("if (!target || target.kind !== 'ok') {");
        expect(refused).toBeGreaterThan(-1);
        for (const later of ['await requireDeviceUnlock(', 'await getMnemonic(identity)', 'encryptPairingPayload(', 'await fetch(']) {
            expect(body.indexOf(later)).toBeGreaterThan(refused);
        }
        expect(body).toContain('const targetNode = target.nodeUrl;');
        expect(body).not.toContain('let targetNode = scanned.nodeUrl');
    });

    it('the Confirm button shows only for a server this phone uses', () => {
        expect(pair()).toMatch(/\{scannedData\?\.target\?\.kind === 'ok' && \(\s*<Pressable\s+style=\{\[styles\.confirmBtn/);
    });
});
