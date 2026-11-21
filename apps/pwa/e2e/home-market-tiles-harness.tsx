/**
 * The real HomePage with only its Market card, for e2e/home-market-tiles-320.mjs: the real tiles and the real stylesheet,
 * every /api call answered by Playwright. `window.__showLanguage(lang)` loads a language's words the way Settings does
 * (lib/language.ts) and Home is drawn again in it, so one page can be read in all 25 languages.
 */
import { createRoot } from 'react-dom/client';
import { HomePage } from '../src/pages/HomePage';
import { useTheme } from '../src/lib/useTheme';
import { useLanguage } from '../src/lib/useLanguage';
import { showLanguage } from '../src/lib/language';
import '../src/index.css';

const IDENTITY = { publicKey: 'b'.repeat(64), privateKey: '', callsign: 'Ana', createdAt: '2026-01-01T00:00:00.000Z' };

(window as unknown as { __showLanguage: (lang: string) => Promise<boolean> }).__showLanguage = (lang) => showLanguage(lang as never);

function Harness() {
    useTheme();
    const [lang] = useLanguage();
    return <HomePage key={lang} identity={IDENTITY as never} onNavigate={() => {}} />;
}

createRoot(document.getElementById('root')!).render(<Harness />);
