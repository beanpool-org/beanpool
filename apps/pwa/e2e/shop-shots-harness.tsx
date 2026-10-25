import { createRoot } from 'react-dom/client';
import React from 'react';
import { YourShopPage } from '../src/pages/YourShopPage';
import { ShopDetailPage } from '../src/pages/ShopDetailPage';
import { ShopToggle } from '../src/components/shop/ShopToggle';
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

    if (view === 'composer-tick') {
        return (
            <div className="min-h-screen bg-oat-50 dark:bg-nature-950 p-4">
                <div className="max-w-md mx-auto bg-white/95 dark:bg-nature-900/95 backdrop-blur-xl rounded-3xl p-5 border border-nature-200 dark:border-nature-800 shadow-soft">
                    <h2 className="text-lg font-bold text-nature-950 dark:text-white mb-4">New Post</h2>
                    <div className="py-2 px-1">
                        <ShopToggle
                            state={{
                                kind: 'open',
                                shopId: 'shop-my',
                                title: "Dave's Tools & Workshop",
                                inShop: true,
                            }}
                            on={true}
                            onChange={() => {}}
                            testId="composer-shop-toggle"
                        />
                    </div>
                </div>
            </div>
        );
    }

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
