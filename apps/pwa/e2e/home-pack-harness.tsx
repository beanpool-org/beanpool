/**
 * The real HomePage on its own, for e2e/home-pack-check.mjs: the real cards and the real stylesheet, every /api call
 * answered by Playwright. A plain 256 px strip stands where the app's sidebar stands from 768 px, so a window of 1280 px
 * gives Home the page width it has in the app. Layout here is inline style: this folder is outside Tailwind's content globs.
 */
import { createRoot } from 'react-dom/client';
import { HomePage } from '../src/pages/HomePage';
import { useTheme } from '../src/lib/useTheme';
import '../src/index.css';

const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: '', callsign: 'Ana', createdAt: '2026-01-01T00:00:00.000Z' };

function Harness() {
    useTheme();
    return (
        <div style={{ display: 'flex' }}>
            {window.innerWidth >= 768 && <div style={{ width: 256, flex: 'none' }} />}
            <div style={{ flex: '1 1 0', minWidth: 0 }}>
                <HomePage identity={IDENTITY as never} onNavigate={() => {}} />
            </div>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
