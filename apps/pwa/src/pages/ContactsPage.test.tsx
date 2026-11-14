import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { readContactsCopy, toEd25519Pkcs8, type ContactsCopyWire } from '@beanpool/core';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { importIdentity, type BeanPoolIdentity } from '../lib/identity';
import { contactsSnapshot, resetContactsStoreForTest, saveContactsNow } from '../lib/contacts-store';
import { ContactsPage } from './ContactsPage';
import { AddToContacts } from '../components/AddToContacts';
import { ContactsSignOutNote } from '../components/ContactsSignOutNote';
import { ContactsInfo } from '../components/ContactsInfo';

// The web's Contacts screens (DESIGN-private-contacts-fable.md §3.2, §3.5, §3.6, §3.7, §3.9, §6.4; §11 "Web (C4)") over
// the real store, a browser's own IndexedDB and a recording community: a file from each kind of phone, the browser's
// chooser, by hand, from a profile, the file out, Remove everyone, sign-out's word, and no name, number or email in any
// request.

vi.mock('../lib/blocklist', () => ({ isUserBlocked: vi.fn(() => false), unblockUser: vi.fn() }));

const seed = ed25519.utils.randomSecretKey();
const me: BeanPoolIdentity = { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(toEd25519Pkcs8(seed)), callsign: 'ana', createdAt: '2026-11-12T00:00:00.000Z' };
const sam = 'ab'.repeat(32);

let seen: string[] = [];
let kept: ContactsCopyWire | null = null;
// After a re-key (C6): the old copy this community keeps for the member's key now, or none.
let former: Record<string, unknown> | null = null;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function community(url: string, init: RequestInit = {}): Response {
    seen.push(`${init.method ?? 'GET'} ${url} ${JSON.stringify(init.headers ?? {})} ${typeof init.body === 'string' ? init.body : ''}`);
    if (url.endsWith('/api/contacts/former')) return former ? json(200, former) : json(404, { code: 'no_former' });
    if (!url.endsWith('/api/contacts/copy')) return json(404, { error: 'no route' });
    if ((init.method ?? 'GET') === 'GET') return kept ? json(200, kept) : json(404, { code: 'no_copy' });
    const body = JSON.parse(String(init.body)) as ContactsCopyWire;
    const read = readContactsCopy(body);
    if (!read.ok) return json(400, { code: 'bad_copy' });
    kept = body;
    return json(200, { seq: read.copy.seq });
}

// An Android export (vCard 2.1, a quoted-printable name), an iPhone's (3.0, a photo), Google's (3.0, two numbers).
const ANDROID = 'BEGIN:VCARD\r\nVERSION:2.1\r\nN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Walker;D=C3=A9e;;;\r\nFN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:D=C3=A9e Walker\r\nTEL;CELL:0412 345 678\r\nEND:VCARD\r\n';
const IPHONE = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Sam Jones\r\nTEL;type=CELL:+61 400 111 222\r\nPHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD\r\n AAAAAAAAAAAAAAAAAAAAAAAAAAAA\r\nEMAIL;type=INTERNET:sam@example.org\r\nEND:VCARD\r\n';
const GOOGLE = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ana Li\r\nN:Li;Ana;;;\r\nTEL;TYPE=CELL:0499 000 111\r\nTEL;TYPE=WORK:(02) 6600 1234\r\nNOTE:From the market\r\nEND:VCARD\r\n';
const SECRETS = ['Dée', 'Walker', '0412 345 678', '0412345678', 'Sam Jones', '400 111 222', 'sam@example.org', 'Ana Li', '0499 000 111', 'From the market', 'Typed Person', '0400 999 888'];

const fileOf = (text: string, name = 'contacts.vcf') => new File([text], name, { type: 'text/vcard' });
async function pick(file: File) {
    const input = await screen.findByTestId('contacts-file');
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
}

beforeEach(async () => {
    seen = [];
    kept = null;
    former = null;
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => community(url, init)));
    resetContactsStoreForTest();
    await importIdentity(me);
});

afterEach(() => {
    resetContactsStoreForTest();
    vi.unstubAllGlobals();
    delete (window as unknown as Record<string, unknown>).ContactsManager;
    delete (navigator as unknown as Record<string, unknown>).contacts;
});

