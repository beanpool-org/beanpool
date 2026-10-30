/**
 * Front doors S2 shots (doors-s2-shots.mjs): the web's Wants to join (People → Invites) and Ask to join (the Find card's
 * rows and the `?ask=` community), the real components against a stubbed fetch in this page (no node is contacted).
 *
 *   ?view=wants    the list of two requests, with Invite and Not now
 *   ?view=find     the Find card: the asked community first, then two listed rows, each with Ask to join
 * `&refuse=1` makes every answer and knock a refusal in the community's words; `&dark=1` the dark theme.
 */
import { createRoot } from 'react-dom/client';
import { WantsToJoin } from '../src/components/WantsToJoin';
import { AskedCommunity } from '../src/components/AskedCommunity';
import { AskToJoin } from '../src/components/AskToJoin';
import type { BeanPoolIdentity } from '../src/lib/identity';
import '../src/index.css';

const params = new URLSearchParams(window.location.search);
const view = params.get('view') || 'wants';
const refuse = params.get('refuse') === '1';
// The app's dark theme sets both classes (lib/useTheme): `dark` for Tailwind, `dark-theme` for the CSS tokens.
document.documentElement.classList.toggle('dark', params.get('dark') === '1');
document.documentElement.classList.toggle('dark-theme', params.get('dark') === '1');

const ME: BeanPoolIdentity = { publicKey: 'a'.repeat(64), privateKey: '00'.repeat(32), callsign: 'Ana Lucía', createdAt: '2026-01-01T00:00:00.000Z' };
const day = 86_400_000;
const REQUESTS = [
    { id: 'k1', pubkey: 'b'.repeat(64), callsign: 'Riverbend Joe', message: 'I live by the river in Chewton and grow far too many tomatoes. Happy to swap seedlings and help with the community garden on weekends.', avatar: null, fromNode: 'global.beanpool.org', createdAt: new Date().toISOString() },
    { id: 'k2', pubkey: 'c'.repeat(64), callsign: 'Sky', message: 'New in town. I fix bikes.', avatar: null, fromNode: 'global.beanpool.org', createdAt: new Date(Date.now() - 3 * day).toISOString() },
];
const LISTED = [
    { key: 'c', name: 'Castlemaine BeanPool', url: 'https://castlemaine.example.org', memberCount: 41, distanceKm: 3 },
    { key: 'h', name: 'Harcourt Growers', url: 'https://harcourt.example.org', memberCount: 12, distanceKm: 9 },
];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    await new Promise(r => setTimeout(r, 50));
    if (url.includes('/api/global/communities')) return json(200, { communities: [{ key: 'm', name: 'Maldon Commons', url: 'https://maldon.example.org', memberCount: 23 }], total: 1 });
    if (url.includes('/api/join/knocks/') && init?.method === 'POST') {
        return refuse ? json(409, { error: 'Another member has already answered this request.', code: 'answered' }) : json(200, { knock: { id: 'k1', status: 'approved' } });
    }
    if (url.includes('/api/join/knocks')) return json(200, { knocks: REQUESTS, total: 2 });
    if (url.endsWith('/api/join/knock')) {
        return refuse
            ? json(429, { error: 'Too many requests to join have come from this network today (5). Please try again tomorrow.', code: 'rate_limited' })
            : json(201, { knock: { status: 'pending' } });
    }
    return json(404, { error: 'not stubbed' });
};

function Harness() {
    if (view === 'wants') {
        return (
            <div className="max-w-md mx-auto bg-white dark:bg-nature-900 rounded-2xl shadow-soft border border-nature-200 dark:border-nature-800 overflow-hidden" data-testid="shot">
                <WantsToJoin />
            </div>
        );
    }
    return (
        <section className="max-w-md mx-auto p-4 bg-white dark:bg-nature-900 rounded-2xl border border-nature-200 dark:border-nature-800" data-testid="shot">
            <h2 className="m-0 mb-2 text-lg font-extrabold text-nature-950 dark:text-white">Find your community</h2>
            <AskedCommunity host="maldon.example.org" identity={ME} asked={() => false} onClose={() => {}} />
            <p className="m-0 mb-1 text-sm text-nature-800 dark:text-nature-100">Communities near you:</p>
            {LISTED.map(cm => (
                <div key={cm.key}>
                    <a href={cm.url} className="block py-1 text-sm font-semibold underline text-nature-900 dark:text-nature-50 break-words">{cm.name} · {cm.memberCount} members · {cm.distanceKm} km</a>
                    <AskToJoin community={cm} identity={ME} asked={false} testId={`ask-${cm.key}`} />
                </div>
            ))}
        </section>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
