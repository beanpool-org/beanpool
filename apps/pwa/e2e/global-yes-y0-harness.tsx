/**
 * Slice Y0's screens (DESIGN-global-yes-join-fable.md §3) with the real components, the node a fetch stubbed in the page
 * (nothing leaves the machine), at https://byron.example.org as the community (bp_node_url):
 *   - `waiting`: KnockWaitingPage for an account restored here whose request (sent from global) is still open;
 *   - `yes`: KnockWaitingPage with the yes and Join;
 *   - `name`: WelcomePage's yes for that account, which asks the name the 12 words carry none of; the runner then types
 *     a name, joins, picks a photo and taps Next, to reach How it works with the line in the backup's place;
 *   - `card`: global Home's yes card (HomePage.tsx's markup, the classes copied).
 */
import { createRoot } from 'react-dom/client';
import { t } from '@beanpool/core';
import '../src/index.css';
import { KnockWaitingPage } from '../src/pages/KnockWaitingPage';
import { WelcomePage } from '../src/pages/WelcomePage';
import { generateIdentity, wipeIdentity } from '../src/lib/identity';
import { waitWithRestoredKey } from '../src/lib/knock-key';

const params = new URLSearchParams(window.location.search);
const view = params.get('view') ?? 'waiting';
const NODE = 'https://byron.example.org';

if (params.get('dark') === '1') {
    document.documentElement.classList.add('dark', 'dark-theme');
    document.documentElement.style.colorScheme = 'dark';
} else {
    document.documentElement.classList.add('light-theme');
    document.documentElement.style.colorScheme = 'light';
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const knock = view === 'waiting' ? { status: 'pending' } : { status: 'approved', invite: 'KN0C-K1NV', expiresAt: null };
window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input).replace(NODE, '');
    if (path === '/api/community/info') return json(200, { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance_c: 0, profile: 'local', features: { openJoin: false } });
    if (path === '/api/community/card') return json(200, { name: 'Byron Shire BeanPool', host: 'byron.example.org', members: 40, joining: 'requests' });
    if (path === '/api/join/knock/status') return json(200, knock);
    if (path.startsWith('/api/community/membership/')) return json(200, { isMember: false, callsign: null });
    if (path.startsWith('/api/invite/check')) return json(200, { valid: true });
    if (path === '/api/invite/redeem') {
        const body = JSON.parse(String(init.body ?? '{}'));
        return json(200, { success: true, member: { publicKey: body.publicKey, callsign: body.callsign } });
    }
    return json(200, {});
};

function Card() {
    const url = 'https://byron.example.org';
    const name = 'Byron Shire BeanPool';
    return (
        <div className="max-w-md mx-auto p-4">
            <section className="bg-white dark:bg-nature-900 rounded-2xl shadow-sm border border-nature-200 dark:border-nature-800 p-4">
                <h3 className="m-0 mb-2 text-base font-semibold text-text-primary">{t('Find your community')}</h3>
                <div data-testid="card" className="mt-2 mb-2 p-3 rounded-xl border border-nature-200 dark:border-nature-700 bg-nature-50 dark:bg-nature-900/40">
                    <p dir="auto" className="m-0 font-semibold text-sm text-text-primary break-words">{t('🎉 {name} said yes.', { name })}</p>
                    <p dir="auto" className="m-0 mt-1 text-sm text-nature-700 dark:text-nature-200 break-words">
                        {t('To join, open its page in this browser, tap Already a member and restore with your 12 words, then Join. Your 12 words are under Settings → Show my 12 words.')}
                    </p>
                    <div className="mt-2">
                        <a href={`${url}/app?door=signin`} target="_blank" rel="noopener noreferrer"
                            className="flex w-full min-h-[48px] px-4 py-2 items-center justify-center rounded-xl border border-nature-300 dark:border-nature-700 text-sm font-bold text-nature-900 dark:text-white no-underline text-center break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                            {t('Open {address}', { address: 'byron.example.org' })}
                        </a>
                    </div>
                    <p dir="auto" className="m-0 mt-2 text-sm text-nature-700 dark:text-nature-200 break-words">
                        {t('Or on your phone: open the BeanPool app, restore your account, then Find a community → {name} → Join.', { name })}
                    </p>
                </div>
            </section>
        </div>
    );
}

async function main() {
    localStorage.clear();
    localStorage.setItem('bp_node_url', NODE);
    await wipeIdentity().catch(() => {});
    const root = createRoot(document.getElementById('root')!);
    if (view === 'card') { root.render(<Card />); return; }
    // An account restored with its 12 words: no name, kept as the waiting key (slice Y0).
    const restored = await waitWithRestoredKey({ ...(await generateIdentity('')), callsign: '' }, {});
    if (view === 'name') {
        root.render(<WelcomePage onComplete={() => {}} knockYes={{ invite: 'KN0C-K1NV', name: 'Byron Shire BeanPool' }} onBackToRequest={() => {}} />);
        return;
    }
    root.render(<KnockWaitingPage identity={restored} onJoin={() => {}} onInvite={() => {}} onSignIn={() => {}} onForgotten={() => {}} />);
}
void main();
