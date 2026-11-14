import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { newContactId, putContact, toEd25519Pkcs8, type ContactsList } from '@beanpool/core';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { importIdentity, type BeanPoolIdentity } from '../lib/identity';
import { changeContacts, contactsSnapshot, openContacts, resetContactsStoreForTest, saveContactsNow } from '../lib/contacts-store';
import { ContactsPage } from './ContactsPage';
import { PendingInvites } from '../components/PendingInvites';

// Invite from a contact on the web (DESIGN-private-contacts-fable.md §3.8, §3.9, §11 "Across apps (C5)", slice C5): the real
// page over the real store, a browser's own IndexedDB and a recording community. The reviewer's check: NO contact's name,
// number or email reaches any request the flow sends (URL, headers, body), the invite included, and the locked copy's save.

const state = vi.hoisted(() => ({ info: null as null | Record<string, unknown>, role: null as string | null | undefined }));
vi.mock('../lib/blocklist', () => ({ isUserBlocked: vi.fn(() => false), unblockUser: vi.fn() }));
vi.mock('../lib/features', async (orig) => ({ ...(await orig<Record<string, unknown>>()), useCommunityInfo: () => state.info }));
vi.mock('../lib/api', async (orig) => ({ ...(await orig<Record<string, unknown>>()), myNodeRoleOnce: async () => state.role }));

// A fixed key, checked below to hold none of the needles: a random one could hold "0412" by chance.
const seed = new Uint8Array(32).fill(9);
const me: BeanPoolIdentity = { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(toEd25519Pkcs8(seed)), callsign: 'ana', createdAt: '2026-11-12T00:00:00.000Z' };
const DEE_KEY = 'd1'.repeat(32);
const NEEDLES = [
    'Dee Walker', 'Walker', '0412 345 678', '0412345678', '412345678', '0412%20345', '0412+345', 'dee@example.org', 'dee%40example.org',
    'Tom Riley', 'Riley', '0499 000 111', '0499000111', 'tom@example.org', 'tom%40example.org',
];
const DEE = { id: newContactId(), name: 'Dee Walker', phones: ['0412 345 678'], emails: ['dee@example.org'], note: 'from the market', links: [], invite: null };
const TOM = { id: newContactId(), name: 'Tom Riley', phones: ['0499 000 111'], emails: ['tom@example.org'], note: '', links: [], invite: null };

let seen: string[] = [];
let mine: Array<Record<string, unknown>> = [];
let generateAnswer: null | { status: number; body: unknown } = null;
let made = 0;
const shared: Array<{ text?: string }> = [];
const copied: string[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function community(url: string, init: RequestInit = {}): Response {
    const method = init.method ?? 'GET';
    seen.push(`${method} ${url} ${JSON.stringify(init.headers ?? {})} ${typeof init.body === 'string' ? init.body : ''}`);
    const path = new URL(url, 'http://localhost').pathname;
    if (path === '/api/invite/generate') {
        if (generateAnswer) return json(generateAnswer.status, generateAnswer.body);
        made += 1;
        return json(200, { success: true, invite: { code: `INV-TEST-000${made}` } });
    }
    if (path.startsWith('/api/invite/mine/')) return json(200, { invites: mine });
    if (method === 'DELETE' && path.startsWith('/api/invite/')) return json(200, { success: true, revoked: 1, returned: 0, promiseEnded: false });
    if (path === '/api/contacts/copy') return method === 'PUT' ? json(200, { seq: JSON.parse(String(init.body)).header?.seq ?? 1 }) : json(404, { code: 'no_copy' });
    return json(404, { error: 'no route' });
}
const sent = () => seen.join('\n');
const assertNothingNamed = () => { for (const n of NEEDLES) expect(sent(), `"${n}" left the browser`).not.toContain(n); };
const seedList = async (fn: (l: ContactsList) => ContactsList) => { await openContacts(me); await changeContacts(me, fn); };
const rowOf = (name: string) => screen.getAllByTestId('contact-row').find((r) => r.textContent?.includes(name))!;

beforeEach(async () => {
    seen = []; mine = []; generateAnswer = null; made = 0; shared.length = 0; copied.length = 0;
    state.info = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance_c: 0, profile: 'local', features: { invites: true, door: 'members' } };
    state.role = null;
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => community(String(url), init)));
    Object.defineProperty(navigator, 'share', { configurable: true, value: vi.fn(async (d: { text?: string }) => { shared.push(d); }) });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async (s: string) => { copied.push(s); }) } });
    resetContactsStoreForTest();
    await importIdentity(me);
});

afterEach(() => {
    cleanup();
    resetContactsStoreForTest();
    vi.unstubAllGlobals();
    delete (navigator as unknown as Record<string, unknown>).share;
    delete (navigator as unknown as Record<string, unknown>).clipboard;
});

