import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectsPage } from '../src/pages/ProjectsPage';
import { CreateGroupModal } from '../src/components/CreateGroupModal';
import { PeoplePage } from '../src/pages/PeoplePage';
import { useTheme } from '../src/lib/useTheme';
import type { BeanPoolIdentity } from '../src/lib/identity';
import '../src/index.css';

const mockIdentity: BeanPoolIdentity = {
    publicKey: 'a1b2c3d4e5f67890123456789012345678901234567890123456789012345678',
    privateKey: 'mock-private-key',
    callsign: 'Alice',
    createdAt: '2026-01-01T00:00:00.000Z',
};

function Harness() {
    useTheme();
    const params = new URLSearchParams(window.location.search);
    const view = params.get('view') || 'start-enterprise';

    useEffect(() => {
        if (view === 'start-enterprise') {
            const interval = setInterval(() => {
                if (document.querySelector('form')) {
                    clearInterval(interval);
                    return;
                }
                const fallbackBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Start an enterprise')) as HTMLButtonElement;
                if (fallbackBtn) {
                    fallbackBtn.click();
                    return;
                }
                const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Start something')) as HTMLButtonElement;
                if (btn) {
                    btn.click();
                    const entBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Enterprise')) as HTMLButtonElement;
                    if (entBtn) entBtn.click();
                }
            }, 100);
            return () => clearInterval(interval);
        } else if (view === 'start-project') {
            const interval = setInterval(() => {
                if (document.querySelector('form')) {
                    clearInterval(interval);
                    return;
                }
                const fallbackBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Start a project')) as HTMLButtonElement;
                if (fallbackBtn) {
                    fallbackBtn.click();
                    return;
                }
                const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Start something')) as HTMLButtonElement;
                if (btn) {
                    btn.click();
                    const projBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Project')) as HTMLButtonElement;
                    if (projBtn) projBtn.click();
                }
            }, 100);
            return () => clearInterval(interval);
        }
    }, [view]);

    if (view === 'start-enterprise') {
        return (
            <div className="min-h-screen bg-oat-100 dark:bg-nature-950">
                <ProjectsPage identity={mockIdentity} initialSection="enterprises" isMember={true} />
            </div>
        );
    }

    if (view === 'start-project') {
        return (
            <div className="min-h-screen bg-oat-100 dark:bg-nature-950">
                <ProjectsPage identity={mockIdentity} initialSection="projects" isMember={true} />
            </div>
        );
    }

    if (view === 'create-group') {
        return (
            <div className="min-h-screen bg-oat-100 dark:bg-nature-950">
                <CreateGroupModal
                    isOpen={true}
                    onClose={() => {}}
                    onCreated={() => {}}
                />
            </div>
        );
    }

    if (view === 'members-list') {
        return (
            <div className="min-h-screen bg-oat-100 dark:bg-nature-950">
                <PeoplePage
                    identity={mockIdentity}
                    initialView="community"
                />
            </div>
        );
    }

    return <div>Unknown view: {view}</div>;
}

createRoot(document.getElementById('root')!).render(<Harness />);
