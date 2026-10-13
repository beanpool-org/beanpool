/**
 * The tour's bar, the "?" dialog and the mobile header's pill on their own (scratch/global-node/DESIGN-getting-started-
 * fable.md §2, §4, §5), for e2e/tour-check.mjs: the real components, the real stylesheet, nothing from a node.
 * ?view=step&i=N[&global=1[&showcase=1]] · ?view=help&key=<help-map key> · ?view=header · ?view=lobby&title=<words>
 * (the lobby's own mobile header, components/LobbyHeader.tsx); &dark=1 for the dark scheme.
 * A step also draws its tab's own bottom button (the Market's + ADD POST, the Map's +), with the classes and offset
 * tour-check.mjs read out of MarketplacePage.tsx and MapPage.tsx (fabs.json), under the real stylesheet's offset.
 * The header view is one row per title and chip (HEADER_TITLES x HEADER_CHIPS): App.tsx's header row with the real sync chip
 * (components/SyncChip.tsx, stacked as the header draws it: Online, Online and Offline with how long ago, Guest; at its dot
 * alone where the title wouldn't fit beside its words, useDotOnlyChip), the real title (HeaderTitle) and the real pill.
 */
import { createRoot } from 'react-dom/client';
import { TourBar } from '../src/components/TourBar';
import { HelpDialog } from '../src/components/HelpDialog';
import { HeaderControls, HeaderTitle, useDotOnlyChip } from '../src/components/HeaderControls';
import { LobbyHeader } from '../src/components/LobbyHeader';
import { SyncChip, type SyncMode } from '../src/components/SyncChip';
import { helpSheetFor, tourSteps } from '@beanpool/core';
import { getBundledGuide } from '../src/lib/guide';

const q = new URLSearchParams(location.search);
// Dark as lib/useTheme.ts makes it: Tailwind's dark: classes and the theme's own colours (--bg-card and the rest).
if (q.get('dark') === '1') document.documentElement.classList.add('dark', 'dark-theme');
const view = q.get('view');
const node = { global: q.get('global') === '1', beans: q.get('global') !== '1', showcase: q.get('showcase') === '1' };
const steps = tourSteps('web', node);
const home = { chips: ['steps', 'market', 'beans'], chipName: (t: string) => ({ steps: 'First steps', market: 'New in the Market', beans: 'Your Beans' } as Record<string, string>)[t], onHome: (t: string) => t === 'market', addChip() {}, moreCards() {} };
const fabs = (await (await fetch('fabs.json')).json()) as Record<'market' | 'map', { className: string; bottom: string }>;
/** Every title the mobile header shows (App.tsx TABS, the Pulse) and the longest word a tab ever had. */
const HEADER_TITLES = ['Home', 'Market', 'Map', 'Commons', 'Chat', 'People', 'Ledger', 'The Pulse', 'Marketplace'];
/** The chip's words: Online alone (before the first sync), Online and Offline with how long ago (Offline its widest), Guest. */
const HEADER_CHIPS: [SyncMode, string | null][] = [['online', null], ['online', '5s ago'], ['offline', '59m ago'], ['guest', null]];
/** One mobile header row as App.tsx draws it (its own inline styles), with the real chip, title and pill. */
function HeaderRow({ title, mode, ago }: { title: string; mode: SyncMode; ago: string | null }) {
    const [ref, dotOnly] = useDotOnlyChip(title);
    return (
        <header ref={ref} data-row={title + ' · ' + mode + (ago ? ' ' + ago : '')} className="relative shadow-md" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.3rem 0.75rem', background: '#14281d' }}>
            <div className="relative z-10 shrink-0" style={{ marginTop: '12px' }}>
                <SyncChip mode={mode} ago={ago} pulsing={false} stacked dotOnly={dotOnly} />
            </div>
            <HeaderTitle title={title} />
            <HeaderControls showSettings={false} setShowSettings={() => {}} identityPubkey="ab" onOpenProfile={() => {}} />
        </header>
    );
}
function App() {
    if (view === 'header') {
        return (
            <div style={{ minHeight: '100vh' }} className="bg-nature-50 dark:bg-nature-950">
                {HEADER_TITLES.flatMap(title => HEADER_CHIPS.map(([mode, ago]) => <HeaderRow key={title + mode + ago} title={title} mode={mode} ago={ago} />))}
            </div>
        );
    }
    if (view === 'lobby') {
        const title = q.get('title') ?? 'Market';
        return <div style={{ minHeight: '100vh' }} className="bg-nature-50 dark:bg-nature-950"><LobbyHeader tab={title === 'Map' ? 'map' : 'home'} title={title} onHelp={() => {}} onJoin={() => {}} joinDisabled={false} /></div>;
    }
    if (view === 'help') {
        const sheet = helpSheetFor(getBundledGuide() as never, q.get('key') ?? 'market');
        return <div className="bg-nature-50 dark:bg-nature-950" style={{ minHeight: '100vh' }}><HelpDialog sheet={sheet} tourOpen={false} canTour onReadPage={() => {}} onSearch={() => {}} onTour={() => {}} onClose={() => {}} /></div>;
    }
    const i = Number(q.get('i') ?? 0);
    const fab = steps[i]?.tab === 'map' ? fabs.map : fabs.market;
    return (
        <div className="bg-nature-50 dark:bg-nature-950" style={{ minHeight: '100vh' }}>
            <p className="p-4 text-nature-900 dark:text-white">The tab behind the bar.</p>
            <button id="behind" style={{ position: 'fixed', left: 16, top: 120, minHeight: 44 }}>A button behind</button>
            <button id="fab" className={fab.className} style={{ bottom: fab.bottom }}>+ ADD POST</button>
            <TourBar steps={steps} index={i} home={i === steps.length - 1 ? home : null} onNext={() => {}} onSkip={() => {}} onDone={() => {}} />
        </div>
    );
}
createRoot(document.getElementById('root')!).render(<App />);
