/**
 * The real HomePage and the real MarketplacePage (on its Events pill), one above the other, for e2e/calendar-doors-320.mjs:
 * the real cards, the real calendar doors and the real stylesheet, every /api call answered by Playwright. Each page's
 * onNavigate writes what it was asked into window.__navs, so the check can press a door and read where it goes.
 * Layout here is inline style: this folder is outside Tailwind's content globs.
 */
import { createRoot } from 'react-dom/client';
import { HomePage } from '../src/pages/HomePage';
import { MarketplacePage } from '../src/pages/MarketplacePage';
import { useTheme } from '../src/lib/useTheme';
import { IDENTITY } from './fixtures.mjs';
import '../src/index.css';

declare global { interface Window { __navs: unknown[][] } }
window.__navs = [];
const go = (...args: unknown[]) => { window.__navs.push(args); };

function Harness() {
    useTheme();
    return (
        <div>
            <section data-testid="harness-home"><HomePage identity={IDENTITY as never} onNavigate={go} /></section>
            <section data-testid="harness-market">
                <MarketplacePage identity={IDENTITY as never} isMember={true} openFilter="event" onFilterOpened={() => {}} onNavigate={go} />
            </section>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
