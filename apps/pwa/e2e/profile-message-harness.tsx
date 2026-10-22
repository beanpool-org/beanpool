import { createRoot } from 'react-dom/client';
import React, { useEffect, useState } from 'react';
import { PublicProfilePage } from '../src/pages/PublicProfilePage';
import { PeoplePage } from '../src/pages/PeoplePage';
import { useTheme } from '../src/lib/useTheme';
import type { BeanPoolIdentity } from '../src/lib/identity';
import '../src/index.css';

const identity: BeanPoolIdentity = {
    publicKey: 'me-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    privateKey: 'mock-private-key',
    callsign: 'Wren',
    createdAt: '2026-01-01T00:00:00.000Z',
};

const KOFI_PUBKEY = 'kofi-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

function Harness() {
    useTheme();
    const params = new URLSearchParams(window.location.search);
    const view = params.get('view') || 'profile';

    if (view === 'community') {
        return (
            <div className="max-w-md mx-auto p-4">
                <PeoplePage
                    identity={identity}
                    initialView="community"
                    onNavigate={() => {}}
                    onOpenProfile={() => {}}
                />
            </div>
        );
    }

    return (
        <div className="max-w-md mx-auto">
            <PublicProfilePage
                identity={identity}
                pubkey={KOFI_PUBKEY}
                onBack={() => {}}
                onMessage={() => {}}
                onNavigate={() => {}}
            />
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
