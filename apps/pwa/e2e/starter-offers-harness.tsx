/**
 * The real HomePage on its own, for e2e/starter-offers-shots.mjs (cold start O2): the real First steps card, the real
 * "What could you offer?" dialog and the real stylesheet, every /api call answered by Playwright. The composer is App's, so
 * here it is a recorder: what a row opens it with is kept on `window.__composer` and what "Something else" navigates to on
 * `window.__navigated`. A plain 256 px strip stands where the app's sidebar stands from 768 px (as home-pack-harness.tsx).
 */
import { createRoot } from 'react-dom/client';
import { HomePage } from '../src/pages/HomePage';
import { useTheme } from '../src/lib/useTheme';
import '../src/index.css';

const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: '', callsign: 'Ana', createdAt: '2026-01-01T00:00:00.000Z' };
const w = window as unknown as { __composer: unknown[]; __navigated: string[] };
w.__composer = [];
w.__navigated = [];

function Harness() {
    useTheme();
    return (
        <div style={{ display: 'flex' }}>
            {window.innerWidth >= 768 && <div style={{ width: 256, flex: 'none' }} />}
            <div style={{ flex: '1 1 0', minWidth: 0 }}>
                <HomePage identity={IDENTITY as never} onNavigate={(tab) => { w.__navigated.push(tab); }} onComposer={(draft) => { w.__composer.push(draft); }} />
            </div>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
