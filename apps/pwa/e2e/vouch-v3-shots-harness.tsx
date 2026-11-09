import React from 'react';
import { createRoot } from 'react-dom/client';
import { showLanguage } from '../src/lib/language';
import { useTheme } from '../src/lib/useTheme';
import { VoucherCardModal } from '../src/components/VoucherCardModal';
import { InvitePage } from '../src/pages/InvitePage';
import { PublicProfilePage } from '../src/pages/PublicProfilePage';
import { LedgerPage } from '../src/pages/LedgerPage';
import { MyBudgetModal } from '../src/components/MyBudgetModal';
import { createIdentity } from '../src/lib/identity';
import '../src/index.css';

const params = new URLSearchParams(location.search);
const view = params.get('view') || 'invite';
const theme = params.get('theme') || 'dark';
/** An owner's view (Marty, 9 Nov): no budget limit, 200 and 500 too. */
const owner = params.get('owner') === '1';

try { localStorage.setItem('beanpool-theme-mode', theme); } catch {}
if (theme === 'dark') {
    document.documentElement.classList.add('dark', 'dark-theme');
    document.documentElement.classList.remove('light-theme');
    document.documentElement.style.colorScheme = 'dark';
} else {
    document.documentElement.classList.remove('dark', 'dark-theme');
    document.documentElement.classList.add('light-theme');
    document.documentElement.style.colorScheme = 'light';
}

const mockIdentity: any = {
    publicKey: '0'.repeat(64),
    privateKey: '1'.repeat(64),
    callsign: 'Alice',
    createdAt: new Date(Date.now() - 30 * 86400000).toISOString(),
    role: 'owner',
};

function HarnessApp() {
    useTheme();

    if (view === 'card') {
        return (
            <div className="p-2 min-h-screen bg-oat-100 dark:bg-nature-950">
                <VoucherCardModal
                    memberPubkey={'a'.repeat(64)}
                    onClose={() => {}}
                />
            </div>
        );
    }

    if (view === 'profile') {
        return (
            <div className="p-2 min-h-screen bg-oat-100 dark:bg-nature-950">
                <PublicProfilePage
                    pubkey={'s'.repeat(64)}
                    identity={mockIdentity}
                    onBack={() => {}}
                    onMessage={() => {}}
                    onNavigateTab={() => {}}
                    onNavigatePost={() => {}}
                />
            </div>
        );
    }

    if (view === 'budget') {
        // The Ledger's "Your budget to vouch from" dialog, open (#2915 round 4, finding 3).
        return (
            <div className="p-2 min-h-screen bg-oat-100 dark:bg-nature-950">
                <MyBudgetModal
                    vouching={{
                        voucher: true,
                        budget: { left: 550, held: 100, heldInvites: 1, vouched: 350, peopleVouched: 4, level: 1000 },
                        noLimit: owner,
                        presets: owner ? [25, 50, 75, 100, 200, 500] : [25, 50, 75, 100],
                        vouchMax: owner ? 500 : 100,
                        budgetMax: 2000,
                        vouchedBy: [],
                        history: [
                            { kind: 'grant', amount: 1000, actor: 'b'.repeat(64), actorCallsign: 'marty', at: '2026-11-01T00:00:00Z' },
                            { kind: 'hold', amount: -100, actor: '0'.repeat(64), actorCallsign: 'Alice', at: '2026-11-02T00:00:00Z', for: 'invite', outcome: 'held' },
                            { kind: 'top_up', amount: 500, actor: 'c'.repeat(64), actorCallsign: 'damo', at: '2026-11-04T00:00:00Z' },
                        ],
                    }}
                    onClose={() => {}}
                />
            </div>
        );
    }

    if (view === 'ledger') {
        return (
            <div className="p-2 min-h-screen bg-oat-100 dark:bg-nature-950">
                <LedgerPage
                    identity={mockIdentity}
                    isMember={true}
                    onNavigate={() => {}}
                />
            </div>
        );
    }

    // Default: invite
    return (
        <div className="p-2 min-h-screen bg-oat-100 dark:bg-nature-950">
            <InvitePage
                identity={mockIdentity}
                onNavigate={() => {}}
            />
        </div>
    );
}

// The profile's vouch card asks GET /api/vouchers/me, which needs a stored identity to sign with (lib/api.ts
// getMyVouching): without one it answers null and the card is never drawn. A throwaway key, in this browser only.
// An owner's invite view signs its read of /api/vouchers/me too, so the presets show (200 and 500).
const ready = view === 'profile' || (owner && view === 'invite') ? createIdentity('Alice').then(() => undefined, () => undefined) : Promise.resolve();

void ready.then(() => showLanguage('en')).then(() => {
    createRoot(document.getElementById('root')!).render(<HarnessApp />);
    document.documentElement.dataset.harnessReady = 'true';
});
