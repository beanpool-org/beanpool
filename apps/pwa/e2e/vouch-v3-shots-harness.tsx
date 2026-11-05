import React from 'react';
import { createRoot } from 'react-dom/client';
import { showLanguage } from '../src/lib/language';
import { useTheme } from '../src/lib/useTheme';
import { VoucherCardModal } from '../src/components/VoucherCardModal';
import { InvitePage } from '../src/pages/InvitePage';
import { PublicProfilePage } from '../src/pages/PublicProfilePage';
import { LedgerPage } from '../src/pages/LedgerPage';
import '../src/index.css';

const params = new URLSearchParams(location.search);
const view = params.get('view') || 'invite';
const theme = params.get('theme') || 'dark';

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

void showLanguage('en').then(() => {
    createRoot(document.getElementById('root')!).render(<HarnessApp />);
    document.documentElement.dataset.harnessReady = 'true';
});
