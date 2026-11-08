/**
 * What a listing priced at 0 reads, and the New Post form's type choices, for e2e/free-label-shots.mjs: the real MarketplaceCard
 * in its grid, list and compact layouts (?view=cards), the real MapPage with its New Post form open (?view=form), and the real
 * MarketplacePage on one listing's own page (?view=detail&post=<id>), with the real stylesheet. Nothing here talks to a node:
 * Playwright answers every /api request. &dark=1 for the dark scheme.
 */
import { createRoot } from 'react-dom/client';
import { MarketplaceCard } from '../src/components/MarketplaceCard';
import { MapPage } from '../src/pages/MapPage';
import { MarketplacePage } from '../src/pages/MarketplacePage';
import '../src/index.css';
// @ts-expect-error the posts are plain data in a module the script shares
import { POSTS } from './free-label-posts.mjs';

const q = new URLSearchParams(location.search);
if (q.get('dark') === '1') document.documentElement.classList.add('dark', 'dark-theme');

const ME = 'a'.repeat(64);
const IDENTITY = { publicKey: ME, privateKey: '', callsign: 'You', createdAt: new Date().toISOString() };
function Cards() {
    return (
        <div className="p-3" data-testid="cards">
            {(['grid', 'list', 'compact'] as const).map(viewMode => (
                <section key={viewMode} className="mb-4" data-testid={`cards-${viewMode}`}>
                    <h2 className="text-xs font-bold uppercase mb-1">{viewMode}</h2>
                    <div className={viewMode === 'grid' ? 'grid grid-cols-2 gap-2' : 'flex flex-col gap-2'}>
                        {(POSTS as any[]).map(post => <MarketplaceCard key={post.id} post={post} viewMode={viewMode} />)}
                    </div>
                </section>
            ))}
        </div>
    );
}

function Harness() {
    const view = q.get('view');
    if (view === 'form') {
        const draft = { type: 'need' as const, title: 'Harvest help', description: 'Pick with us.', category: 'food', credits: 0, priceType: 'fixed' as const, repeatable: false, cashAlsoNeeded: false };
        return <MapPage identity={IDENTITY as never} isMember={true} openDraft={draft} onDraftOpened={() => {}} />;
    }
    if (view === 'detail') {
        return <MarketplacePage identity={IDENTITY as never} openPostId={q.get('post') || 'free-need'} onPostOpened={() => {}} />;
    }
    return <Cards />;
}

createRoot(document.getElementById('root')!).render(<Harness />);
