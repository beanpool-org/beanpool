/**
 * "This community has moved to …" (lost-name L4), rendered on its own so former-address-check.mjs can measure it at
 * 320px with 1.3x text: the real FormerAddressBanner, reading /api/community/info as the app does (answered by the
 * check's page route, never a node), at the top of a column shaped like the app's main column (App.tsx), above a
 * stand-in for the mobile header, once as a member's screen draws it and once as the lobby's and welcome page's.
 */
import { createRoot } from 'react-dom/client';
import { FormerAddressBanner } from '../src/components/FormerAddressBanner';
import '../src/index.css';

const header = <div style={{ minHeight: '46px', background: '#384038' }} aria-hidden="true" />;

createRoot(document.getElementById('root')!).render(
    <>
        <div data-testid="member" className="flex flex-col overflow-hidden relative" style={{ height: '320px' }}>
            <FormerAddressBanner signedIn />
            {header}
            <main style={{ flex: 1, minHeight: 0 }} />
        </div>
        <div data-testid="visitor" className="flex flex-col overflow-hidden relative mt-4" style={{ height: '320px' }}>
            <FormerAddressBanner />
            {header}
            <main style={{ flex: 1, minHeight: 0 }} />
        </div>
    </>,
);
