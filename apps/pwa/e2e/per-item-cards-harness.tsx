/**
 * Per-item prices, slice P2 (DESIGN-per-item-price-fable.md §2.1, §2.2): the real Market page, in its list, grid and compact views and
 * opened on a listing priced for each one, so the cards and the price box can be photographed at 320 px with 130% text, light and
 * dark. The node's answers are the e2e/per-item-cards-shots.mjs routes; nothing leaves the machine.
 */
import { createRoot } from 'react-dom/client';
import { MarketplacePage } from '../src/pages/MarketplacePage';
import type { BeanPoolIdentity } from '../src/lib/identity';
import '../src/index.css';

const q = new URLSearchParams(window.location.search);
if (q.get('dark') === '1') document.documentElement.classList.add('dark', 'dark-theme');
else document.documentElement.classList.remove('dark', 'dark-theme');

const identity: BeanPoolIdentity = { publicKey: 'me-key', privateKey: '00'.repeat(32), callsign: 'Ana', createdAt: '2026-09-01T00:00:00.000Z' };
const open = q.get('open');
const page = <MarketplacePage identity={identity} isMember={true} openPostId={open} onPostOpened={() => {}} transactions={[]} />;

createRoot(document.getElementById('root')!).render(open ? page : <div className="max-w-[320px]">{page}</div>);
