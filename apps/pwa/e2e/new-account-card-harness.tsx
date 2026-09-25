/**
 * "Your account is new" and the node's refusals (G11-e), rendered on their own so new-account-card-check.mjs can
 * measure them at 320px with 1.3x text: the real NewAccountCard (its /api/community/me answered by the check's
 * page route, never a node), and the post form's and the composer's refusal boxes as MapPage and MessagesPage draw
 * them, around the node's longest sentences.
 */
import { createRoot } from 'react-dom/client';
import { NewAccountCard } from '../src/components/NewAccountCard';
import '../src/index.css';

const LIMIT = 'While your account is new you can message 10 new people in any 24 hours. You can message someone new again in about 23 hours. Replying to someone who wrote to you first is not limited. New accounts have these limits for their first 3 days, and until 3 of their posts have stayed up.';
const MUTED = "Three of your posts were removed by the community's moderators in the last 30 days, so you can't post or send messages here until a moderator lifts this. You can still read, edit your profile and leave.";

createRoot(document.getElementById('root')!).render(
    <>
        {/* The app shell's banner column (App.tsx), with the close button. */}
        <div data-testid="shell" className="max-w-xl mx-auto px-4 pt-2">
            <NewAccountCard onClose={() => {}} />
        </div>
        {/* The Map page's New Post panel (fixed, left-3 right-3, p-5), in flow here: the refusal and the card. */}
        <div data-testid="post-form" className="mx-3 my-4 bg-white dark:bg-nature-900 rounded-3xl p-5 border border-nature-200 dark:border-nature-800">
            <div className="mb-3 min-w-0">
                <div role="alert" className="p-3 mb-3 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 text-sm text-amber-900 dark:text-amber-200 leading-relaxed break-words">
                    {LIMIT}
                </div>
                <NewAccountCard refreshKey="post" />
            </div>
        </div>
        {/* The composer's notice (MessagesPage), inline styles as there. */}
        <div data-testid="chat" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', padding: '0.5rem 1rem', background: 'var(--bg-secondary)', borderTop: '1px solid var(--border-primary)', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            <span style={{ minWidth: 0, flex: 1, wordBreak: 'break-word' }}>{MUTED}</span>
            <button type="button" aria-label="Dismiss" style={{ background: 'none', border: 'none', padding: '6px', minWidth: '28px', minHeight: '28px', flexShrink: 0 }}>✕</button>
        </div>
    </>,
);
