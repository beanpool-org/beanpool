/**
 * Join names N1 (join-names-shots.mjs): the real GuestLobby (its Join card) and the real WelcomePage (the join screen and
 * the invite form) against a stubbed fetch in this page, so the headings that say WHICH community is being joined can be
 * measured at 320 px with 1.3x text, light and dark, in English and Spanish. No node is contacted.
 *
 *   ?view=lobby    the visitors' lobby, on its Home (the Join card at the top)
 *   ?view=welcome  the welcome page: the open door's first screen, or a local community's invite form under its card
 *   &kind=ours     the app's global community (global.beanpool.org's names)
 *   &kind=hall     a self-hoster's open community (global profile, its own name and address)
 *   &kind=local    a local community (invites and requests; its card above the invite form)
 *   &ask=<host>    the lobby opened by a community's card (?ask=), at ours only
 *   &lang=es       Spanish (the app's own ?lang= choice); &dark=1 the dark theme
 */
import { createRoot } from 'react-dom/client';
import { GuestLobby } from '../src/pages/GuestLobby';
import { WelcomePage } from '../src/pages/WelcomePage';
import { startLanguage } from '../src/lib/language';
import '../src/index.css';

const params = new URLSearchParams(window.location.search);
const view = params.get('view') || 'lobby';
const kind = params.get('kind') || 'ours';
const ask = params.get('ask');
// The app's dark theme sets both classes (lib/useTheme): `dark` for Tailwind, `dark-theme` for the CSS tokens.
document.documentElement.classList.toggle('dark', params.get('dark') === '1');
document.documentElement.classList.toggle('dark-theme', params.get('dark') === '1');

const BASE = { memberCount: 36, postCount: 20, transactionCount: 0, commonsBalance_c: 0 };
const INFO = {
    ours: { ...BASE, profile: 'global', features: { openJoin: true, guestListingsOnly: true, beans: false }, addresses: ['global.beanpool.org'], primaryAddress: 'global.beanpool.org' },
    hall: { ...BASE, profile: 'global', features: { openJoin: true, guestListingsOnly: true, beans: false }, addresses: ['hall.example.org'], primaryAddress: 'hall.example.org' },
    local: { ...BASE, profile: 'local', features: { door: 'members', guestListingsOnly: true, beans: true } },
} as const;
const CARDS = {
    ours: null,
    // A long name on purpose: it has to wrap at 320 dp with 1.3x text, never run off the card or be cut.
    hall: { name: 'Riverbend Neighbours’ Seed & Tool Library', host: 'hall.example.org', members: 12, area: null, joining: 'open', askUrl: null, globalUrl: null },
    local: { name: 'Riverbend Neighbours’ Seed & Tool Library', host: 'riverbend.example.org', members: 36, area: { name: 'Chewton and around', radiusKm: 15 }, joining: 'requests', askUrl: null, globalUrl: null },
} as const;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
window.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    const path = url.split('?')[0];
    await new Promise(r => setTimeout(r, 30));
    if (path === '/api/community/info') return json(200, INFO[kind as keyof typeof INFO]);
    if (path === '/api/community/card') {
        const card = CARDS[kind as keyof typeof CARDS];
        return card ? json(200, card) : json(404, { error: 'Not Found' });
    }
    if (path === '/api/global/communities') {
        return json(200, { communities: [{ key: 'k-byron', name: 'Byron Shire BeanPool', url: 'https://byron.beanpool.org', memberCount: 36, acceptingKnocks: true }] });
    }
    if (path === '/api/community/health') return json(200, { status: 'ok', version: '1.2.36' });
    return json(404, { error: 'not stubbed' });
};

await startLanguage(window.location.search);

createRoot(document.getElementById('root')!).render(
    view === 'welcome'
        ? <div data-testid="shot" style={{ minHeight: '100vh' }}><WelcomePage onComplete={() => {}} /></div>
        : <div data-testid="shot" style={{ height: '900px' }}><GuestLobby info={INFO[kind as keyof typeof INFO] as never} onComplete={() => {}} askedCommunity={ask} /></div>,
);
