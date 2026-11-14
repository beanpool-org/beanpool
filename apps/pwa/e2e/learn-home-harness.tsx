/**
 * The real HomePage for e2e/learn-home-shots.mjs (slice K7), as e2e/home-pack-harness.tsx draws it, in `?lang=en|<code>`:
 * the language is shown before Home is, so the card's words are that language's. Every /api call is answered by Playwright.
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HomePage } from '../src/pages/HomePage';
import { useTheme } from '../src/lib/useTheme';
import { showLanguage } from '../src/lib/language';
import '../src/index.css';

const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: '', callsign: 'Ana', createdAt: '2026-01-01T00:00:00.000Z' };
const lang = new URLSearchParams(location.search).get('lang') ?? 'en';

function Harness() {
    useTheme();
    const [ready, setReady] = useState(lang === 'en');
    useEffect(() => { if (lang !== 'en') void showLanguage(lang as Parameters<typeof showLanguage>[0]).then(() => setReady(true)); }, []);
    if (!ready) return null;
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