describe('Contacts on the web', () => {
    it('imports a file from each kind of phone: three cards first, everyone ticked, Done, and nothing named in any request', async () => {
        render(<ContactsPage identity={me} start="import" onBack={vi.fn()} onMessage={vi.fn()} />);
        await screen.findByText('Import contacts');
        for (const card of ['Android phone', 'iPhone', 'Google Contacts on a computer']) expect(screen.getByText(card)).toBeInTheDocument();
        expect(screen.getByText("The file is read in this browser. It isn't uploaded.")).toBeInTheDocument();
        // No browser chooser here: no button for it.
        expect(screen.queryByText("Choose from this phone's contacts")).toBeNull();

        await pick(fileOf(ANDROID + IPHONE + GOOGLE));
        await screen.findByText('Found 3 contacts. Nothing has left this device yet.');
        const review = screen.getByTestId('contacts-review');
        expect(within(review).getByText('Dée Walker')).toBeInTheDocument();
        expect(within(review).getAllByRole('checkbox').every((b) => (b as HTMLInputElement).checked)).toBe(true);
        expect(seen.filter((s) => s.startsWith('PUT'))).toEqual([]);

        fireEvent.click(screen.getByRole('button', { name: 'Import 3 contacts' }));
        expect(await screen.findByTestId('contacts-done')).toHaveTextContent("3 contacts added. They're locked with your key and will be kept at:");
        expect(contactsSnapshot().list?.contacts.map((c) => c.name).sort()).toEqual(['Ana Li', 'Dée Walker', 'Sam Jones']);

        await act(async () => { await saveContactsNow(me); });
        expect(kept).not.toBeNull();
        const sent = seen.join('\n');
        for (const s of SECRETS) expect(sent).not.toContain(s);
    });

    it('a second import shows who is already in the list unticked, and an entry with no number or email unticked', async () => {
        render(<ContactsPage identity={me} start="import" onBack={vi.fn()} onMessage={vi.fn()} />);
        await pick(fileOf(ANDROID));
        fireEvent.click(await screen.findByRole('button', { name: 'Import 1 contact' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Done' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Import' }));
        await pick(fileOf(ANDROID + 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Old Work\r\nEND:VCARD\r\n' + GOOGLE));
        const review = await screen.findByTestId('contacts-review');
        const box = (name: string) => within(review).getByText(name).closest('label')!.querySelector('input') as HTMLInputElement;
        expect(box('Dée Walker').checked).toBe(false);
        expect(within(review).getByText('(already in your list)')).toBeInTheDocument();
        expect(box('Old Work').checked).toBe(false);
        expect(within(review).getByText('(no number or email)')).toBeInTheDocument();
        expect(box('Ana Li').checked).toBe(true);
        expect(screen.getByRole('button', { name: 'Import 1 contact' })).toBeEnabled();
    });

    it('says a file it cannot read, and one too big, in the shared sentences', async () => {
        render(<ContactsPage identity={me} start="import" onBack={vi.fn()} onMessage={vi.fn()} />);
        await pick(fileOf('hello, this is not a contacts file'));
        expect(await screen.findByRole('alert')).toHaveTextContent('That file isn’t a contacts file BeanPool can read. Export it again as vCard (.vcf).');
        const big = fileOf(IPHONE);
        Object.defineProperty(big, 'size', { value: 26 * 1024 * 1024 });
        await pick(big);
        expect(await screen.findByRole('alert')).toHaveTextContent('That file is too big to read here. Export it without photos, or in two parts.');
    });

    it("a dropped file reads as a picked one", async () => {
        render(<ContactsPage identity={me} start="import" onBack={vi.fn()} onMessage={vi.fn()} />);
        const zone = await screen.findByTestId('contacts-drop');
        await act(async () => { fireEvent.drop(zone, { dataTransfer: { files: [fileOf(GOOGLE)] } }); });
        expect(await screen.findByText('Found 1 contact. Nothing has left this device yet.')).toBeInTheDocument();
    });

    it("where the browser has its own contact chooser (Android Chrome), it is offered first and what is chosen is reviewed", async () => {
        (window as unknown as Record<string, unknown>).ContactsManager = function ContactsManager() {};
        const select = vi.fn(async () => [{ name: ['Rae Moss'], tel: ['0411 222 333'], email: [] }, { name: [], tel: [], email: [] }]);
        (navigator as unknown as Record<string, unknown>).contacts = { select };
        render(<ContactsPage identity={me} start="import" onBack={vi.fn()} onMessage={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: "Choose from this phone's contacts" }));
        expect(await screen.findByText('Found 1 contact. Nothing has left this device yet.')).toBeInTheDocument();
        expect(select).toHaveBeenCalledWith(['name', 'tel', 'email'], { multiple: true });
        fireEvent.click(screen.getByRole('button', { name: 'Import 1 contact' }));
        expect(await screen.findByText("BeanPool read your phone's contacts once, just now. It doesn't watch them. To bring new ones later, tap Import again.")).toBeInTheDocument();
    });

    it('adds one by hand, opens it, and removes it after saying nobody is told', async () => {
        render(<ContactsPage identity={me} onBack={vi.fn()} onMessage={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: '＋ Add' }));
        fireEvent.click(screen.getByRole('button', { name: 'Add' }));
        expect(await screen.findByText('Type a name, a number or an email.')).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Typed Person' } });
        fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '0400 999 888' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add' }));
        expect(await screen.findByText('Not on BeanPool yet')).toBeInTheDocument();
        expect(screen.getByTestId('contacts-where')).toHaveTextContent('Kept on this device. Your latest changes go to');

        fireEvent.click(screen.getByText('Typed Person'));
        expect(await screen.findByTestId('contact-detail')).toHaveTextContent('0400 999 888');
        fireEvent.click(screen.getByRole('button', { name: 'Remove from contacts' }));
        expect(screen.getByText(/Remove Typed Person from your contacts\? Nobody is told\./)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
        expect(await screen.findByText('No contacts yet. Import them from a contacts file, or add someone by hand.')).toBeInTheDocument();
    });

    it('saves a copy as a file only after saying it is not locked, and Remove everyone empties the list', async () => {
        const made: Blob[] = [];
        vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn((b: Blob) => { made.push(b); return 'blob:contacts'; }), revokeObjectURL: vi.fn() }));
        render(<ContactsPage identity={me} start="import" onBack={vi.fn()} onMessage={vi.fn()} />);
        await pick(fileOf(IPHONE + GOOGLE));
        fireEvent.click(await screen.findByRole('button', { name: 'Import 2 contacts' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Done' }));

        fireEvent.click(await screen.findByRole('button', { name: 'More' }));
        fireEvent.click(screen.getByRole('button', { name: 'Save a copy as a file (.vcf)' }));
        expect(screen.getByText('This file is not locked. Anyone who has it can read it. Keep it somewhere safe.')).toBeInTheDocument();
        expect(made).toHaveLength(0);
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(made).toHaveLength(1);
        const vcf = await made[0].text();
        expect(vcf).toContain('FN:Sam Jones');
        expect(vcf).toContain('NOTE:From the market');

        fireEvent.click(screen.getByRole('button', { name: 'More' }));
        fireEvent.click(screen.getByRole('button', { name: 'Remove everyone' }));
        expect(screen.getByText(/Remove all 2 contacts from every device and every community's copy\?/)).toBeInTheDocument();
        fireEvent.click(within(screen.getByText(/Remove all 2 contacts/).parentElement!).getByRole('button', { name: 'Remove everyone' }));
        expect(await screen.findByText('No contacts yet. Import them from a contacts file, or add someone by hand.')).toBeInTheDocument();
        expect(contactsSnapshot().list?.removed).toHaveLength(2);
    });

    it("a member's profile: Add to my contacts, the other isn't told, and a name already in the list asks if it is the same person", async () => {
        const { unmount } = render(<ContactsPage identity={me} start="import" onBack={vi.fn()} onMessage={vi.fn()} />);
        await pick(fileOf(IPHONE));
        fireEvent.click(await screen.findByRole('button', { name: 'Import 1 contact' }));
        await screen.findByTestId('contacts-done');
        unmount();

        render(<AddToContacts identity={me} pubkey={sam} callsign="sam_j" />);
        fireEvent.click(await screen.findByTestId('add-to-contacts'));
        expect(screen.getByText("@sam_j isn't told. This is different from Friends: a friend can see you added them.")).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText('Name (only you see it)'), { target: { value: 'sam jones' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add' }));
        expect(await screen.findByText('Sam Jones is already in your list. Add @sam_j to that person?')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Yes, same person' }));
        expect(await screen.findByTestId('in-your-contacts')).toHaveTextContent('In your contacts as Sam Jones');
        const samRow = contactsSnapshot().list?.contacts.find((c) => c.name === 'Sam Jones');
        expect(samRow?.links.map((l) => [l.key, l.callsign, l.how])).toEqual([[sam, 'sam_j', 'profile']]);
        expect(contactsSnapshot().list?.contacts).toHaveLength(1);
    });

    it('a linked member in this community is messaged from the list', async () => {
        render(<AddToContacts identity={me} pubkey={sam} callsign="sam_j" />);
        fireEvent.click(await screen.findByTestId('add-to-contacts'));
        fireEvent.click(screen.getByRole('button', { name: 'Add' }));
        await screen.findByTestId('in-your-contacts');
        const onMessage = vi.fn();
        render(<ContactsPage identity={me} onBack={vi.fn()} onMessage={onMessage} />);
        expect(await screen.findByText('On BeanPool')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Message' }));
        expect(onMessage).toHaveBeenCalledWith(sam);
    });

    it('sign-out says when the community does not hold the latest copy yet, and Save now saves it', async () => {
        render(<ContactsPage identity={me} start="import" onBack={vi.fn()} onMessage={vi.fn()} />);
        await pick(fileOf(GOOGLE));
        fireEvent.click(await screen.findByRole('button', { name: 'Import 1 contact' }));
        await screen.findByTestId('contacts-done');

        render(<ContactsSignOutNote identity={me} />);
        const note = await screen.findByTestId('contacts-sign-out');
        expect(note).toHaveTextContent("Your latest contacts changes aren't saved to");
        expect(note).toHaveTextContent('yet. Save now, then sign out.');
        fireEvent.click(within(note).getByRole('button', { name: 'Save now' }));
        await waitFor(() => expect(screen.queryByTestId('contacts-sign-out')).toBeNull());
        expect(kept).not.toBeNull();
    });

    it('after a re-key (C6): while this community keeps the old locked list, the list says so and points to the phone app; not otherwise', async () => {
        const first = render(<ContactsPage identity={me} onBack={vi.fn()} onMessage={vi.fn()} />);
        await waitFor(() => expect(seen.some((s) => s.startsWith('GET ') && s.includes('/api/contacts/former'))).toBe(true));
        expect(screen.queryByTestId('contacts-former')).toBeNull();
        first.unmount();
        former = { header: 'h', signature: 's', nonce: 'n', sealed: 'x', formerKey: 'cd'.repeat(32), keptUntil: '2027-11-15T00:00:00.000Z' };
        render(<ContactsPage identity={me} onBack={vi.fn()} onMessage={vi.fn()} />);
        expect(await screen.findByTestId('contacts-former')).toHaveTextContent(
            'Your contacts are locked with your old key. If you ever find your old 12 words, you can open them in the BeanPool phone app.');
        // One signed GET, with no body: nothing about the list is sent.
        expect(seen.filter((s) => s.includes('/api/contacts/former')).every((s) => s.startsWith('GET ') && s.endsWith(' '))).toBe(true);
        // Mutation: drop the `former &&` guard → the sentence shows to every member.
    });

    it('the ⓘ says the true sentence about encryption and never "all messages" or "by default"', () => {
        render(<ContactsInfo onClose={vi.fn()} />);
        const info = screen.getByTestId('contacts-info');
        expect(info).toHaveTextContent("Chats between two people and group chats are end-to-end encrypted, always: there is nothing to turn on. Event chats and enterprise chats are not: the community's server can read those.");
        expect(info.textContent).not.toMatch(/all messages|by default|everything is encrypted/i);
    });
});
