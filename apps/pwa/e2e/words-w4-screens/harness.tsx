/**
 * The screens of web sweep W4 (joining, restoring, a re-key code, an owner's unlock, recovery, the Invites page), one per
 * `?screen=`, drawn by the app's own components and stylesheet in the language of `?lang=` (the pseudo-locale for the
 * 320 px check). Served by Vite's dev server for e2e/words-w4-screens-check.mjs, which answers /api itself; nothing here
 * talks to a node, and every key here is made in this page for it.
 */
import '../../src/index.css';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { UiLang } from '@beanpool/core';
import { showLanguage } from '../../src/lib/language';
import { createIdentity, generateIdentity, savePendingJoin, PENDING_JOIN_TTL_MS, type BeanPoolIdentity } from '../../src/lib/identity';
import { readAuthReturn } from '../../src/lib/web-join';
import { lockPinKey } from '../../src/lib/takeover-unlock';
import type { WebRekeyDeps } from '../../src/lib/web-rekey';
import { WebJoin } from '../../src/components/WebJoin';
import { WebRestore } from '../../src/components/WebRestore';
import { WebRekey } from '../../src/components/WebRekey';
import { AddSignIn, OneWayBackCard } from '../../src/components/OneWayBack';
import { OwnerUnlockCard } from '../../src/components/OwnerUnlockCard';
import { RecoveryAlertBanner } from '../../src/components/RecoveryAlertBanner';
import { SignInRecoveryLine } from '../../src/components/SignInRecoveryLine';
import { OwnerWordsCheck } from '../../src/components/OwnerWordsCheck';
import { OwnerWordsPrompt } from '../../src/components/OwnerWordsPrompt';
import { RecoveryKitButton } from '../../src/components/RecoveryKitButton';
import { InvitePage } from '../../src/pages/InvitePage';

const WORDS = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];
export const NONCE = 'node-nonce-1';
const noop = () => {};
const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const googleReturn = () => readAuthReturn('/app/auth/google', `#state=${NONCE}&id_token=${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify({ sub: 'g1', nonce: NONCE }))}.c2ln`);
const cancelledReturn = () => readAuthReturn('/app/auth/google', `#state=${NONCE}&error=access_denied`);

/** A screen at the width of the phone, in the page's own padding, as WelcomePage and Settings draw these. */
const Page = ({ children }: { children: ReactNode }) => <div className="min-h-screen bg-white dark:bg-nature-950 p-4">{children}</div>;

const join = (props: Partial<React.ComponentProps<typeof WebJoin>> = {}) => (
    <Page><WebJoin onJoined={noop} onRestore={noop} navigate={noop} origin={location.origin} authReturn={null} onLobby={noop} {...props} /></Page>
);

/** A re-key ask the node answers with `answer`; the signature is not made (no node reads it here). */
function rekeyDeps(answer: unknown): WebRekeyDeps {
    return {
        loadIdentity: async () => null,
        loadPendingJoin: async () => null,
        markPendingJoinSent: async (p: object, at: number) => ({ ...p, sentAt: at }),
        completePendingJoin: async () => {},
        releaseSentPendingJoin: async () => ({ released: true, pending: null }),
        signReEnrollAsk: async () => ({ signature: 's', signedFor: 'f' }),
        signedFetchWithKey: async () => new Response(JSON.stringify(answer), { status: 200 }),
    } as unknown as WebRekeyDeps;
}

let me: BeanPoolIdentity;

const SCREENS: Record<string, () => ReactNode> = {
    'join-lobby': () => join(),
    'join-guard': () => join({ start: 'guard' }),
    'join-restore': () => join({ start: 'restore' }),
    'join-sign-in': () => join({ start: 'guard' }),
    'join-doors': () => join({ start: 'guard', wordsDoor: true, solveWork: () => ({ done: new Promise(() => {}), cancel: noop }) }),
    'join-cancelled': () => join({ authReturn: cancelledReturn() }),
    'join-limited': () => join({ authReturn: googleReturn() }),
    'join-already': () => join({ authReturn: googleReturn() }),
    'join-unknown': () => join({ authReturn: googleReturn() }),
    'restore-name': () => <Page><WebRestore onRestored={async () => true} onHeld={noop} onExisting={noop} onBack={noop} onOtherWay={noop} navigate={noop} origin={location.origin} authReturn={null} /></Page>,
    'restore-sign-in': () => <Page><WebRestore onRestored={async () => true} onHeld={noop} onExisting={noop} onBack={noop} onOtherWay={noop} navigate={noop} origin={location.origin} authReturn={null} /></Page>,
    'rekey-form': () => <Page><WebRekey initialCode="RK-12" onBound={noop} onBack={noop} deps={rekeyDeps({})} /></Page>,
    'rekey-waiting': () => <Page><WebRekey initialCode="RK-AB12-CD34" onBound={noop} onBack={noop} deps={rekeyDeps({ state: 'waiting', match: '42' })} /></Page>,
    'add-sign-in': () => <Page><AddSignIn identity={me} navigate={noop} origin={location.origin} /></Page>,
    'one-way-back': () => <Page><OneWayBackCard identity={me} placement="landing" onSeeWords={noop} result={{ kind: 'linked', provider: 'facebook', recoveryStored: false }} /></Page>,
    'owner-unlock': () => <Page><OwnerUnlockCard identity={me} communityName="Riverbend" /></Page>,
    'recovery-alert': () => <Page><RecoveryAlertBanner /></Page>,
    'signin-recovery': () => <Page><SignInRecoveryLine enrolled={['google', 'apple', 'facebook']} hasWords={false} /><div className="h-3" /><SignInRecoveryLine enrolled={[]} hasWords={false} /></Page>,
    'owner-words': () => <Page><OwnerWordsCheck identity={me} startOpen hasWords={false} /></Page>,
    'owner-prompt': () => <Page><OwnerWordsPrompt publicKey={me.publicKey} onCheckNow={noop} /></Page>,
    'recovery-kit': () => <Page><RecoveryKitButton words={WORDS} print={noop} /></Page>,
    'invites': () => <InvitePage identity={me} />,
    'invites-admins': () => <InvitePage identity={me} />,
};

async function main() {
    const params = new URLSearchParams(location.search);
    const name = params.get('screen') ?? 'join-lobby';
    const lang = (params.get('lang') ?? 'xx') as UiLang;
    await showLanguage(lang);
    // A member's screens: an account in this browser, as after a join. The join's screens: a join left waiting for its
    // sign-in to come back, with this page's own key, and no account yet.
    if (name.startsWith('join-')) {
        if (/^join-(cancelled|limited|already|unknown)$/.test(name)) {
            const now = Date.now();
            await savePendingJoin({ identity: await generateIdentity('Alice'), provider: 'google', nonce: NONCE, startedAt: now, expiresAt: now + PENDING_JOIN_TTL_MS, restored: false });
        }
    } else if (!name.startsWith('restore-') && !name.startsWith('rekey-')) {
        me = await createIdentity('Alice');
        // This browser knows it is an owner (the silent open check remembers it): the unlock card shows.
        localStorage.setItem(lockPinKey(me.publicKey), JSON.stringify({ communityId: 'c0ffee0000000003', nodePeerId: 'peer', lastEnvelopeId: null, owner: true }));
    }
    const draw = SCREENS[name];
    const root = document.getElementById('root')!;
    if (!draw) { root.textContent = `No screen ${name}`; return; }
    createRoot(root).render(draw());
    document.body.dataset.ready = 'true';
}

void main();
