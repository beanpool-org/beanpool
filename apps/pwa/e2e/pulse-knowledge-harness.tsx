/**
 * The real PulsePage for e2e/pulse-knowledge-shots.mjs (slice KP), in `?lang=en|<code>`: the language is shown before the
 * page is, so the card's words are that language's. Every /api call is answered by Playwright.
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PulsePage } from '../src/pages/PulsePage';
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
    return <PulsePage identity={IDENTITY as never} onOpenProfile={() => {}} profile="local" onNavigate={() => {}} />;
}

createRoot(document.getElementById('root')!).render(<Harness />);
