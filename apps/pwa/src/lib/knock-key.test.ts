/**
 * The key a browser's "Ask to join {name}" signs with (DESIGN-shared-listing-door-fable.md §2.1, slice A1; lib/knock-key.ts):
 * drafted in memory, written only on Send, one key per browser by the ordinary identity save (the same decision
 * checkIdentitySave asks: §5's measurement), and wiped by "Forget this request" only when no community let it in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    checkIdentitySave, generateIdentity, importIdentity, loadIdentity, markInviteSent, IdentityHeldError, type BeanPoolIdentity,
} from './identity';
import {
    commitKnockKey, draftKnockKey, forgetKnockKey, forgetKnockMark, isKnockKey, knockWaitingKey, KnockKeyHeldError, KNOCK_KEY_STORE,
    isEstablishedKey, waitWithRestoredKey,
} from './knock-key';
import { memoryIndexedDB } from './memory-indexeddb';

beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    localStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe("the knock's key in a browser", () => {
    it('a draft writes nothing: no account, no mark, until Send', async () => {
        const draft = await draftKnockKey();
        expect(draft.mnemonic).toHaveLength(12);
        expect(await loadIdentity()).toBeNull();
        expect(localStorage.getItem(KNOCK_KEY_STORE)).toBeNull();
        expect(await knockWaitingKey()).toBeNull();
    });

    it('Send writes it with the name typed, marked as waiting: the root reads it as the knock, never a member', async () => {
        const draft = await draftKnockKey();
        const held = await commitKnockKey(draft, '  Sam   Rivers ');
        expect(held).toMatchObject({ publicKey: draft.publicKey, callsign: 'Sam Rivers' });
        expect((await loadIdentity())?.publicKey).toBe(draft.publicKey);
        expect((await loadIdentity())?.mnemonic).toEqual(draft.mnemonic);
        expect(isKnockKey(held)).toBe(true);
        expect((await knockWaitingKey())?.publicKey).toBe(draft.publicKey);
        // Send again (the knock didn't go): the same key, written again, no error.
        await expect(commitKnockKey(draft, 'Sam')).resolves.toMatchObject({ publicKey: draft.publicKey });
    });

    it('a second key from the same browser is refused, and the first stays: one key per browser', async () => {
        const first = await commitKnockKey(await draftKnockKey(), 'Sam');
        const second = await draftKnockKey();
        await expect(commitKnockKey(second, 'Sam')).rejects.toBeInstanceOf(IdentityHeldError);
        expect((await loadIdentity())?.publicKey).toBe(first.publicKey);
        expect(localStorage.getItem(KNOCK_KEY_STORE)).toBe(first.publicKey);
    });

    it("§5: the guard is the save guard itself. checkIdentitySave refuses the same second key, and a member's account is never replaced", async () => {
        const member = await generateIdentity('Member');
        await importIdentity(member);
        const draft = await draftKnockKey();
        await expect(checkIdentitySave(draft)).rejects.toBeInstanceOf(IdentityHeldError);
        await expect(commitKnockKey(draft, 'Sam')).rejects.toBeInstanceOf(IdentityHeldError);
        expect((await loadIdentity())?.publicKey).toBe(member.publicKey);
        expect(localStorage.getItem(KNOCK_KEY_STORE)).toBeNull();
        expect(isKnockKey(member)).toBe(false);
    });

    it('a key an invite went with, not settled yet, is settled first: nothing written', async () => {
        const sent = await generateIdentity('Rowan');
        await markInviteSent(sent, 'hash', Date.now());
        await expect(commitKnockKey(await draftKnockKey(), 'Sam')).rejects.toBeInstanceOf(KnockKeyHeldError);
        expect(await loadIdentity()).toBeNull();
        expect(localStorage.getItem(KNOCK_KEY_STORE)).toBeNull();
    });

    it('once the community has the key as a member, its mark goes: never read as waiting again', async () => {
        const held = await commitKnockKey(await draftKnockKey(), 'Sam');
        forgetKnockMark('f'.repeat(64));
        expect(isKnockKey(held)).toBe(true);
        forgetKnockMark(held.publicKey);
        expect(isKnockKey(held)).toBe(false);
        expect(await knockWaitingKey()).toBeNull();
        expect((await loadIdentity())?.publicKey).toBe(held.publicKey);
    });

    it("Forget this request wipes a key no community accepted, and only that one", async () => {
        const held = await commitKnockKey(await draftKnockKey(), 'Sam');
        expect(await forgetKnockKey('e'.repeat(64))).toBe(false);
        expect(await forgetKnockKey(held.publicKey)).toBe(true);
        expect(await loadIdentity()).toBeNull();
        expect(localStorage.getItem(KNOCK_KEY_STORE)).toBeNull();

        // A member's key (no mark) is never wiped by it.
        const member: BeanPoolIdentity = await generateIdentity('Member');
        await importIdentity(member);
        expect(await forgetKnockKey(member.publicKey)).toBe(false);
        expect((await loadIdentity())?.publicKey).toBe(member.publicKey);
    });

    it('a yes being redeemed (its key sent with the invite) is never wiped by Forget', async () => {
        const held = await commitKnockKey(await draftKnockKey(), 'Sam');
        await markInviteSent(held, 'hash', Date.now());
        expect(await forgetKnockKey(held.publicKey)).toBe(false);
        expect((await loadIdentity())?.publicKey).toBe(held.publicKey);
    });
});

describe('a restored key that waits here (slice Y0)', () => {
    it("a refused save puts back the established mark of the account already waiting (review of b9a4a876)", async () => {
        const a = await generateIdentity();
        await waitWithRestoredKey(a, {});
        expect(isEstablishedKey(a.publicKey)).toBe(true);
        const b = await generateIdentity();
        await expect(waitWithRestoredKey(b, {})).rejects.toBeInstanceOf(IdentityHeldError);
        expect(isEstablishedKey(a.publicKey)).toBe(true);
        expect(isEstablishedKey(b.publicKey)).toBe(false);
        expect(isKnockKey(a)).toBe(true);
    });
});
