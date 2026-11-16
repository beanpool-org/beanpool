/**
 * The web's key code is the phone's key code (DESIGN-dm-key-signal-model §5, slice S3). A web member reads out "My key code"
 * and a phone member compares it with the code their phone shows for that person, so for the same key the two apps must
 * give the same 20 digits, every time. One table: the phone's own helper (apps/native/utils/key-code.ts, loaded as it is,
 * not copied), the web's (lib/key-code.ts), core's namesKeyCode and a second way of working it out (node's SHA-256).
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { namesKeyCode } from '@beanpool/core';
import { keyCodeOf, keyCodeSpoken } from './key-code';
import { dmListedPeer, dmKeyContext } from './dm-lock';

type PhoneHelper = { keyCodeOf: (k: string | null | undefined) => string | null; keyCodeSpoken: (c: string) => string };

/** The phone's helper file itself. Outside this app's tsc root, so it is loaded by path at run time. */
async function phoneHelper(): Promise<PhoneHelper> {
    const file = path.resolve(__dirname, '../../../native/utils/key-code.ts');
    return (await import(/* @vite-ignore */ file)) as PhoneHelper;
}

/** SHA-256 of "beanpool-key-code-v1\n" + the lower-case hex key, five 4-byte slices, each mod 10,000 (the phone test's oracle). */
function oracle(hex: string): string {
    const d = createHash('sha256').update(`beanpool-key-code-v1\n${hex.toLowerCase()}`, 'utf8').digest();
    return [0, 1, 2, 3, 4].map((g) => String(BigInt('0x' + d.subarray(g * 4, g * 4 + 4).toString('hex')) % 10000n).padStart(4, '0')).join(' ');
}

const FIXED_KEYS: Array<[string, string]> = [
    ['the phone test\'s pinned key', 'bb'.repeat(32)],
    ['all zeros', '00'.repeat(32)],
    ['all ff', 'ff'.repeat(32)],
    ['a counting key', Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join('')],
    ['capitals', 'AbCdEf0123456789'.repeat(4)],
    ['spaces around it', `  ${'7e'.repeat(32)}  `],
];

describe('the web key code equals the phone key code for the same key', () => {
    it('one table: phone helper = web helper = core namesKeyCode = a second way of working it out', async () => {
        const phone = await phoneHelper();
        const rows = [...FIXED_KEYS, ...Array.from({ length: 40 }, (_, i) => [`random ${i}`, randomBytes(32).toString('hex')] as [string, string])];
        for (const [what, key] of rows) {
            const web = keyCodeOf(key);
            expect(web, what).toMatch(/^\d{4} \d{4} \d{4} \d{4} \d{4}$/);
            expect(web, what).toBe(phone.keyCodeOf(key));
            expect(web, what).toBe(namesKeyCode(key.trim().toLowerCase()));
            expect(web, what).toBe(oracle(key.trim()));
            expect(keyCodeSpoken(web!), what).toBe(phone.keyCodeSpoken(web!));
        }
    });

    it('the pinned vector the phone test pins too: the same digits on every device and every version', async () => {
        const phone = await phoneHelper();
        expect(keyCodeOf('bb'.repeat(32))).toBe('1479 0507 0978 3849 9965');
        expect(phone.keyCodeOf('bb'.repeat(32))).toBe('1479 0507 0978 3849 9965');
    });

    it('anything that is not a 32-byte key gives no code, on both apps alike', async () => {
        const phone = await phoneHelper();
        for (const bad of [null, undefined, '', 'bb'.repeat(31), 'zz'.repeat(32), 'bb'.repeat(33), 'member-kofi']) {
            expect(keyCodeOf(bad)).toBeNull();
            expect(phone.keyCodeOf(bad)).toBeNull();
        }
    });

    it('is spoken digit by digit with a pause between groups, never as large numbers', () => {
        expect(keyCodeSpoken('4821 0937 5510 2284 6603')).toBe('4 8 2 1, 0 9 3 7, 5 5 1 0, 2 2 8 4, 6 6 0 3');
        const spoken = keyCodeSpoken(keyCodeOf(randomBytes(32).toString('hex'))!);
        expect(spoken).not.toMatch(/\d\d/);
    });
});

describe('dmListedPeer: the key a DM\'s code is shown for is the key its lines are sealed to', () => {
    const ME = 'aa'.repeat(32);
    const BEN = 'bb'.repeat(32);
    const CY = 'cc'.repeat(32);
    const me = { publicKey: ME, privateKey: 'k' };

    it('one other key listed: that key, the same one dmKeyContext seals to', () => {
        const conv = { id: 'dm-1', type: 'dm', participants: [ME, BEN] };
        expect(dmListedPeer(conv, ME)).toBe(BEN);
        expect(dmKeyContext(conv, me)?.peerEdPubHex).toBe(BEN);
    });

    it('the same key listed twice is still one key', () => {
        expect(dmListedPeer({ id: 'dm-1', type: 'dm', participants: [ME, BEN, BEN] }, ME)).toBe(BEN);
    });

    it('none or several other keys, or not a DM: no key, and nothing is sealed either', () => {
        const none = { id: 'dm-1', type: 'dm', participants: [ME] };
        const several = { id: 'dm-1', type: 'dm', participants: [ME, BEN, CY] };
        const group = { id: 'g-1', type: 'group_thread', participants: [ME, BEN] };
        for (const conv of [none, several, group, null]) {
            expect(dmListedPeer(conv, ME)).toBeNull();
            expect(dmKeyContext(conv, me)).toBeNull();
        }
        expect(dmListedPeer({ id: 'dm-1', type: 'dm', participants: [ME, null, '', BEN] }, ME)).toBe(BEN);
    });
});
