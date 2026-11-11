/**
 * The real LearnPage, and the real Market with the word "tip" typed, one at a time by the address's hash, for
 * e2e/learn-320.mjs: the real rows, the real page, the real stylesheet, every /api call answered by Playwright.
 *   #front  #topic  #search  #page-flood  #page-old  #page-gathered  #market
 * What the app is asked (onBack, onNavigate, onOpenProfile) is written into window.__navs. The mobile header sits above
 * the page here as App.tsx draws it, so the title row and the page are seen together. Layout here is inline style: this
 * folder is outside Tailwind's content globs.
 */
import { createRoot } from 'react-dom/client';
import { LearnPage, type LearnTarget } from '../src/pages/LearnPage';
import { MarketplacePage } from '../src/pages/MarketplacePage';
import { useTheme } from '../src/lib/useTheme';
import { IDENTITY } from './fixtures.mjs';
import '../src/index.css';

declare global { interface Window { __navs: unknown[][] } }
window.__navs = [];
const note = (...args: unknown[]) => { window.__navs.push(args); };

const state = (window.location.hash || '#front').slice(1);
const target: LearnTarget | null =
    state === 'topic' ? { kind: 'topic', topic: 'local-services' }
    : state === 'search' ? { kind: 'search', q: 'zeppelin' }
    : state === 'search-hit' ? { kind: 'search', q: 'tip' }
    : state.startsWith('page-') ? { kind: 'page', id: state.slice(5) }
    : null;

function Harness() {
    useTheme();
    return (
        <div style={{ minHeight: '100vh', paddingBottom: 'var(--bottom-nav-offset, 0px)' }}>
            {state === 'market'
                ? <MarketplacePage identity={IDENTITY as never} isMember={true} openSearch="tip" onSearchOpened={() => {}} onNavigate={(...a: unknown[]) => note('navigate', ...a)} transactions={[]} />
                : <LearnPage
                    identity={IDENTITY as never}
                    target={target}
                    onTargetTaken={() => {}}
                    onBack={() => note('back')}
                    onOpenProfile={(pk) => note('profile', pk)}
                    onNavigate={(...a: unknown[]) => note('navigate', ...a)}
                    onNearYou={() => note('near-you')}
                />}
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
