/**
 * One main screen on its own over the doodle wallpaper, for wallpaper-shots.mjs: ?screen=home|market|commons. The real
 * page, the real stylesheet, mounted straight in #root (which paints the wallpaper, as in the app) inside a full-height
 * column like the app's content area; every /api call is answered by Playwright. ?plain=1 sets Settings → "Plain
 * background" (.plain-background on <html>).
 *
 * No Tailwind classes here: this file is outside tailwind.config.js's `content` globs. Layout is inline style.
 */
import { createRoot } from 'react-dom/client';
import { HomePage } from '../src/pages/HomePage';
import { MarketplacePage } from '../src/pages/MarketplacePage';
import { ProjectsPage } from '../src/pages/ProjectsPage';
import { useTheme } from '../src/lib/useTheme';
import { IDENTITY } from './fixtures.mjs';
import '../src/index.css';

const params = new URLSearchParams(location.search);
const screen = params.get('screen') ?? 'commons';
if (params.get('plain') === '1') document.documentElement.classList.add('plain-background');

function Harness() {
    useTheme();
    const page = screen === 'home' ? <HomePage identity={IDENTITY as never} />
        : screen === 'market' ? <MarketplacePage identity={IDENTITY as never} isMember={true} />
        : <ProjectsPage identity={IDENTITY as never} onOpenTreasury={() => {}} isMember={true} />;
    return <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>{page}</div>;
}

createRoot(document.getElementById('root')!).render(<Harness />);
