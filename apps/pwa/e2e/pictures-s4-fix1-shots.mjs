/* eslint-disable no-undef */
// #2511 fix round 1, item 6: the web group chat drawn with the group's picture (list and header), and faces with no photo
// drawn with the key's ready-made picture (Group info's roster, the Market card's author line). 320 px wide, the
// browser's text at 130% (the PWA has no text-size setting of its own), light and dark; the viewport only, so each shot
// stays under 900 px. Every request to the node is answered here; nothing leaves the machine.
//
// Run from apps/pwa: node e2e/pictures-s4-fix1-shots.mjs [outDir]
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const OUT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(PWA_DIR, '../..', 'scratch', 'screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

const ME = 'a1b2c3d4e5f67890123456789012345678901234567890123456789012345678';
const PEER = 'f0'.repeat(32);
const LEAD = 'e1'.repeat(32);
const FACE = `/api/avatar/${PEER}?size=thumb&v=1a2b3c4d`;

const conversations = [
    { id: 'grp-garden', type: 'group_thread', name: 'Garden crew', participants: [ME, PEER], createdBy: ME, createdAt: '2026-10-20T00:00:00Z',
      peerAvatar: FACE, avatarUrl: 'bundled://sunflower', category: 'social', unreadCount: 2, lastMsgType: 'text' },
    { id: 'grp-choir', type: 'group_thread', name: 'Street choir (from before pictures)', participants: [ME, PEER], createdBy: PEER,
      createdAt: '2026-10-19T00:00:00Z', peerAvatar: FACE, avatarUrl: null, category: 'guild', unreadCount: 0, lastMsgType: 'text' },
    { id: 'dm-bob', type: 'dm', name: null, participants: [ME, PEER], createdBy: ME, createdAt: '2026-10-18T00:00:00Z',
      peerCallsign: 'Bob', peerAvatar: null, unreadCount: 0 },
];

const roster = [
    { groupId: 'g-faces', memberPubkey: LEAD, callsign: 'Lena', role: 'convenor', status: 'active', joinedAt: '2026-01-01T00:00:00.000Z', avatarUrl: 'bundled://leaf' },
    { groupId: 'g-faces', memberPubkey: '22'.repeat(32), callsign: 'Nell (no photo)', role: 'member', status: 'active', joinedAt: '2026-01-02T00:00:00.000Z' },
    { groupId: 'g-faces', memberPubkey: '33'.repeat(32), callsign: 'Omar (no photo)', role: 'member', status: 'active', joinedAt: '2026-01-03T00:00:00.000Z' },
    { groupId: 'g-faces', memberPubkey: '44'.repeat(32), callsign: 'Asha (asking, no photo)', role: 'member', status: 'pending_approval', joinedAt: '2026-01-04T00:00:00.000Z' },
];

function answer(url) {
    const u = new URL(url);
    const p = u.pathname;
    if (p.startsWith('/api/messages/conversations/')) return { conversations, totalUnread: 2, deletedAccounts: [] };
    if (p === '/api/groups/grp-garden/chat') {
        return { conversation: conversations[0], messages: [], canPost: true, readOnly: false, group: { id: 'grp-garden', name: 'Garden crew', category: 'social', avatarUrl: 'bundled://sunflower' } };
    }
    if (p === '/api/groups/g-faces') {
        return { id: 'g-faces', name: 'Seed Library', slug: 'seed-library', category: 'general', joinPolicy: 'request_to_join', createdBy: LEAD,
            createdAt: '2026-01-01T00:00:00.000Z', leadPubkey: LEAD, leadCallsign: 'Lena', viewerRole: 'convenor', viewerStatus: 'active',
            memberCount: 3, avatarUrl: 'bundled://bean-green' };
    }
    if (p === '/api/groups/g-faces/members') return roster;
    if (p.endsWith('/succession')) {
        return { silence: { convenorPubkey: null, convenorCallsign: null, lastActiveAt: null, daysInactive: 0, isSilent: false, isEligible: false, electorate: 'convenors' }, proposals: [], canPropose: false };
    }
    if (p.endsWith('/decisions')) return { decisions: [], myPoolVoting: null };
    if (p.startsWith('/api/marketplace/transactions')) return [];
    if (/\/api\/(members|friends|blocks|groups)(\/|$|\?)/.test(p + '/')) return [];
    return {};
}

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const port = server.httpServer.address().port;
const base = `http://localhost:${port}/e2e/pictures-s4-shots-harness.html`;
const browser = await chromium.launch();

const shots = [
    { id: 'fix1-group-chats-list', view: 'group-chats', ready: 'text=Garden crew' },
    { id: 'fix1-group-chat-header', view: 'group-chats', ready: 'text=Garden crew', open: 'text=Garden crew', then: '[data-testid="chat-owner-header"]' },
    { id: 'fix1-market-author', view: 'faces', ready: 'text=Rowan (no photo)' },
    { id: 'fix1-group-info-roster', view: 'roster', ready: 'text=Nell (no photo)', scrollTo: 'text=Nell (no photo)' },
];

try {
    for (const theme of ['light', 'dark']) {
        for (const s of shots) {
            const context = await browser.newContext({ viewport: { width: 320, height: 680 }, colorScheme: theme, deviceScaleFactor: 1 });
            const page = await context.newPage();
            page.on('pageerror', (e) => console.log(`[${s.id} ${theme}] page error: ${e.message}`));
            await page.route('**/*', (route) => {
                const url = route.request().url();
                if (!url.startsWith(`http://localhost:${port}/`)) return route.abort();
                if (new URL(url).pathname.startsWith('/api/')) {
                    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer(url)) });
                }
                return route.continue();
            });
            // The theme as the app sets it (lib/useTheme): html.dark.dark-theme, or html.light-theme.
            const setLook = (dark) => {
                const root = document.documentElement;
                root.style.fontSize = '130%';
                root.classList.toggle('dark', dark);
                root.classList.toggle('dark-theme', dark);
                root.classList.toggle('light-theme', !dark);
            };
            await page.goto(`${base}?view=${s.view}`);
            await page.evaluate(setLook, theme === 'dark');
            await page.waitForSelector(s.ready, { timeout: 20000 });
            if (s.open) {
                await page.click(s.open);
                await page.waitForSelector(s.then, { timeout: 20000 });
            }
            if (s.scrollTo) await page.locator(s.scrollTo).first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
            await page.waitForTimeout(700);
            await page.evaluate(setLook, theme === 'dark');
            await page.waitForTimeout(100);
            const width = await page.evaluate(() => document.documentElement.scrollWidth);
            const out = path.join(OUT_DIR, `${s.id}-${theme}.png`);
            await page.screenshot({ path: out });
            console.log(`saved ${out} (scrollWidth ${width})`);
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}
