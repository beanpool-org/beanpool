/**
 * Mothership A3 shots (listing-promise-a3-shots.mjs): what a community promised, under its name on the web's Find card. The
 * real AskedCommunity (the `?ask=` community) against a stubbed fetch, and the card's listed rows (HomePage.tsx's markup,
 * the real promiseLine under each; HomePage itself needs a whole node, HomePage.find.test.tsx covers it). No node is contacted.
 *
 *   ?dark=1   the dark theme
 */
import { createRoot } from 'react-dom/client';
import { AskedCommunity } from '../src/components/AskedCommunity';
import { promiseLine } from '../src/lib/home-cards';
import type { BeanPoolIdentity } from '../src/lib/identity';
import '../src/index.css';

const params = new URLSearchParams(window.location.search);
document.documentElement.classList.toggle('dark', params.get('dark') === '1');
document.documentElement.classList.toggle('dark-theme', params.get('dark') === '1');

const ME: BeanPoolIdentity = { publicKey: 'a'.repeat(64), privateKey: '00'.repeat(32), callsign: 'Ana Lucía', createdAt: '2026-01-01T00:00:00.000Z' };
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const PROMISE = { v: 1, owners: 2, backups: true, reports: true, notice: true };
const LISTED = [
    { key: 'k', name: 'Castlemaine BeanPool', url: 'https://castlemaine.example.org', memberCount: 41, distanceKm: 3, promise: PROMISE, acceptingKnocks: true, closingOn: inDays(40) },
    { key: 'n', name: 'Harcourt Growers', url: 'https://harcourt.example.org', memberCount: 12, distanceKm: 9, promise: null, acceptingKnocks: false, closingOn: null },
    { key: 'o', name: 'Maldon Commons (older global node: nothing said)', url: 'https://maldon.example.org', memberCount: 23, distanceKm: 14 },
];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
window.fetch = async (input: RequestInfo | URL) => {
    await new Promise(r => setTimeout(r, 50));
    if (String(input).includes('/api/global/communities')) return json(200, { communities: [LISTED[0]], total: 1 });
    return json(404, { error: 'not stubbed' });
};

function Harness() {
    return (
        <section className="max-w-md mx-auto p-4 bg-white dark:bg-nature-900 rounded-2xl border border-nature-200 dark:border-nature-800" data-testid="shot">
            <h2 className="m-0 mb-2 text-lg font-extrabold text-nature-950 dark:text-white">Find your community</h2>
            <AskedCommunity host="castlemaine.example.org" identity={ME} asked={() => false} onClose={() => {}} />
            <p className="m-0 mb-1 text-sm text-nature-800 dark:text-nature-100">Communities near you:</p>
            {LISTED.map(cm => {
                const promised = promiseLine(cm);
                return (
                    <div key={cm.key}>
                        <a href={cm.url} className="block py-1 text-sm font-semibold underline text-nature-900 dark:text-nature-50 break-words">{cm.name} · {cm.memberCount} members · {cm.distanceKm} km</a>
                        {promised && <p dir="auto" className="m-0 pb-1 text-xs text-nature-700 dark:text-nature-200 break-words" data-testid={`home-find-promise-${cm.key}`}>{promised}</p>}
                    </div>
                );
            })}
        </section>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
