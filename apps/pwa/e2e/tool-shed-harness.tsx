/**
 * The Tool shed on the web (slice T1.3), drawn on its own so tool-shed-320.mjs can measure it in a real Chromium layout:
 * the real tools' covered page (pages/ToolsPage.tsx) opened at one of the Tool shed's screens, `?screen=<name>&key=<id>`,
 * in `?lang=en|xx`, over a document kept in this browser's real IndexedDB first. Every /api request the page makes is
 * answered by the check's page route (the member's Offers and deals, the price guide, the private copy), never a node.
 */
import { createRoot } from 'react-dom/client';
import { type ThingsDoc } from '@beanpool/core';
import { ToolsPage } from '../src/pages/ToolsPage';
import { writeToolRecord } from '../src/tools/store';
import { showLanguage } from '../src/lib/language';
import '../src/index.css';

const OWNER = 'tool-shed-harness-owner';
const identity = { publicKey: OWNER, privateKey: '', callsign: 'Robin', createdAt: '2026-10-01T00:00:00.000Z' };
const DAY = 86_400_000;
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

/** A shed as a member's would be: a thing in the shop and asked for, one lent outside, one with everything said, one long-named. */
const DOC: ThingsDoc = {
    v: 1,
    things: [
        { id: 't-1', name: 'Cordless drill', category: 'tools', condition: 'good', postId: 'post-1', createdAt: iso(NOW - 9 * DAY), updatedAt: iso(NOW - 9 * DAY) },
        {
            id: 't-2', name: 'Step ladder', category: 'tools', condition: 'fair',
            lentTo: { name: 'Alice', since: iso(NOW - 2 * DAY), backAround: iso(NOW + 5 * DAY) },
            createdAt: iso(NOW - 8 * DAY), updatedAt: iso(NOW - 2 * DAY),
        },
        {
            id: 't-3', name: 'Four-person camping tent', category: 'general', condition: 'needs_care', replacementValue: '$120',
            lendTerms: 'Dry it before you bring it back. The pegs are in the side pocket. Back within a week, please.',
            lendMaxDays: 7, ownerNote: 'Top shelf in the garage, left side. Bought 2021.',
            createdAt: iso(NOW - 7 * DAY), updatedAt: iso(NOW - 7 * DAY),
        },
        { id: 't-4', name: 'Pressure washer with a very long hose and three nozzles', category: 'tools', createdAt: iso(NOW - DAY), updatedAt: iso(NOW - DAY) },
    ],
};

const q = new URLSearchParams(location.search);
const screen = q.get('screen') ?? 'main';
const key = q.get('key');
const lang = q.get('lang') === 'xx' ? 'xx' : 'en';

async function start() {
    await writeToolRecord(OWNER, 'things', { body: JSON.stringify(DOC), updatedAt: iso(NOW), syncedAt: null });
    await showLanguage(lang);
    const none = () => {};
    createRoot(document.getElementById('root')!).render(
        <div style={{ position: 'relative', minHeight: '100vh' }}>
            <ToolsPage identity={identity} open={{ id: 'things', screen, key }} onOpen={none} onClose={none} onComposer={none} onGuide={none} onAddHomeCard={none} />
        </div>,
    );
}
void start();
