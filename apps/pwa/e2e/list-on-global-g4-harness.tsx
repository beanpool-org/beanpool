/**
 * The global community's side of "back to the listing after the join" (list on global G4) for e2e/list-on-global-g4-check.mjs,
 * served at the "global" origin while Byron's real web app is served at another. One account, made in the page and kept in
 * this origin's storage, so the two steps below are the same member:
 *   - `/` with no `ask`: a copy of Byron's listing as global shows it, with its real door (components/EventCopyDoor.tsx);
 *     its Ask to join keeps the listing at Byron and goes to `/?ask=byron.example.org`;
 *   - `/?ask=…` (the runner serves this page there): Byron said yes, and the real Join (components/YesJoin.tsx).
 * `listing=<id>`: the copy's listing at Byron. `lang`: the language the page draws in.
 */
import { createRoot } from 'react-dom/client';
import { copyPriceLine, t, type EventCopy, type UiLang } from '@beanpool/core';
import '../src/index.css';
import { EventCopyDoor } from '../src/components/EventCopyDoor';
import { YesJoin } from '../src/components/YesJoin';
import { generateIdentity, type BeanPoolIdentity } from '../src/lib/identity';
import { showLanguage } from '../src/lib/language';

declare global {
    interface Window { __identity?: { publicKey: string; privateKey: string; mnemonic: string[] } }
}

const params = new URLSearchParams(window.location.search);
const listing = params.get('listing') ?? 'p-byron-1';
const BYRON = 'https://byron.example.org';
const NAME = 'Byron Shire BeanPool';
const KEPT = 'g4-harness-identity';

if (params.get('dark') === '1' || localStorage.getItem('g4-dark') === '1') {
    localStorage.setItem('g4-dark', '1');
    document.documentElement.classList.add('dark', 'dark-theme');
    document.documentElement.style.colorScheme = 'dark';
} else {
    document.documentElement.classList.add('light-theme');
    document.documentElement.style.colorScheme = 'light';
}

async function account(): Promise<BeanPoolIdentity> {
    const kept = localStorage.getItem(KEPT);
    if (kept) return JSON.parse(kept) as BeanPoolIdentity;
    const made = await generateIdentity('CJ Global');
    localStorage.setItem(KEPT, JSON.stringify(made));
    return made;
}

async function main() {
    const lang = (params.get('lang') ?? localStorage.getItem('g4-lang') ?? 'en') as UiLang;
    localStorage.setItem('g4-lang', lang);
    if (lang !== 'en') await showLanguage(lang);
    const identity = await account();
    window.__identity = { publicKey: identity.publicKey, privateKey: identity.privateKey, mnemonic: identity.mnemonic ?? [] };
    const root = createRoot(document.getElementById('root')!);
    const asked = params.has('ask');
    const knock = { url: BYRON, name: NAME, key: null, sentAt: new Date().toISOString(), callsign: 'CJ Asked' };
    // An Offer's copy, as the Market's footer draws it (components/ListingCopyFooter.tsx): its price line, then the door.
    const copy: EventCopy = { from: { host: 'byron.example.org', postId: listing, name: NAME, url: BYRON, door: 'ask' }, price: { price_c: 2000, per: 'fixed' } };
    root.render(
        <div className="max-w-md mx-auto p-4">
            <section className="bg-white dark:bg-nature-900 rounded-2xl shadow-sm border border-nature-200 dark:border-nature-800 p-4">
                {asked ? (
                    <div data-testid="card">
                        <p dir="auto" className="m-0 mb-2 font-semibold text-sm text-text-primary break-words">{t('🎉 {name} said yes.', { name: NAME })}</p>
                        <YesJoin knock={knock} name={NAME} identity={identity} testId="g4" />
                    </div>
                ) : (
                    <div data-testid="copy">
                        <h3 className="m-0 mb-2 text-base font-semibold text-text-primary break-words">Spare seedlings</h3>
                        <EventCopyDoor copy={copy} line={copyPriceLine(copy)} />
                    </div>
                )}
            </section>
        </div>,
    );
}
void main();
