/**
 * Arriving at the names list from a member's profile (invites-vouching I4; DESIGN-invites-vouching-review-fable.md §3 ask 2):
 * `act=add` opens the one-step add-and-confirm form with the name prefilled with the callsign, and the save adds the entry
 * and then confirms that member against it; `act=make` opens Make a voucher for the member's confirmed entry. The screen is
 * heavy (the names list's keys, pins and sealing), so these are source pins on names-list.tsx in the style of
 * invite-revoke-render.test.ts; the profile button that sends the params is rendered in profile-voucher-button-render.test.ts,
 * and the node's refusals on confirming are tested in names-list.test.ts and the server's test-names-list.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '..', '..', 'app', 'names-list.tsx'), 'utf8');

describe('names-list.tsx, arrived at from a profile', () => {
    it('reads the three params, once, only a 64-hex member key, and only when the list is open', () => {
        expect(src).toMatch(/useLocalSearchParams<\{ community\?: string; act\?: string; forMember\?: string; forCallsign\?: string \}>\(\)/);
        expect(src).toMatch(/if \(arrived\.current === arrival \|\| !opened \|\| !list \|\| loading\) return;/);
        expect(src).toMatch(/\(params\.act !== 'add' && params\.act !== 'make'\) \|\| !\/\^\[0-9a-f\]\{64\}\$\/\.test\(member\)/);
        expect(src).toMatch(/arrived\.current = arrival;/);
    });

    it('add: the form opens with the callsign as the name, a fresh entry id, and the member to confirm', () => {
        expect(src).toMatch(/setName\(forCallsign\);/);
        expect(src).toMatch(/setMode\(\{ kind: 'edit', entry: null, addId: newEntryId\(\), confirmFor: \{ publicKey: member, callsign: forCallsign \} \}\);/);
    });

    it('the save adds the entry, then confirms the member against the entry just added (never a second path)', () => {
        const save = src.slice(src.indexOf('const save = async () => {'), src.indexOf('const confirmNewEntry'));
        expect(save).toMatch(/saveNamesEntry\(anchor, identity, STORE, opened, \{ name, note \}, mode\.entry\?\.id, mode\.addId\)/);
        expect(save).toMatch(/const confirmFor = mode\.confirmFor;/);
        expect(save).toMatch(/if \(confirmFor\) await confirmNewEntry\(sent\.value\.id, confirmFor, name\);/);
        // The confirm runs only after the entry landed: the early return on a refused add comes first.
        expect(save.indexOf('if (!sent.ok)')).toBeLessThan(save.indexOf('confirmNewEntry'));
        const confirm = src.slice(src.indexOf('const confirmNewEntry'), src.indexOf('const remove = '));
        expect(confirm).toMatch(/confirmMember\(anchor, identity, who\.publicKey, entryId\)/);
        expect(confirm).toMatch(/if \(!done\.ok\) \{ setError\(done\.message\); return; \}/);
        expect(confirm).toMatch(/done\.value\.status === 'awaiting_second'/);
    });

    it('the form says what it does: Add and confirm @name, and to confirm only someone you know', () => {
        expect(src).toMatch(/t\('Add and confirm @\{member\}', \{ member: mode\.confirmFor\.callsign \}\)/);
        expect(src).toMatch(/t\('Confirm only someone you know is them\.'\)/);
    });

    it('make: opens Make a voucher for that member’s confirmed entry, only where the rules allow it', () => {
        expect(src).toMatch(/entries\.find\(\(x\) => x\.confirmation\?\.memberPubkey === member\)/);
        expect(src).toMatch(/if \(mine\?\.confirmation && canMakeVoucher\(mine, isCommittee, identity\?\.publicKey\)\) \{/);
        expect(src).toMatch(/setMode\(\{ kind: 'make_voucher', entry: mine, memberPubkey: member, callsign: voucherCallsignFor\(mine, callsignOf\) \|\| forCallsign \}\);/);
    });
});
