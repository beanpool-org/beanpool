/**
 * Settings → Account & Identity, "Sign-in recovery" (G11-c, and recovery seal S3's line under a connected sign-in),
 * rendered on its own so signin-recovery-check.mjs can measure it at 320px with 1.3x text: the real SignInRecoveryLine
 * inside the Settings page's own column (SettingsPage.tsx: p-4, max-w-3xl, space-y-2.5), connected with one sign-in,
 * with the longest list of names, and not connected. No node: the line takes the node's answer as a prop. With the
 * words, the longest the sentence gets (a browser without them drops its last sentence); and without them, connected
 * and not, as a browser restored from a sign-in copy that carried none reads it.
 */
import { createRoot } from 'react-dom/client';
import { SignInRecoveryLine } from '../src/components/SignInRecoveryLine';
import '../src/index.css';

createRoot(document.getElementById('root')!).render(
    <div className="flex justify-center p-4 min-h-screen page-surface">
        <div className="max-w-3xl w-full mt-2">
            <div className="space-y-2.5">
                <div data-testid="case-one"><SignInRecoveryLine enrolled={['google']} hasWords /></div>
                <div data-testid="case-many"><SignInRecoveryLine enrolled={['google', 'facebook', 'github']} hasWords /></div>
                <div data-testid="case-none"><SignInRecoveryLine enrolled={[]} hasWords /></div>
                <div data-testid="case-one-nowords"><SignInRecoveryLine enrolled={['google']} hasWords={false} /></div>
                <div data-testid="case-none-nowords"><SignInRecoveryLine enrolled={[]} hasWords={false} /></div>
            </div>
        </div>
    </div>,
);
