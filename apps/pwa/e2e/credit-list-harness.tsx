/**
 * The web's credit surfaces on their own, for e2e/credit-list-shots.mjs (DESIGN-credit-list-fable.md test 14; credit on the
 * People list C5): `?view=list` People → Community with Show credit on (the real CreditPeoplePanel), `vouchers` the committee's
 * Vouchers chip, `card` a profile's credit card, `looks` the log of looks in Settings, `ask` Ask for more in its states. The
 * account is a test's (a fixed seed, never a member's) and nothing here talks to a node: the driver answers /api.
 */
import { createRoot } from 'react-dom/client';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { toEd25519Pkcs8 } from '@beanpool/core';
import { CreditPeoplePanel } from '../src/components/CreditPeoplePanel';
import { CreditCard } from '../src/components/CreditCard';
import { CreditLooksSection } from '../src/components/CreditLooksSection';
import { AskForMore } from '../src/components/AskForMore';
import { importIdentity, type BeanPoolIdentity } from '../src/lib/identity';
import { useTheme } from '../src/lib/useTheme';
import '../src/index.css';

const SEED = new Uint8Array(32).fill(7);
const me: BeanPoolIdentity = { publicKey: bytesToHex(ed25519.getPublicKey(SEED)), privateKey: bytesToHex(toEd25519Pkcs8(SEED)), callsign: 'Marty', createdAt: '2026-01-01T00:00:00.000Z' };
const view = new URLSearchParams(location.search).get('view') ?? 'list';
const role = new URLSearchParams(location.search).get('role') ?? 'owner';
// The card's person: Sam after the gift by default, or `&who=jane` (confirmed, two vouches: every line of an owner's card).
const SAM = '3'.repeat(64);
const CARD_OF = new URLSearchParams(location.search).get('who') === 'jane' ? '2'.repeat(64) : SAM;

function Harness() {
    useTheme();
    return (
        <main style={{ minHeight: '100vh', background: 'var(--bg-primary)' }} className="p-4 max-w-4xl mx-auto">
            {view === 'list' && <CreditPeoplePanel query="" blocked={new Set()} start={{ chip: 'all', nonce: 1 }} />}
            {view === 'vouchers' && <CreditPeoplePanel query="" blocked={new Set()} start={{ chip: 'vouchers', nonce: 1 }} />}
            {view === 'card' && <CreditCard memberPubkey={CARD_OF} myVouching={role === 'voucher' ? ({ voucher: true } as never) : null} />}
            {view === 'looks' && <CreditLooksSection />}
            {view === 'ask' && (
                <div className="space-y-4">
                    <AskForMore ask={{ askedAt: null, lastAskedAt: null, askAgainAt: null, blocked: null }} />
                    <AskForMore ask={{ askedAt: '2026-11-12T01:00:00Z', lastAskedAt: '2026-11-12T01:00:00Z', askAgainAt: '2026-11-19T01:00:00Z', blocked: null }} />
                    <AskForMore ask={{ askedAt: null, lastAskedAt: '2026-11-12T01:00:00Z', askAgainAt: '2026-11-19T01:00:00Z', blocked: null }} />
                    <AskForMore ask={{ askedAt: null, lastAskedAt: null, askAgainAt: null, blocked: 'frozen' }} />
                    <AskForMore ask={{ askedAt: null, lastAskedAt: null, askAgainAt: null, blocked: 'paused' }} />
                </div>
            )}
        </main>
    );
}

async function start() {
    await importIdentity(me);
    createRoot(document.getElementById('root')!).render(<Harness />);
}
void start();
