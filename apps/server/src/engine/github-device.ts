import {
    createGithubDeviceFlow,
    type GithubPoll,
    type GithubSessionStart,
    type SsoIdentity,
} from '@beanpool/signin';
import { getConfiguredAudiences } from '../sso.js';

/**
 * GitHub sign-in, run BY THE NODE (design §2.4, sign-in hardening S2).
 *
 * The flow itself (asking GitHub for a device code, polling it, reading who signed in and dropping the
 * token, and the sessions bound to a subject) lives in @beanpool/signin (packages/beanpool-signin/src/
 * github-device.ts), shared with the key vault; its header has why the node runs it and what is kept.
 * This file is the node's one instance of it, started under the first GitHub client id this node
 * accepts, and the names the routes and tests import.
 */

export type { GithubPoll, GithubSessionStart } from '@beanpool/signin';

/**
 * Carried by every sign-in nonce answer as `githubFlow`, so an app can tell a node that runs the GitHub
 * sign-in itself from one that does not, and never sends a GitHub token to either.
 */
export const GITHUB_FLOW = 'node';

let clock: () => number = () => Date.now();

/** In memory, like the nonce map in sso.ts: a session outliving a restart buys nothing. */
const flow = createGithubDeviceFlow({ now: () => clock() });

/** Tests move time instead of waiting out GitHub's interval. Omit `fn` to put the real clock back. */
export function _setGithubDeviceClockForTests(fn?: () => number): void {
    clock = fn ?? (() => Date.now());
}

export function _clearGithubSessionsForTests(): void {
    flow.clear();
}

/** The session object itself, so a test can prove the access token is not reachable from it. */
export function _githubSessionForTests(sessionId: string): unknown {
    return flow.session(sessionId);
}

/**
 * Ask GitHub for a device code, bound to `subject`. The member types `userCode` at `verificationUri`.
 */
export async function startGithubSession(subject: string): Promise<GithubSessionStart> {
    return flow.start(subject, getConfiguredAudiences('github')[0]);
}

/**
 * Ask whether the member has finished at GitHub. Answers `pending` WITHOUT asking GitHub while the
 * interval since the last question has not passed, so a phone polling every second never earns
 * `slow_down` and cannot make this node hammer GitHub.
 */
export function pollGithubSession(sessionId: string, subject: string): Promise<GithubPoll> {
    return flow.poll(sessionId, subject);
}

/**
 * Spend a finished sign-in: once, by the subject it was started for, before it expires. A wrong subject
 * or an unfinished session is refused WITHOUT consuming it.
 */
export function consumeGithubSession(sessionId: string, subject: string): SsoIdentity {
    return flow.consume(sessionId, subject);
}
