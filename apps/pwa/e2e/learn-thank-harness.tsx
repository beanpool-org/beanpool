/**
 * Learn's recognition (slice K8; DESIGN-local-knowledge-fable.md §2.10, §3.7) for e2e/learn-thank-320.mjs, the real pages with the
 * real stylesheet: `?screen=page` is the real LearnPage on Ada's page, handed `onThank` as App.tsx hands it where Beans are live,
 * and a tap on "🫘 Thank Ada" swaps in the real LedgerPage with that request as `sendStart` (App.tsx's `ledgerSend`), taken
 * once. `?screen=profile` is the real PublicProfilePage on Ada. Every /api call is answered by that script; what a tap hands
 * over is written into window.__thanks.
 */
import { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LearnPage, type LearnThank } from '../src/pages/LearnPage';
import { LedgerPage } from '../src/pages/LedgerPage';
import { PublicProfilePage } from '../src/pages/PublicProfilePage';
import { useTheme } from '../src/lib/useTheme';
import { IDENTITY } from './fixtures.mjs';
import '../src/index.css';

declare global { interface Window { __thanks: LearnThank[] } }
window.__thanks = [];

const screenName = new URLSearchParams(window.location.search).get('screen') || 'page';

function Harness() {
    useTheme();
    const [send, setSend] = useState<LearnThank | null>(null);
    const [onLedger, setOnLedger] = useState(false);
    const taken = useCallback(() => setSend(null), []);
    if (screenName === 'profile') {
        return <PublicProfilePage identity={IDENTITY as never} pubkey="member-ada" onBack={() => {}} onMessage={() => {}} onNavigatePost={() => {}} />;
    }
    if (onLedger) {
        return <LedgerPage identity={IDENTITY as never} isMember onNavigate={() => {}} sendStart={send} onSendStartTaken={taken} />;
    }
    return (
        <LearnPage
            identity={IDENTITY as never}
            target={{ kind: 'page', id: 'tip' }}
            onTargetTaken={() => {}}
            onBack={() => {}}
            onOpenProfile={() => {}}
            onNavigate={() => {}}
            onNearYou={() => {}}
            onThank={(s) => { window.__thanks.push(s); setSend(s); setOnLedger(true); }}
        />
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
