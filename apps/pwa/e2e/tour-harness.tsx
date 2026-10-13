/**
 * The tour's bar, the "?" dialog and the mobile header's pill on their own (scratch/global-node/DESIGN-getting-started-
 * fable.md §2, §4, §5), for e2e/tour-check.mjs: the real components, the real stylesheet, nothing from a node.
 * ?view=step&i=N[&global=1] · ?view=help&key=<help-map key> · ?view=header&title=<words>; &dark=1 for the dark scheme.
 * The header row is App.tsx's own inline styles around the real pill (the sync dot as its 26 px box).
 */
import { createRoot } from 'react-dom/client';
import { TourBar } from '../src/components/TourBar';
import { HelpDialog } from '../src/components/HelpDialog';
import { HEADER_TITLE_SHIFT_PX, HeaderControls } from '../src/components/HeaderControls';
import { helpSheetFor, tourSteps } from '@beanpool/core';
import { getBundledGuide } from '../src/lib/guide';

const q = new URLSearchParams(location.search);
if (q.get('dark') === '1') document.documentElement.classList.add('dark');
const view = q.get('view');
const node = { global: q.get('global') === '1', beans: q.get('global') !== '1' };
const steps = tourSteps('web', node);
const home = { chips: ['steps', 'market', 'beans'], chipName: (t: string) => ({ steps: 'First steps', market: 'New in the Market', beans: 'Your Beans' } as Record<string, string>)[t], onHome: (t: string) => t === 'market', addChip() {}, moreCards() {} };
function App() {
    if (view === 'header') {
        // The mobile header row as App.tsx draws it (its own inline styles), with the real pill; the sync dot as its 26 px box.
        return (
            <div style={{ minHeight: '100vh' }} className="bg-nature-50 dark:bg-nature-950">
                <header id="hdr" className="relative shadow-md" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.3rem 0.75rem', position: 'sticky', top: 0, background: '#14281d' }}>
                    <div id="sync" className="relative z-10" style={{ marginTop: '12px', width: 26, height: 26 }} />
                    <div className="absolute left-1/2 -translate-x-1/2 flex justify-center items-center z-10">
                        <span id="title" className="font-extrabold text-[1.4rem] tracking-tight text-rainbow" style={{ marginTop: '8px', transform: `translateX(${HEADER_TITLE_SHIFT_PX}px)` }}>{q.get('title') ?? 'Market'}</span>
                    </div>
                    <div id="pill"><HeaderControls showSettings={false} setShowSettings={() => {}} identityPubkey="ab" onOpenProfile={() => {}} /></div>
                </header>
            </div>
        );
    }
    if (view === 'help') {
        const sheet = helpSheetFor(getBundledGuide() as never, q.get('key') ?? 'market');
        return <div className="bg-nature-50 dark:bg-nature-950" style={{ minHeight: '100vh' }}><HelpDialog sheet={sheet} tourOpen={false} canTour onReadPage={() => {}} onSearch={() => {}} onTour={() => {}} onClose={() => {}} /></div>;
    }
    const i = Number(q.get('i') ?? 0);
    return (
        <div className="bg-nature-50 dark:bg-nature-950" style={{ minHeight: '100vh', ['--bottom-nav-offset' as string]: '62px' }}>
            <p className="p-4 text-nature-900 dark:text-white">The tab behind the bar.</p>
            <button id="behind" style={{ position: 'fixed', left: 16, top: 120, minHeight: 44 }}>A button behind</button>
            <TourBar steps={steps} index={i} home={i === steps.length - 1 ? home : null} onNext={() => {}} onSkip={() => {}} onDone={() => {}} />
        </div>
    );
}
createRoot(document.getElementById('root')!).render(<App />);
