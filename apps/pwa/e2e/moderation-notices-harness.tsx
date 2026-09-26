/**
 * The moderation notices kept for the web app, rendered on their own so moderation-notices-check.mjs can measure them
 * at 320px with 1.3x text: the real SystemAlerts (its GET /api/notices?unseen=1 and the seen mark answered by the
 * check's page route, never a node) over the app shell's banner column with the real ModerationPauseCard (its
 * /api/community/me answered the same way).
 */
import { createRoot } from 'react-dom/client';
import { SystemAlerts } from '../src/components/SystemAlerts';
import { ModerationPauseCard } from '../src/components/ModerationPauseCard';
import '../src/index.css';

createRoot(document.getElementById('root')!).render(
    <>
        {/* The app shell's banner column (App.tsx). */}
        <div data-testid="shell" className="max-w-xl mx-auto px-4 pt-2">
            <ModerationPauseCard />
        </div>
        <SystemAlerts memberPubkey="harness-member" isGuest={false} />
    </>,
);
