/**
 * The holding page of the account handoff (slice Y1) for e2e/global-yes-y1-check.mjs, served at its own origin (the
 * "global" one) while the community's real web app is served at another. A fresh account is made in the page; the
 * runner reads its public key (to give it a yes at the community's stub) and, at the end, the private key and words,
 * which it then looks for in every request either page made.
 *   - `mode=join` (default): global's yes card with the real Join (components/YesJoin.tsx), for a request remembered
 *     with the name it sent ("CJ Asked"), the account's own name being "CJ Global". `nopopup=1`: window.open gives
 *     nothing back, as a pop-up blocker does. `readyMs`: how long Join waits for the community's page.
 *   - `mode=manual`: no card; `window.__open(url)`, `window.__post(data, targetOrigin)` and `window.__got` (every
 *     message this page receives, with its origin) for the runner to drive the receiver by hand (a wrong nonce).
 */
import { createRoot } from 'react-dom/client';
import { t } from '@beanpool/core';
import '../src/index.css';
import { YesJoin } from '../src/components/YesJoin';
import { generateIdentity } from '../src/lib/identity';
import { accountMessage, readyMessage } from '../src/lib/handoff';

declare global {
    interface Window {
        __identity?: { publicKey: string; privateKey: string; mnemonic: string[] };
        __open?: (url: string) => boolean;
        __post?: (data: unknown, targetOrigin: string) => void;
        __got?: Array<{ origin: string; data: unknown }>;
        __messages?: { accountMessage: typeof accountMessage; readyMessage: typeof readyMessage };
    }
}

const params = new URLSearchParams(window.location.search);
const mode = params.get('mode') ?? 'join';
const knockUrl = params.get('knock') ?? 'https://byron.example.org';
const readyMs = Number(params.get('readyMs')) || undefined;

if (params.get('dark') === '1') {
    document.documentElement.classList.add('dark', 'dark-theme');
    document.documentElement.style.colorScheme = 'dark';
} else {
    document.documentElement.classList.add('light-theme');
    document.documentElement.style.colorScheme = 'light';
}

async function main() {
    const identity = await generateIdentity('CJ Global');
    window.__identity = { publicKey: identity.publicKey, privateKey: identity.privateKey, mnemonic: identity.mnemonic ?? [] };
    window.__got = [];
    window.addEventListener('message', (e) => { window.__got!.push({ origin: e.origin, data: e.data }); });
    const root = createRoot(document.getElementById('root')!);
    if (mode === 'manual') {
        let win: Window | null = null;
        window.__open = (url) => { win = window.open(url, '_blank'); return !!win; };
        window.__post = (data, targetOrigin) => { win?.postMessage(data, targetOrigin); };
        window.__messages = { accountMessage, readyMessage };
        root.render(<p data-testid="manual">manual</p>);
        return;
    }
    if (params.get('nopopup') === '1') window.open = () => null;
    const name = 'Byron Shire BeanPool';
    const knock = { url: knockUrl, name, key: null, sentAt: new Date().toISOString(), callsign: 'CJ Asked' };
    root.render(
        <div className="max-w-md mx-auto p-4">
            <section className="bg-white dark:bg-nature-900 rounded-2xl shadow-sm border border-nature-200 dark:border-nature-800 p-4">
                <h3 className="m-0 mb-2 text-base font-semibold text-text-primary">{t('Find your community')}</h3>
                <div data-testid="card" className="mt-2 mb-2 p-3 rounded-xl border border-nature-200 dark:border-nature-700 bg-nature-50 dark:bg-nature-900/40">
                    <p dir="auto" className="m-0 mb-2 font-semibold text-sm text-text-primary break-words">{t('🎉 {name} said yes.', { name })}</p>
                    <YesJoin knock={knock} name={name} identity={identity} testId="y1" readyMs={readyMs} />
                </div>
            </section>
        </div>,
    );
}
void main();
