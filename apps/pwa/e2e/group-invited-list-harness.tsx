/**
 * The real group sheet (GroupDetailModal, with "Invited, not joined yet" under its members) for
 * e2e/group-invited-list-shots.mjs. Nothing here talks to a node: the driver answers /api.
 */
import { createRoot } from 'react-dom/client';
import { GroupDetailModal } from '../src/components/GroupDetailModal';
import { useTheme } from '../src/lib/useTheme';
import type { Group } from '../src/lib/api';
import '../src/index.css';

const ME = 'a'.repeat(64);
const card = {
    id: 'g-1', name: 'Secret Garden Club', slug: 'secret-garden-club', category: 'social', joinPolicy: 'invite_only',
    description: 'Seeds, swaps and slow Sundays.', memberCount: 3, createdBy: ME, createdAt: '2026-10-01T00:00:00Z', leadPubkey: ME,
    viewerRole: 'convenor', viewerStatus: 'active', closedAt: null,
} as unknown as Group;

function Harness() {
    useTheme();
    return <GroupDetailModal group={card} isOpen onClose={() => {}} myPubkey={ME} identity={null} />;
}

createRoot(document.getElementById('root')!).render(<Harness />);
document.body.dataset.ready = 'true';
