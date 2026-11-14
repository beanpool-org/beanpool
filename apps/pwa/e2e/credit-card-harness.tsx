/**
 * The Ledger's credit card (components/CreditBar.tsx, slice R1 of DESIGN-credit-bar-amend-fable.md) for
 * e2e/credit-card-shots.mjs: the members of the design's brief and the rarer states, each in the Ledger's own card, drawn by
 * the app's own code in the look the driver stored, in `?lang=en|xx|<code>`. Nothing here talks to a node.
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CreditStandingAnswer } from '@beanpool/core';
import { CreditBar } from '../src/components/CreditBar';
import { useTheme } from '../src/lib/useTheme';
import { showLanguage } from '../src/lib/language';
import '../src/index.css';

const b = (n: number) => n * 100;
/** Every money figure whole hundredths, as the node's balance answer. */
const FIXTURES: Array<[string, CreditStandingAnswer]> = [
    ['owing-vouched', { balance_c: -b(50), floor_c: -b(500), usableFloor_c: -b(500), roomHeld_c: b(500), earnedCredit_c: 0, liveOffers: 1, vouchedBy: [{ callsign: 'Damo', amount_c: b(500) }] }],
    ['three-sources', { balance_c: b(120), floor_c: -b(700), usableFloor_c: -b(700), roomHeld_c: b(500), earnedCredit_c: b(200), liveOffers: 2, vouchedBy: [{ callsign: 'Damo', amount_c: b(300) }, { callsign: 'Jane', amount_c: b(200) }] }],
    ['part-closed', { balance_c: -b(120), floor_c: -b(900), usableFloor_c: -b(500), roomHeld_c: b(300), earnedCredit_c: b(600), liveOffers: 1, vouchedBy: [{ callsign: 'Damo', amount_c: b(300) }] }],
    ['nearly', { balance_c: -b(480), floor_c: -b(500), usableFloor_c: -b(500), roomHeld_c: b(500), liveOffers: 1, vouchedBy: [{ callsign: 'Damo', amount_c: b(500) }] }],
    ['holding-fee', { balance_c: b(260), floor_c: -b(1100), usableFloor_c: -b(1100), knownGrant_c: b(1000), roomHeld_c: b(100), liveOffers: 1, vouchedBy: [{ callsign: 'Olive', amount_c: b(100) }] }],
    ['paused', { balance_c: -b(350), floor_c: -b(1000), usableFloor_c: -b(200), earnedCredit_c: b(1000), liveOffers: 1 }],
    ['asleep', { balance_c: 0, floor_c: -b(500), usableFloor_c: 0, roomHeld_c: b(500), liveOffers: 0, vouchedBy: [{ callsign: 'Damo', amount_c: b(500) }] }],
    ['no-line', { balance_c: b(40), floor_c: 0 }],
    ['capped', { balance_c: -b(1990), floor_c: -b(2000), usableFloor_c: -b(2000), knownGrant_c: b(1000), earnedCredit_c: b(1200), liveOffers: 5 }],
];

const q = new URLSearchParams(window.location.search);
const lang = q.get('lang') ?? 'en';

function Harness() {
    useTheme();
    const [ready, setReady] = useState(lang === 'en');
    useEffect(() => { if (lang !== 'en') void showLanguage(lang as Parameters<typeof showLanguage>[0]).then(() => setReady(true)); }, []);
    if (!ready) return null;
    return (
        <div className="p-4 md:p-6 max-w-6xl mx-auto" data-ready="1">
            {FIXTURES.map(([id, answer]) => (
                <div key={id} data-fixture={id} className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl px-5 pt-3 pb-4 mb-4 shadow-sm">
                    <CreditBar answer={answer} onOpen={() => {}} />
                </div>
            ))}
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
