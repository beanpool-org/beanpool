import { createRoot } from 'react-dom/client';
import React from 'react';
import { YourShopPage } from '../src/pages/YourShopPage';
import { ShopDetailPage } from '../src/pages/ShopDetailPage';
import { useTheme } from '../src/lib/useTheme';
import type { BeanPoolIdentity } from '../src/lib/identity';
import '../src/index.css';

const myIdentity: BeanPoolIdentity = {
    publicKey: 'me-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    privateKey: 'mock-private-key',
    callsign: 'Dave',
    createdAt: '2026-01-01T00:00:00.000Z',
};

function Harness() {
    useTheme();
    const params = new URLSearchParams(window.location.search);
    const view = params.get('view') || 'empty';

    if (view === 'empty' || view === 'open' || view === 'close-refusal') {
        return (
            <div className="min-h-screen">
                <YourShopPage
                    identity={myIdentity}
                    onBack={() => {}}
                    onOpenShop={() => {}}
                    onOpenTools={() => {}}
                    onOpenPost={() => {}}
                    onOpenDeals={() => {}}
                />
            </div>
        );
    }

    if (view === 'shop-owner') {
        return (
            <div className="min-h-screen">
                <ShopDetailPage
                    id="shop-my"
                    identity={myIdentity}
                    onBack={() => {}}
                    onOpenYourShop={() => {}}
                    onOpenEnterprise={() => {}}
                    onOpenProfile={() => {}}
                    onOpenPost={() => {}}
                    onMessage={() => {}}
                />
            </div>
        );
    }

    return (
        <div className="min-h-screen">
            <ShopDetailPage
                id="shop-kofi"
                identity={myIdentity}
                onBack={() => {}}
                onOpenYourShop={() => {}}
                onOpenEnterprise={() => {}}
                onOpenProfile={() => {}}
                onOpenPost={() => {}}
                onMessage={() => {}}
            />
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
