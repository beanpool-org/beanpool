/**
 * Round 4 of computer-line (the deciding review of round 3, BLOCKING): the address "Use BeanPool on a computer" tells a member to
 * open and Link a device (the row under it) must never disagree. Round 3 showed the community's main address (byron.beanpool.org) to a
 * phone still on mullum.beanpool.org; the computer's page at byron shows a Link a device code that names byron, and the phone's
 * transferTarget accepts only its own anchor or a saved community, so Link a device refused it ("This code is for byron.beanpool.org.
 * Your phone uses mullum.beanpool.org"). Everything here runs the REAL functions: core's mainAddressToOpen and the phone's
 * transferTarget, no mock of either.
 */
import { describe, expect, it } from 'vitest';
import { addressToOpenOnAComputer, mainAddressToOpen } from '@beanpool/core';
import { computerAddressForThisPhone } from '../computer-address';
import { transferTarget } from '../pair-device-target';

const MULLUM = 'https://mullum.beanpool.org';
const BYRON = 'https://byron.beanpool.org';
const CASTLE = 'https://castlemaine.beanpool.org';
const BYRON_NAMES = { primaryAddress: 'byron.beanpool.org', addresses: ['byron.beanpool.org', 'mullum.beanpool.org'] };

/** Would Link a device take the code a computer's page at `address` shows, on a phone with this anchor and these saved communities? */
const linkADeviceTakes = (address: string, anchor: string | null, saved: readonly string[]) => transferTarget(address, anchor, saved).kind === 'ok';

describe('the address the row shows, against what Link a device takes', () => {
    it('the case the review measured: mullum anchor + byron primary, byron not saved: mullum, which Link a device takes (byron it refuses)', () => {
        // The old rule's answer, and Link a device on it:
        expect(mainAddressToOpen(`${MULLUM}/`, BYRON_NAMES)).toBe(BYRON);
        expect(transferTarget(BYRON, `${MULLUM}/`, []).kind).toBe('foreign');
        // The new rule's:
        const shown = computerAddressForThisPhone(`${MULLUM}/`, BYRON_NAMES, []);
        expect(shown).toBe(MULLUM);
        expect(transferTarget(shown!, `${MULLUM}/`, []).kind).toBe('ok');
    });

    it('byron anchor: byron, which Link a device takes', () => {
        const shown = computerAddressForThisPhone(BYRON, BYRON_NAMES, []);
        expect(shown).toBe(BYRON);
        expect(transferTarget(shown!, BYRON, []).kind).toBe('ok');
    });

    it('mullum anchor + byron primary, with byron saved on the phone: byron, which Link a device takes', () => {
        for (const saved of [[MULLUM, BYRON], [`${MULLUM}/`, `${BYRON}/`], [BYRON]]) {
            const shown = computerAddressForThisPhone(`${MULLUM}/`, BYRON_NAMES, saved);
            expect(shown, saved.join(',')).toBe(BYRON);
            expect(transferTarget(shown!, `${MULLUM}/`, saved).kind, saved.join(',')).toBe('ok');
        }
    });

    it('a saved list of other communities does not make the main address welcome', () => {
        expect(computerAddressForThisPhone(MULLUM, BYRON_NAMES, [MULLUM, CASTLE])).toBe(MULLUM);
    });

    it('no answer from the community, or no main address: the phone\'s own address', () => {
        for (const info of [null, undefined, {}, { addresses: ['byron.beanpool.org'] }, { primaryAddress: 'evil.example', addresses: ['mullum.beanpool.org'] }]) {
            expect(computerAddressForThisPhone(`${MULLUM}/`, info as never, [BYRON]), JSON.stringify(info)).toBe(MULLUM);
        }
    });

    it('a plain-http address (a home network\'s) keeps itself, as before', () => {
        expect(computerAddressForThisPhone('http://192.168.1.20:3000', BYRON_NAMES, [BYRON])).toBe('http://192.168.1.20:3000');
    });

    it('no address on the phone: nothing, so no row', () => {
        for (const anchor of [null, undefined, '', 'Detecting...', 'ftp://byron.beanpool.org']) {
            expect(computerAddressForThisPhone(anchor, BYRON_NAMES, [BYRON]), String(anchor)).toBeNull();
        }
    });

    it('for EVERY https case, the address shown is one Link a device takes a code from (the row and Link a device cannot disagree)', () => {
        const anchors = [MULLUM, `${MULLUM}/`, BYRON, `${BYRON}/`, CASTLE, 'https://Mullum.BeanPool.org'];
        const primaries = ['byron.beanpool.org', 'mullum.beanpool.org', 'castlemaine.beanpool.org', 'evil.example', '', 'mullum.local', '203.0.113.7'];
        const savedSets: string[][] = [[], [MULLUM], [BYRON], [MULLUM, BYRON], [`${MULLUM}/`, `${BYRON}/`, CASTLE], [CASTLE]];
        let cases = 0;
        for (const anchor of anchors) {
            for (const primary of primaries) {
                for (const saved of savedSets) {
                    const info = { primaryAddress: primary, addresses: [primary, 'mullum.beanpool.org', 'byron.beanpool.org', 'castlemaine.beanpool.org'] };
                    const shown = computerAddressForThisPhone(anchor, info, saved);
                    const label = `${anchor} + ${primary || '(none)'} + [${saved.join(',')}]`;
                    expect(shown, label).not.toBeNull();
                    // Link a device always takes a code from the shown address...
                    expect(linkADeviceTakes(shown!, anchor, saved), label).toBe(true);
                    // ...and it is either the phone's own address or the community's main one (never an address nobody named).
                    expect([addressToOpenOnAComputer(anchor), mainAddressToOpen(anchor, info)], label).toContain(shown);
                    cases++;
                }
            }
        }
        expect(cases).toBe(anchors.length * primaries.length * savedSets.length);
    });
});
