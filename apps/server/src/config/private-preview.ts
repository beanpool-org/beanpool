/**
 * Private preview: a node closed to everyone but its own members and the people its owner or an admin invites
 * (Marty, 2026-10-05: the global node drops its Cloudflare Access lock, which the phone apps can't pass, and stays
 * closed until he and Damo have tried it). One env setting, `PRIVATE_PREVIEW=1`, default off. Off, nothing here runs
 * and every node behaves exactly as before.
 *
 * On:
 * - Every NEW join that isn't by an invite an owner or admin of this node made is refused with one sentence
 *   (PRIVATE_PREVIEW_MESSAGE, 403 `private_preview`): the open door (12 words and sign-in), "ask to join", the old
 *   register route, and a member's own code or offline ticket. The door is `admins` (config/door.ts getDoor), so only
 *   an owner or admin makes an invite, and invites are on even where the profile has none (the global node:
 *   config/node-profile.ts). A code redeems only while its maker is an owner or admin here (engine/invites.ts).
 * - A reader who is not a member here gets nothing but what an app needs to say so, sign a member in, redeem an
 *   invite, and the routes a node must answer (VISITOR_OPEN_ROUTES below, each with its reason). Everything else under
 *   /api/ and every visitor's /ws socket is refused with the same sentence.
 * - Members sign in, recover (12 words, a sign-in) and use everything as usual.
 *
 * Nothing here needs our domain, registrar, DNS or tunnels: it is a setting of the node, read from its own env.
 */
import type { Context, Next } from 'koa';

export const PRIVATE_PREVIEW_ENV = 'PRIVATE_PREVIEW';
export const PRIVATE_PREVIEW = 'private_preview';
export const PRIVATE_PREVIEW_MESSAGE = 'This community is in a private preview. Ask its owner for an invite.';

/** Whether this node is in a private preview: `PRIVATE_PREVIEW` is 1, true, yes or on (any case). Read every time. */
export function isPrivatePreview(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = (env[PRIVATE_PREVIEW_ENV] ?? '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export class PrivatePreviewError extends Error {
    readonly code = PRIVATE_PREVIEW;
    readonly status = 403;
    constructor() {
        super(PRIVATE_PREVIEW_MESSAGE);
        this.name = 'PrivatePreviewError';
    }
}

/** The body every refusal carries, word for word what the apps show. */
export function privatePreviewRefusal(): { error: string; code: string } {
    return { error: PRIVATE_PREVIEW_MESSAGE, code: PRIVATE_PREVIEW };
}

/**
 * Joins refused outright, to anyone, member-signed or not: none of them is an owner's or admin's invite.
 * - The open door: its work, its sign-in nonce and the join itself (routes/open-join.ts). Not `/api/join/link*`,
 *   where an existing member adds a sign-in to their own account.
 * - "Ask to join" (routes/knocks.ts): a knock is answered with a member's invite.
 * - The old register route (routes/community.ts), which makes a member with no invite at all.
 */
export const JOIN_ROUTES: readonly RegExp[] = [
    /^\/api\/join\/?$/,
    /^\/api\/join\/(work|sso-nonce)\/?$/,
    /^\/api\/join\/knocks?(\/|$)/,
    /^\/api\/community\/register\/?$/,
];

/**
 * What a reader who is not a member here may still reach under /api/, and why. Everything else is refused.
 */
export const VISITOR_OPEN_ROUTES: readonly { path: RegExp; why: string }[] = [
    { path: /^\/api\/community\/info\/?$/, why: 'the node\'s public info: the apps read `privatePreview` here to show the message and hide the doors' },
    { path: /^\/api\/version\/?$/, why: 'the build a node runs, which the apps and the Manager check' },
    { path: /^\/api\/node\/info\/?$/, why: 'the node\'s identity, read by the apps and by peers before anything else' },
    { path: /^\/api\/attest\/?$/, why: 'the registrar\'s check that this server holds its node key (the address must never be lost)' },
    { path: /^\/api\/federation\/verify-member\/?$/, why: 'federation handshake: a peer asks whether a key is a member here, signed by the peer' },
    { path: /^\/api\/invite\/(redeem|redeem-offline|check)\/?$/, why: 'redeeming an owner\'s or admin\'s invite (a member\'s is refused in the engine)' },
    { path: /^\/api\/member\/re-enroll\/?$/, why: 'a member moving to a new key signs with the key it binds, not yet a member' },
    { path: /^\/api\/recovery\/(sso-nonce|collect)(\/|$)/, why: 'recovery by a sign-in: the recovering device signs with a fresh key' },
    { path: /^\/api\/pair\//, why: 'pairing a member\'s new device: its own one-time code' },
    { path: /^\/api\/(local|admin|node-admin)\//, why: 'the operator surface (Manager, claim code, break-glass): its own password, claim or node-role auth' },
    { path: /^\/api\/push-tokens\/leave\//, why: 'a leaving phone removes its own push token, signed inside the body' },
];

/** Whether a request on `path` is a join the private preview refuses. */
export function isRefusedJoin(path: string): boolean {
    return JOIN_ROUTES.some((re) => re.test(path));
}

/** Whether a non-member may reach `path` during a private preview. Only /api/ paths are asked. */
export function isVisitorOpenRoute(path: string): boolean {
    return VISITOR_OPEN_ROUTES.some((r) => r.path.test(path));
}

/**
 * Koa middleware, mounted after the signature middleware (so `ctx.state.actor` is the verified signer) and before the
 * route modules (https-server.ts). `isMember` is the act test (state-engine isNodeMember): a suspended member is still
 * a member and signs in to see why.
 */
export function privatePreviewGate(isMember: (pubkey: string | undefined) => boolean) {
    return async function privatePreviewGateMiddleware(ctx: Context, next: Next): Promise<void> {
        if (!isPrivatePreview()) return next();
        const path = ctx.path.toLowerCase();
        if (!path.startsWith('/api/')) return next();
        if (isRefusedJoin(path) || (!isMember(ctx.state.actor as string | undefined) && !isVisitorOpenRoute(path))) {
            ctx.status = 403;
            ctx.body = privatePreviewRefusal();
            return;
        }
        await next();
    };
}
