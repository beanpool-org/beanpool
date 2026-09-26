/**
 * Settings → Account & Identity, "Sign-in recovery" (G11-c, and recovery seal S3's line under a connected sign-in),
 * rendered on its own so signin-recovery-check.mjs can measure it at 320px with 1.3x text: the real SignInRecoveryLine
 * inside the Settings page's own column (SettingsPage.tsx: p-4, max-w-3xl, space-y-2.5), connected with one sign-in,
 * with the longest list of names, and not connected. No node: the line takes the node's answer as a prop.
 */
import { createRoot } from 'react-dom/client';
import { SignInRecoveryLine } from '../src/components/SignInRecoveryLine';
import '../src/index.css';

createRoot(document.getElementById('root')!).render(
    <div className="flex justify-center p-4 min-h-screen page-surface">
        <div className="max-w-3xl w-full mt-2">
            <div className="space-y-2.5">
                <div data-testid="case-one"><SignInRecoveryLine enrolled={['google']} /></div>
                <div data-testid="case-many"><SignInRecoveryLine enrolled={['google', 'facebook', 'github']} /></div>
                <div data-testid="case-none"><SignInRecoveryLine enrolled={[]} /></div>
            </div>
        </div>
    </div>,
);
