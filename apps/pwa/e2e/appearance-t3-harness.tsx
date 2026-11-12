import React from 'react';
import { createRoot } from 'react-dom/client';
import { MessagesPage } from '../src/pages/MessagesPage';
import { useTheme } from '../src/lib/useTheme';
import type { BeanPoolIdentity } from '../src/lib/identity';
import '../src/index.css';

/**
 * The group chat appearance-t3-shots.mjs answers for, with the screen's height given (the app's shell gives the thread its
 * height; without it the thread is 32 px tall), and the real useTheme() applying the stored look to <html>.
 */
const GROUP_ID = '5c1d2c3b-4a59-4e68-9d7c-8b9a0f1e2d3e';

const me: BeanPoolIdentity = {
    publicKey: 'a1b2c3d4e5f67890123456789012345678901234567890123456789012345678',
    privateKey: 'mock-private-key',
    callsign: 'Alice',
    createdAt: '2026-01-01T00:00:00.000Z',
};

function Harness() {
    useTheme();
    return (
        <div className="bg-oat-100 dark:bg-nature-950" style={{ height: '100vh' }}>
            <MessagesPage identity={me} openConversationId={GROUP_ID} onNavigate={() => {}} />
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