describe('Invite from a contact on the web', () => {
    it('the key used to sign holds none of the needles (so a hit below is the flow, not chance)', () => {
        for (const n of NEEDLES) expect(me.publicKey).not.toContain(n);
    });

    it('the whole flow (invite, Share, Copy, "Is this Dee?", Yes, cancel on Remove, the locked copy saved): no name, number or email in any request', async () => {
        await seedList((l) => putContact(putContact(l, DEE), TOM));
        const view = render(<ContactsPage identity={me} onBack={vi.fn()} onMessage={vi.fn()} />);
        await screen.findByText('Not on BeanPool yet');
        expect(screen.getAllByRole('button', { name: 'Invite' })).toHaveLength(2);

        // Dee: the sheet, in the design's words; nothing made before a tap.
        fireEvent.click(within(rowOf('Dee Walker')).getByRole('button', { name: 'Invite' }));
        const sheet = await screen.findByTestId('contact-invite-sheet');
        expect(within(sheet).getByText(/^Invite Dee Walker to /)).toBeInTheDocument();
        expect(within(sheet).getByText('One invite, for one person. It works once, for 30 days.')).toBeInTheDocument();
        expect(within(sheet).getByText("Dee Walker's name and number are not sent to the server.")).toBeInTheDocument();
        expect(within(sheet).getByRole('button', { name: 'Email' })).toBeInTheDocument();
        expect(seen.filter((s) => s.includes('/api/invite/generate'))).toEqual([]);
        await act(async () => { fireEvent.click(within(sheet).getByRole('button', { name: 'Share…' })); });
        await waitFor(() => expect(shared).toHaveLength(1));
        expect(shared[0].text).toContain('/?invite=INV-TEST-0001');
        // The invite's body is the maker's key alone: no note.
        const generate = seen.find((s) => s.includes('/api/invite/generate'))!;
        expect(generate.endsWith(JSON.stringify({ publicKey: me.publicKey }))).toBe(true);
        await waitFor(() => expect(screen.queryByTestId('contact-invite-sheet')).toBeNull());
        await waitFor(() => expect(contactsSnapshot().list?.contacts.find((c) => c.name === 'Dee Walker')?.invite?.code).toBe('INV-TEST-0001'));
        expect(within(rowOf('Dee Walker')).getByText(/^invited \d{1,2} [A-Z][a-z]{2}$/)).toBeInTheDocument();
        expect(within(rowOf('Dee Walker')).getByRole('button', { name: 'Invite again' })).toBeInTheDocument();

        // Tom: Copy puts the whole message on the clipboard and says so.
        fireEvent.click(within(rowOf('Tom Riley')).getByRole('button', { name: 'Invite' }));
        const sheet2 = await screen.findByTestId('contact-invite-sheet');
        await act(async () => { fireEvent.click(within(sheet2).getByRole('button', { name: 'Copy' })); });
        await waitFor(() => expect(copied[0]).toContain('INV-TEST-0002'));
        expect(within(sheet2).getByText('Copied. Paste it in your own message.')).toBeInTheDocument();
        fireEvent.click(within(sheet2).getByRole('button', { name: 'Close' }));

        // This community says Dee's code was used by @dee_w: the row asks; Yes links Dee to that member.
        mine = [
            { code: 'INV-TEST-0001', createdAt: new Date().toISOString(), usedBy: DEE_KEY, usedByCallsign: 'dee_w', usedAt: new Date().toISOString() },
            { code: 'INV-TEST-0002', createdAt: new Date().toISOString(), usedBy: null },
        ];
        view.unmount();
        render(<ContactsPage identity={me} onBack={vi.fn()} onMessage={vi.fn()} />);
        const asked = await screen.findByTestId('contact-invite-used');
        expect(asked).toHaveTextContent(/^Someone joined .+ with the invite you sent Dee Walker: @dee_w\. Is this Dee Walker\?/);
        await act(async () => { fireEvent.click(within(asked).getByRole('button', { name: "Yes, that's Dee Walker" })); });
        await waitFor(() => expect(contactsSnapshot().list?.contacts.find((c) => c.name === 'Dee Walker')?.links).toEqual([expect.objectContaining({ key: DEE_KEY, callsign: 'dee_w', how: 'invite' })]));
        expect(screen.queryByTestId('contact-invite-used')).toBeNull();

        // Tom: his invite is still out, so Remove offers to cancel it; ticked, the revoke goes first, then he goes.
        fireEvent.click(within(rowOf('Tom Riley')).getByRole('button', { name: /Tom Riley/ }));
        fireEvent.click(await screen.findByRole('button', { name: 'Remove from contacts' }));
        fireEvent.click(screen.getByRole('checkbox', { name: 'Also cancel the invite I sent' }));
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove' })); });
        await waitFor(() => expect(contactsSnapshot().list?.contacts.map((c) => c.name)).toEqual(['Dee Walker']));
        expect(seen.some((s) => /^DELETE \S*\/api\/invite\/INV-TEST-0002 /.test(s))).toBe(true);

        // The locked list goes to the community: a save.
        await act(async () => { await saveContactsNow(me); });
        expect(seen.some((s) => s.startsWith('PUT') && s.includes('/api/contacts/copy'))).toBe(true);

        assertNothingNamed();
        // Mutation: generateInvite(identity.publicKey, contact.name) in the sheet → "Dee Walker" in the body, red.
    });

    it('a refusal (the daily limit) is the server\'s own sentence; nothing is shared and nothing kept', async () => {
        generateAnswer = { status: 429, body: { error: 'You have made 20 invites today. Try again tomorrow.' } };
        await seedList((l) => putContact(l, DEE));
        render(<ContactsPage identity={me} onBack={vi.fn()} onMessage={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Invite' }));
        await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Share…' })); });
        expect(await screen.findByText('You have made 20 invites today. Try again tomorrow.')).toBeInTheDocument();
        expect(shared).toEqual([]);
        expect(contactsSnapshot().list?.contacts[0].invite).toBeNull();
        assertNothingNamed();
    });

    it('admins-only door, a member: the existing words, and the existing ask opened empty with its one added line; no invite made', async () => {
        state.info = { ...state.info, features: { invites: true, door: 'admins' } };
        state.role = null;
        await seedList((l) => putContact(l, DEE));
        render(<ContactsPage identity={me} onBack={vi.fn()} onMessage={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Invite' }));
        expect(await screen.findByText('In this community only its admins invite people. Ask an admin to bring them in.')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Ask an admin to invite Dee Walker' }));
        const ask = await screen.findByTestId('invite-ask-sheet');
        expect(within(ask).getByText('The admins will see the first name you type here.')).toBeInTheDocument();
        expect((within(ask).getByTestId('invite-ask-first-name') as HTMLInputElement).value).toBe('');
        expect(seen.filter((s) => s.includes('/api/invite/generate'))).toEqual([]);
        assertNothingNamed();
    });

    it('a community with no invites (the global one): its existing words, and its plain link shared; nothing made, nobody linked', async () => {
        state.info = { ...state.info, profile: 'global', features: { invites: false } };
        await seedList((l) => putContact(l, DEE));
        render(<ContactsPage identity={me} onBack={vi.fn()} onMessage={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Invite' }));
        expect(await screen.findByText(/^This community doesn’t use invites/)).toBeInTheDocument();
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: '📤 Share the link' })); });
        await waitFor(() => expect(shared).toEqual([{ text: `Join me on BeanPool: ${window.location.origin}` }]));
        expect(seen.filter((s) => s.includes('/api/invite/'))).toEqual([]);
        expect(contactsSnapshot().list?.contacts[0].invite).toBeNull();
    });

    it('No: the contact stays unlinked, the invite is forgotten (not asked again), and the member is told what it means', async () => {
        await seedList((l) => putContact(l, { ...DEE, invite: { code: 'INV-TEST-0009', community: window.location.origin, at: new Date().toISOString() } }));
        mine = [{ code: 'INV-TEST-0009', createdAt: new Date().toISOString(), usedBy: DEE_KEY, usedByCallsign: 'someone_else' }];
        render(<ContactsPage identity={me} onBack={vi.fn()} onMessage={vi.fn()} />);
        const asked = await screen.findByTestId('contact-invite-used');
        await act(async () => { fireEvent.click(within(asked).getByRole('button', { name: 'No' })); });
        expect(await screen.findByText("Then someone else used it. If that's a problem, tell an admin.")).toBeInTheDocument();
        const dee = contactsSnapshot().list?.contacts[0];
        expect(dee?.links).toEqual([]);
        expect(dee?.invite).toBeNull();
        expect(screen.queryByTestId('contact-invite-used')).toBeNull();
    });
});

describe('Invites → Pending names an invite from the contacts list in this browser', () => {
    it('a plain invite (no note, no names entry) reads the contact\'s name, and asks for the list only while the fold is open', async () => {
        const need = vi.fn();
        render(<PendingInvites invites={[{ code: 'INV-TEST-0001', createdAt: new Date().toISOString() }]} now={Date.now()} linkFor={(c) => c} shareFor={() => null}
            contactNames={new Map([['inv-test-0001', 'Dee Walker']])} onNeedContacts={need} />);
        expect(need).toHaveBeenLastCalledWith(false);
        fireEvent.click(screen.getByTestId('invites-pending-fold'));
        expect(need).toHaveBeenLastCalledWith(true);
        expect(screen.getByTestId('invite-who')).toHaveTextContent('Dee Walker');
        // Mutation: drop contactName from the row's inviteWho → it reads the bare code.
    });
});
