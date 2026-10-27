import { createRoot } from 'react-dom/client';
import { MyDealsModal } from '../src/components/MyDealsModal';
import { MobileHeader } from '../src/components/AppHeader';
import { recordHomeAnswer } from '../src/lib/home-store';
import '../src/index.css';

const q = new URLSearchParams(window.location.search);
if (q.get('dark') === '1') {
    document.documentElement.classList.add('dark', 'dark-theme');
} else {
    document.documentElement.classList.remove('dark', 'dark-theme');
}

const ME = 'user-pubkey-me';
const OTHER = 'user-pubkey-other';
const at = new Date().toISOString();

const FIXTURE_POSTS = [
    {
        id: 'held',
        title: 'Fix the garden gate',
        type: 'need' as const,
        status: 'pending' as const,
        active: true,
        authorPublicKey: ME,
        credits: 12,
        photos: [],
        createdAt: at,
    },
    {
        id: 'action',
        title: 'Sourdough loaves',
        type: 'offer' as const,
        status: 'active' as const,
        active: true,
        authorPublicKey: ME,
        credits: 8,
        photos: [],
        createdAt: at,
    },
    {
        id: 'await',
        title: 'Help moving a couch',
        type: 'offer' as const,
        status: 'active' as const,
        active: true,
        authorPublicKey: OTHER,
        credits: 20,
        photos: [],
        createdAt: at,
    },
];

const FIXTURE_TRANSACTIONS = [
    {
        id: 't-held',
        postId: 'held',
        postTitle: 'Fix the garden gate',
        status: 'pending' as const,
        buyerPublicKey: ME,
        buyerCallsign: 'Me',
        sellerPublicKey: OTHER,
        sellerCallsign: 'Robin',
        postAuthorPublicKey: ME,
        postType: 'need' as const,
        credits: 12,
        createdAt: at,
    },
    {
        id: 't-action',
        postId: 'action',
        postTitle: 'Sourdough loaves',
        status: 'requested' as const,
        buyerPublicKey: 'n3',
        buyerCallsign: 'Alex',
        sellerPublicKey: ME,
        sellerCallsign: 'Me',
        postAuthorPublicKey: ME,
        postType: 'offer' as const,
        credits: 8,
        createdAt: at,
    },
    {
        id: 't-await',
        postId: 'await',
        postTitle: 'Help moving a couch',
        status: 'requested' as const,
        buyerPublicKey: ME,
        buyerCallsign: 'Me',
        sellerPublicKey: OTHER,
        sellerCallsign: 'Sam',
        postAuthorPublicKey: OTHER,
        postType: 'offer' as const,
        credits: 20,
        createdAt: at,
    },
];

const view = q.get('view') || 'modal';

function Harness() {
    if (view === 'header') {
        recordHomeAnswer({
            generatedAt: new Date().toISOString(),
            profile: 'local',
            features: { beans: true, decisions: true, invites: true },
            layout: { v: 2, cards: [], dismissed: {}, updatedAt: null },
            cards: {
                community: { name: 'Mullumbimby', members: 42 },
                needs: {
                    items: [
                        {
                            kind: 'deal',
                            count: 2,
                            accent: true,
                            label: '2 deals waiting for you',
                            target: { to: 'deal', postId: 'held', txId: 't-held' },
                        },
                    ],
                },
            },
        } as never, ME);

        return (
            <div className="w-full max-w-[320px] mx-auto pt-2 bg-nature-50 dark:bg-nature-950">
                <MobileHeader
                    title="Market"
                    activeTab="marketplace"
                    isGuest={false}
                    onNavigate={() => {}}
                    identityPubkey={ME}
                />
                <div className="p-4 text-xs text-nature-500">
                    Header with Deals Handshake Badge (2 waiting on you)
                </div>
            </div>
        );
    }

    return (
        <div className="w-full min-h-screen relative">
            <MyDealsModal
                visible={true}
                identity={{ publicKey: ME }}
                initialTab="pending"
                onClose={() => {}}
                posts={FIXTURE_POSTS}
                transactions={FIXTURE_TRANSACTIONS}
            />
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
