/**
 * Your garden on the web (grow-food slice G0), drawn on its own so garden-320.mjs can measure it in a real Chromium
 * layout: the real tools' covered page (pages/ToolsPage.tsx) opened at one of the garden's screens,
 * `?screen=<name>&key=<crop id>`, in `?lang=en|xx`. Nothing is kept first, so the guide's zone comes from the place the
 * community's server tells the member (its Home answer, answered by the check's page route, never a node).
 */
import { createRoot } from 'react-dom/client';
import { ToolsPage } from '../src/pages/ToolsPage';
import { showLanguage } from '../src/lib/language';
import '../src/index.css';

const OWNER = 'garden-harness-owner';
const identity = { publicKey: OWNER, privateKey: '', callsign: 'Robin', createdAt: '2026-10-01T00:00:00.000Z' };

const q = new URLSearchParams(location.search);
const screen = q.get('screen') ?? 'main';
const key = q.get('key');
const lang = q.get('lang') === 'xx' ? 'xx' : 'en';

async function start() {
    await showLanguage(lang);
    const none = () => {};
    createRoot(document.getElementById('root')!).render(
        <div style={{ position: 'relative', minHeight: '100vh' }}>
            <ToolsPage identity={identity} open={{ id: 'garden', screen, key }} onOpen={none} onClose={none} onComposer={none} onGuide={none} onAddHomeCard={none} />
        </div>,
    );
}
void start();
