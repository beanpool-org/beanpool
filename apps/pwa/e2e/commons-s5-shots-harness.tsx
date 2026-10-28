import React from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectsPage } from '../src/pages/ProjectsPage';
import { useTheme } from '../src/lib/useTheme';
import type { BeanPoolIdentity } from '../src/lib/identity';
import '../src/index.css';

const mockIdentity: BeanPoolIdentity = {
    publicKey: 'a1b2c3d4e5f67890123456789012345678901234567890123456789012345678',
    privateKey: 'mock-private-key',
    callsign: 'Alice',
    createdAt: '2026-01-01T00:00:00.000Z',
};

/**
 * Commons S5 and S6 shots (Fable 5.1 §5): the stat cards with the phone's voice-credits words, the empty states by kind,
 * the Start something dialog Talk's bridge opens (initialStart), and the start form opened with neither kind picked. The
 * script (commons-s5-shots.mjs) answers the page's reads and clicks the chips and rows.
 */
function Harness() {
    useTheme();
    const view = new URLSearchParams(window.location.search).get('view') || 'decide';
    return (
        <div className="min-h-screen bg-oat-100 dark:bg-nature-950">
            <ProjectsPage
                identity={mockIdentity}
                isMember={true}
                initialSection={view === 'decide' ? 'decide' : 'groups'}
                initialStart={view === 'start-dialog'}
            />
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
