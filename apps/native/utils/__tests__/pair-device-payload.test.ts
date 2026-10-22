/**
 * "Link a device" from a phone whose copy of the account has no name (tester report, 22 Oct: a member of years saw the
 * browser say "Received incomplete identity payload", twice).
 *
 * Some joins and restores save the account with no name (draftIdentity(''), a restore whose community named nobody),
 * while the app shows the name from the community's member record, so nothing looks wrong until the link. The phone now
 * sends that member record's name in place of the empty one, and the sheet's Account row shows it; with none known it
 * sends the name empty (the browser then asks its community) and the row shows the key's short form. Only the name: the
 * key fields go as stored, and the phone's stored account is not written (a separate decision).
 *
 * The screen cannot be rendered here (see vitest.config.ts): its wiring is read from its source, as in
 * pair-device-behind-lock.test.ts. Keys here are made-up hex; none is printed.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pairingAccountLabel, pairingName, pairingPayload } from '../pair-device-payload';
import { isAppCommunity, transferTarget } from '../pair-device-target';

const PUB = 'ab'.repeat(32);
const PRIV = 'cd'.repeat(32);
const account = (callsign: string) => ({ callsign, publicKey: PUB, privateKey: PRIV, createdAt: '2024-03-01T00:00:00.000Z' });
const WORDS = Array.from({ length: 12 }, (_, i) => `word${i}`);

describe('the name sent with the account', () => {
    it("a phone's copy with a name: that name, whatever the member record says", () => {
        expect(pairingName('Sam', 'Samuel')).toBe('Sam');
        expect(pairingName('Sam', null)).toBe('Sam');
    });

    it('a copy with no name: the member record\'s name for the account', () => {
        expect(pairingName('', 'Alice')).toBe('Alice');
        expect(pairingName(undefined, 'Alice')).toBe('Alice');
        expect(pairingName('   ', 'Alice')).toBe('Alice');
    });

    it('no name anywhere: sent empty, never one made up', () => {
        expect(pairingName('', null)).toBe('');
        expect(pairingName('', undefined)).toBe('');
        expect(pairingName('', '  ')).toBe('');
    });
});

describe('the payload', () => {
    it('carries the member record\'s name for a copy with none, and the key fields exactly as stored', () => {
        const p = pairingPayload(account(''), WORDS, 'Alice');
        expect(p.callsign).toBe('Alice');
        expect(p.publicKey === PUB && p.privateKey === PRIV).toBe(true);
        expect(p.mnemonic).toBe(WORDS);
        expect(p.createdAt).toBe('2024-03-01T00:00:00.000Z');
        expect(p.version).toBe(1);
        expect(Object.keys(p).sort()).toEqual(['callsign', 'createdAt', 'mnemonic', 'privateKey', 'publicKey', 'version']);
    });

    it('no name known: the name goes empty (the browser asks its community), the keys still go', () => {
        const p = pairingPayload(account(''), WORDS, null);
        expect(p.callsign).toBe('');
        expect(p.publicKey === PUB && p.privateKey === PRIV).toBe(true);
    });

    it('a copy with a name: as before', () => {
        expect(pairingPayload(account('Sam'), WORDS, 'Samuel').callsign).toBe('Sam');
    });

    it('no 12 words on the phone: none sent, as before', () => {
        expect(pairingPayload(account('Sam'), null, null).mnemonic).toBeUndefined();
    });
});

describe("the sheet's Account row", () => {
    it('the name that is sent', () => {
        expect(pairingAccountLabel(account('Sam'), null)).toBe('Sam');
        expect(pairingAccountLabel(account(''), 'Alice')).toBe('Alice');
    });

    it('no name known: the key\'s short form, as the members list shows a member with no name; never blank', () => {
        expect(pairingAccountLabel(account(''), null)).toBe(PUB.slice(0, 8));
    });
});

describe('whose member record names the account', () => {
    const OWN = 'https://mullum.example';
    const SAVED = ['https://castlemaine.example'];

    it('the community this phone is on: its member rows are the ones on the phone', () => {
        expect(isAppCommunity(transferTarget('', OWN, SAVED), OWN)).toBe(true);
        expect(isAppCommunity(transferTarget(OWN, OWN, SAVED), OWN)).toBe(true);
        expect(isAppCommunity(transferTarget(`${OWN}/`, `${OWN}/`, SAVED), `${OWN}/`)).toBe(true);
    });

    it('another saved community, a refused code, or none: not this phone\'s rows (its own name is asked for there)', () => {
        expect(isAppCommunity(transferTarget(SAVED[0], OWN, SAVED), OWN)).toBe(false);
        expect(isAppCommunity(transferTarget('https://evil.example', OWN, SAVED), OWN)).toBe(false);
        expect(isAppCommunity(transferTarget('', null, SAVED), null)).toBe(false);
        expect(isAppCommunity(undefined, OWN)).toBe(false);
    });
});

/** Code only: what a comment says is not what the screen does. */
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const pair = () => code(fs.readFileSync(path.resolve(__dirname, '../../app/pair-device.tsx'), 'utf-8'));

describe('pair-device.tsx wiring', () => {
    it('seals pairingPayload, with the name the sheet showed, never identity.callsign on its own', () => {
        const confirm = pair().slice(pair().indexOf('async function handleConfirmLink() {'));
        expect(confirm).toMatch(/encryptPairingPayload\(\s*pairingPayload\(identity, mnemonic, /);
        expect(pair()).not.toMatch(/callsign:\s*identity\.callsign/);
    });

    it("the Account row shows pairingAccountLabel, not the stored name, which can be blank", () => {
        expect(pair()).toMatch(/<Text style=\{styles\.infoValue\}>\{identity \? pairingAccountLabel\(identity, /);
        expect(pair()).not.toContain('{identity?.callsign}');
    });

    it('reads the member record only for the community this phone is on, and writes nothing to the stored account', () => {
        expect(pair()).toMatch(/isAppCommunity\(target, anchor\)/);
        expect(pair()).toContain('getMemberProfile(');
        for (const write of ['updateCallsign', 'saveIdentity', 'setIdentity']) expect(pair()).not.toContain(write);
    });
});
