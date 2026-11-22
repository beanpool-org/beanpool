/**
 * Find by exact name on the web (slice N1; the phone's app/address-card.tsx): the member's switch "People in other communities
 * can find me by name", off until turned on, and the look-up under "Someone else's card": their community, their exact name,
 * then their card (on to the first message, as a scanned card) or the one "nobody". The look-up and the switch are stood in for
 * (the server's half is apps/server/src/test-find-by-name.ts); the store and the door are the real ones.
 *
 * 320 px: jsdom lays nothing out, so this holds what keeps the step inside 320 px (every field 100% wide with its border
 * inside, every label free to wrap); the drawn check at 320 px is the director's walk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { FIND_DAY_USED, FIND_ME_HELP, FIND_ME_SWITCH, FIND_NOBODY, FIND_NOT_A_MEMBER, FIND_OUTSIDE_OFF, ed25519Signer, signAddressCard } from '@beanpool/core';
import { MemoryIDBKeyRange, memoryIndexedDB } from '../lib/memory-indexeddb';

vi.mock('qrcode.react', () => ({ QRCodeSVG: ({ value }: { value: string }) => <span data-testid="qr" data-value={value} /> }));

const seedKey = () => { const seed = ed25519.utils.randomSecretKey(); return { seed: bytesToHex(seed), key: bytesToHex(ed25519.getPublicKey(seed)) }; };
const BEN = seedKey(), WREN = seedKey();
const B = 'https://b.example', HOME = 'b.example';

const here = vi.hoisted(() => ({
    ctx: null as any,
    findable: false,
    found: null as any,
    refuse: null as null | { status: number; code: string },
}));
const calls = vi.hoisted(() => ({ setFindMe: [] as boolean[], findByName: [] as Array<[string, string]> }));
vi.mock('../lib/outside-mail', async (importOriginal) => {
    const real = await importOriginal<typeof import('../lib/outside-mail')>();
    return {
        ...real,
        outsideContext: async () => here.ctx,
        outsideMessagesHere: async () => true,
        myHome: async () => HOME,
        findMeOn: async () => here.findable,
        setFindMe: async (_ctx: unknown, on: boolean) => { calls.setFindMe.push(on); here.findable = on; return on; },
        findByName: async (_ctx: unknown, home: string, name: string) => {
            calls.findByName.push([home, name]);
            if (here.refuse) throw new real.OutsideMailError(here.refuse.status, 'words from the server', here.refuse.code);
            return here.found;
        },
    };
});

// What the community says of its own addresses (its info).
const said = vi.hoisted(() => ({ info: {} as Record<string, unknown> }));
vi.mock('../lib/visitor-lobby-gate', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/visitor-lobby-gate')>()),
    communityInfoOnce: async () => said.info,
}));

import { outsideChatStore, clearOutsideChats } from '../lib/outside-chat-store';
import { doorOpen } from '../lib/outside-mail';
import { AddressCardPanel } from './AddressCardPanel';

beforeEach(async () => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    vi.stubGlobal('IDBKeyRange', MemoryIDBKeyRange);
    await clearOutsideChats();
    here.findable = false;
    here.found = null;
    here.refuse = null;
    said.info = {};
    calls.setFindMe = [];
    calls.findByName = [];
    here.ctx = {
        nodeUrl: B, identity: { publicKey: BEN.key, privateKey: BEN.seed, callsign: 'Ben' }, store: outsideChatStore(B),
        isBlocked: async () => false,
    };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const find = async (home: string, name: string) => {
    fireEvent.change(await screen.findByTestId('find-home'), { target: { value: home } });
    fireEvent.change(screen.getByTestId('find-name'), { target: { value: name } });
    fireEvent.click(screen.getByTestId('find-them'));
};

describe('find by name: the switch', () => {
    it('off until turned on, in core\'s words; on asks my community and opens this browser\'s door; off again', async () => {
        render(<AddressCardPanel onBack={() => {}} onOpenChat={() => {}} />);
        const sw = await screen.findByTestId('find-me-switch') as HTMLInputElement;
        expect(sw.checked).toBe(false);
        expect(screen.getByText(FIND_ME_SWITCH)).toBeTruthy();
        expect(FIND_ME_SWITCH).toBe('People in other communities can find me by name');
        expect(screen.getByText(FIND_ME_HELP)).toBeTruthy();
        expect(await doorOpen(here.ctx)).toBe(false);
        fireEvent.click(sw);
        await waitFor(() => expect((screen.getByTestId('find-me-switch') as HTMLInputElement).checked).toBe(true));
        expect(calls.setFindMe).toEqual([true]);
        expect(await doorOpen(here.ctx)).toBe(true);
        fireEvent.click(screen.getByTestId('find-me-switch'));
        await waitFor(() => expect((screen.getByTestId('find-me-switch') as HTMLInputElement).checked).toBe(false));
        expect(calls.setFindMe).toEqual([true, false]);
    });
});

describe('find by name: the look-up', () => {
    it('no button until both are typed; asks with what was typed, trimmed; nobody is the one sentence, and no box opens', async () => {
        render(<AddressCardPanel onBack={() => {}} onOpenChat={() => {}} />);
        expect((await screen.findByTestId('find-them') as HTMLButtonElement).disabled).toBe(true);
        await find('  riverside.example ', ' Wren Tallowmere  ');
        expect(await screen.findByText(FIND_NOBODY)).toBeTruthy();
        expect(calls.findByName).toEqual([['riverside.example', 'Wren Tallowmere']]);
        expect(screen.queryByTestId('first-message')).toBeNull();
    });

    it('their card: on to the first message, with their community and the name not confirmed here', async () => {
        here.found = await signAddressCard({ key: WREN.key, home: 'riverside.example', name: 'Wren Tallowmere' }, ed25519Signer(hexToBytes(WREN.seed)));
        render(<AddressCardPanel onBack={() => {}} onOpenChat={() => {}} />);
        await find('riverside.example', 'wren tallowmere');
        expect(await screen.findByTestId('first-message')).toBeTruthy();
        expect(screen.getByText('Wren Tallowmere')).toBeTruthy();
        expect(screen.getByText('riverside.example · name not confirmed here')).toBeTruthy();
    });

    // #3354 review, round 4: by any of this community's addresses (lib/community-homes.ts, Message's rule), never one spelling.
    // Its server refuses every line across to each of them. Mutation (PR body): myHome's one home only -> the last two open a box.
    for (const home of ['b.example', 'oldb.example', 'formerb.example']) {
        it(`a card at ${home}, one of this community's own addresses: they are in this community, and no box opens`, async () => {
            said.info = { addresses: ['b.example', 'oldb.example'], primaryAddress: 'b.example', formerAddresses: ['formerb.example'] };
            here.found = await signAddressCard({ key: WREN.key, home, name: 'Wren Tallowmere' }, ed25519Signer(hexToBytes(WREN.seed)));
            render(<AddressCardPanel onBack={() => {}} onOpenChat={() => {}} />);
            await find(home, 'wren tallowmere');
            expect(await screen.findByText('Wren Tallowmere is in this community: write to them here.')).toBeTruthy();
            expect(screen.queryByTestId('first-message')).toBeNull();
        });
    }

    // #3354 review, round 5: the rule Message keeps. Mutation (PR body): without the check -> a box opens whose line can't go.
    it('this community knows no address of its own: its server sends no line, so it says so and no box opens', async () => {
        said.info = { features: { outsideMessages: true }, addresses: [], primaryAddress: null, formerAddresses: [] };
        here.found = await signAddressCard({ key: WREN.key, home: 'riverside.example', name: 'Wren Tallowmere' }, ed25519Signer(hexToBytes(WREN.seed)));
        render(<AddressCardPanel onBack={() => {}} onOpenChat={() => {}} />);
        await find('riverside.example', 'wren tallowmere');
        expect(await screen.findByText("This community's server knows none of its own names yet, so it can't send to another community.")).toBeTruthy();
        expect(screen.queryByTestId('first-message')).toBeNull();
    });

    it('a refusal reads in core\'s words by its code, never the server\'s English', async () => {
        here.refuse = { status: 429, code: 'find_day_used' };
        render(<AddressCardPanel onBack={() => {}} onOpenChat={() => {}} />);
        await find('riverside.example', 'Wren Tallowmere');
        expect(await screen.findByText(FIND_DAY_USED)).toBeTruthy();
        expect(screen.queryByText('words from the server')).toBeNull();
    });

    for (const [code, words] of [['outside_off', FIND_OUTSIDE_OFF], ['not_a_member', FIND_NOT_A_MEMBER]] as const) {
        it(`a 403 ${code} says why, not "couldn't be asked"`, async () => {
            here.refuse = { status: 403, code };
            render(<AddressCardPanel onBack={() => {}} onOpenChat={() => {}} />);
            await find('riverside.example', 'Wren Tallowmere');
            expect(await screen.findByText(words)).toBeTruthy();
            expect(screen.queryByText('words from the server')).toBeNull();
        });
    }

    it('320 px: every field of the step is 100% wide with its border inside, and every line may wrap', async () => {
        render(<AddressCardPanel onBack={() => {}} onOpenChat={() => {}} />);
        for (const id of ['find-home', 'find-name']) {
            const el = await screen.findByTestId(id);
            expect(el.style.width).toBe('100%');
            expect(el.style.boxSizing).toBe('border-box');
        }
        const label = (await screen.findByTestId('find-me-switch')).closest('label') as HTMLElement;
        expect(label.style.overflowWrap).toBe('anywhere');
        expect(screen.getByTestId('find-them').style.width).toBe('');
    });
});
