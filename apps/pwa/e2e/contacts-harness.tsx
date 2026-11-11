/**
 * The web's private contacts screens on their own, for e2e/contacts-shots.mjs (DESIGN-private-contacts-fable.md slice C4):
 * `?view=chat` the Chat list with its Contacts button, `list` the Contacts page with a few people (one linked), `import`
 * the Import page, `info` the ⓘ. The account is a test's (a fixed seed, never a member's) and nothing here talks to a
 * node: the driver answers /api.
 */
import { createRoot } from 'react-dom/client';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { contactsFromCandidates, emptyContactsList, mergeContactsLists, newContactId, putContact, toEd25519Pkcs8 } from '@beanpool/core';
import { MessagesPage } from '../src/pages/MessagesPage';
import { ContactsPage } from '../src/pages/ContactsPage';
import { ContactsInfo } from '../src/components/ContactsInfo';
import { importIdentity, type BeanPoolIdentity } from '../src/lib/identity';
import { changeContacts, openContacts } from '../src/lib/contacts-store';
import { nodeAddress } from '../src/lib/api';
import { useTheme } from '../src/lib/useTheme';
import '../src/index.css';

const SEED = new Uint8Array(32).fill(7);
const me: BeanPoolIdentity = { publicKey: bytesToHex(ed25519.getPublicKey(SEED)), privateKey: bytesToHex(toEd25519Pkcs8(SEED)), callsign: 'Alice', createdAt: '2026-01-01T00:00:00.000Z' };
const view = new URLSearchParams(location.search).get('view') ?? 'list';

function Harness() {
    useTheme();
    return (
        <main style={{ minHeight: '100vh', background: 'var(--bg-primary)' }}>
            {view === 'chat' && <MessagesPage identity={me} onNavigate={() => {}} />}
            {view === 'list' && <ContactsPage identity={me} onBack={() => {}} onMessage={() => {}} />}
            {view === 'import' && <ContactsPage identity={me} start="import" onBack={() => {}} onMessage={() => {}} />}
            {view === 'info' && <ContactsInfo onClose={() => {}} />}
        </main>
    );
}

async function start() {
    await importIdentity(me);
    if (view === 'list') {
        await openContacts(me);
        const people = [
            { name: 'Dee Walker-Montgomery-Fitzwilliam', phones: ['0412 345 678'], emails: [], note: '' },
            { name: 'Tom', phones: [], emails: ['tom.a.very.long.address@example.org'], note: '' },
            { name: 'سامي · சாமி · 山姆', phones: ['+61 400 000 001'], emails: [], note: '' },
        ];
        await changeContacts(me, (l) => mergeContactsLists(l, { ...emptyContactsList(), contacts: contactsFromCandidates(people) }));
        await changeContacts(me, (l) => putContact(l, {
            id: newContactId(), name: 'Sam Jones', phones: [], emails: [], note: '', invite: null,
            links: [{ key: 'ab'.repeat(32), community: nodeAddress(), callsign: 'sam_j', how: 'profile', at: new Date().toISOString() }],
        }));
    }
    createRoot(document.getElementById('root')!).render(<Harness />);
}
void start();
