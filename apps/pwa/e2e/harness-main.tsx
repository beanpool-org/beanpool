/**
 * The Market page on its own, for pictures of the grid. Mounts the real MarketplacePage with the real cards and
 * the real stylesheet; every /api call it makes is answered by Playwright from e2e/fixtures.mjs.
 *
 * Deliberately no App shell: the header, the bottom nav and the onboarding gates are not what is under review,
 * and keeping them out means the harness never has to fake an identity into IndexedDB. `useTheme` IS mounted,
 * so light and dark come from the browser's emulated colour scheme exactly as they do in the app.
 *
 * No Tailwind classes are written in this file — it is outside tailwind.config.js's `content` globs, so any
 * class invented here would simply not be built. Layout below is inline style on purpose.
 */
import { createRoot } from 'react-dom/client';
import { MarketplacePage } from '../src/pages/MarketplacePage';
import { useTheme } from '../src/lib/useTheme';
import { IDENTITY } from './fixtures.mjs';
import '../src/index.css';

function Harness() {
    useTheme();
    return <MarketplacePage identity={IDENTITY as never} isMember={true} />;
}

createRoot(document.getElementById('root')!).render(<Harness />);
