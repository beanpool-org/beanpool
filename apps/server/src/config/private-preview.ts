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
 *   invite, and the routes a node must answer (VISITOR_OPEN_ROUTES below, each with its reason), and a member's image
 *   at a URL carrying that image's own key (KEYED_IMAGE_ROUTES). Everything else under /api/ and every visitor's /ws
 *   socket is refused with the same sentence.
 * - Members sign in, recover (12 words, a sign-in) and use everything as usual.
 *
 * Nothing here needs our domain, registrar, DNS or tunnels: it is a setting of the node, read from its own env.
 */
import type { Context, Next } from 'koa';

export const PRIVATE_PREVIEW_ENV = 'PRIVATE_PREVIEW';
export const PRIVATE_PREVIEW = 'private_preview';
export const PRIVATE_PREVIEW_MESSAGE = 'This community is in a private preview. Ask its owner for an invite.';

/** The values that turn a private preview on, and the ones that leave it off (any case, trimmed; unset is off too). */
export const PRIVATE_PREVIEW_ON_VALUES: readonly string[] = ['1', 'true', 'yes', 'on'];
export const PRIVATE_PREVIEW_OFF_VALUES: readonly string[] = ['', '0', 'false', 'no', 'off'];

/** Whether this node is in a private preview: `PRIVATE_PREVIEW` is 1, true, yes or on (any case). Read every time. */
export function isPrivatePreview(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = (env[PRIVATE_PREVIEW_ENV] ?? '').trim().toLowerCase();
    return PRIVATE_PREVIEW_ON_VALUES.includes(raw);
}

/**
 * At boot (config/node-profile.ts mirrorNodeProfileAtBoot): a `PRIVATE_PREVIEW` that is neither an on value nor an off
 * value (`y`, `enabled`, `2`, a quoted `"1"` some env-file tools keep) stops the boot with a message naming the
 * accepted values. Not "off with a warning": an operator who meant ON and mistyped would get a node open to anyone, which
 * nobody sees until a stranger joins; a node that doesn't start is seen at once, in the deploy check, and fixed in the env.
 * Returns the line the boot log prints when the preview is on, else null.
 */
export function privatePreviewAtBoot(env: NodeJS.ProcessEnv = process.env): string | null {
    const raw = (env[PRIVATE_PREVIEW_ENV] ?? '').trim().toLowerCase();
    if (!PRIVATE_PREVIEW_ON_VALUES.includes(raw) && !PRIVATE_PREVIEW_OFF_VALUES.includes(raw)) {
        throw new Error(`${PRIVATE_PREVIEW_ENV}=${JSON.stringify(env[PRIVATE_PREVIEW_ENV])} is not a value this node knows, so it will not start `
            + `rather than guess whether you meant it closed. Set ${PRIVATE_PREVIEW_ENV}=1 (or true, yes, on) to turn the private preview `
            + `on, or 0 (or false, no, off, or leave it unset) to leave it off, with no quotes around the value.`);
    }
    return isPrivatePreview(env) ? PRIVATE_PREVIEW_BOOT_LINE : null;
}

export const PRIVATE_PREVIEW_BOOT_LINE = '🔒 Private preview: ON (only owner/admin invites join; visitors see nothing). The open door and members\' own invites are shut while it is on.';

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
    { path: /^\/api\/node\/config\/?$/, why: 'the phone map reads the community\'s service area unsigned (map.tsx): a non-member gets that area alone, no other setting (routes/settings.ts)' },
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

/**
 * The images the apps load unsigned (an `<img>`, expo-image: neither can sign), each served only to a URL carrying the
 * member-only key for that one image as it is now: a member's face (engine/avatar-keys.ts, keyed on every node in a
 * preview), a listing's or event's photo (engine/photo-keys.ts, every listing's keyed in a preview) and a group's picture
 * (keyed on every node). The node hands those URLs only to readers who may see them, and in a preview that is members
 * alone. So in a preview such a request passes the gates only with a key that is right for the image it names
 * (KeyedImageChecks, from https-server.ts); without one, or with another image's, it gets the preview's sentence like
 * any other visitor's read. Then the route checks the key again and serves the bytes. GET and HEAD only.
 * (A chat attachment is fetched signed by both apps, so a member's passes as any member's read does.)
 */
export interface KeyedImageChecks {
    avatar: (pubkey: string, k: unknown) => boolean;
    postPhoto: (postId: string, orderNum: number, k: unknown) => boolean;
    groupPicture: (groupId: string, k: unknown) => boolean;
}

export const KEYED_IMAGE_ROUTES: readonly { path: RegExp; why: string }[] = [
    { path: /^\/api\/avatar\/([^/]+)\/?$/, why: 'a member\'s face, with the key for that face (engine/avatar-keys.ts)' },
    { path: /^\/api\/marketplace\/posts\/([^/]+)\/photos\/([^/]+)\/?$/, why: 'a listing\'s or event\'s photo, with the key for that photo (engine/photo-keys.ts)' },
    { path: /^\/api\/groups\/([^/]+)\/picture\/?$/, why: 'a group\'s picture, with the key for that picture (engine/avatar-keys.ts)' },
];

function decoded(part: string): string | null {
    try { return decodeURIComponent(part); } catch { return null; }
}

/** Whether a request is for one of KEYED_IMAGE_ROUTES with a key that is right for the image it names. */
export function opensKeyedImage(method: string, rawPath: string, k: unknown, checks: KeyedImageChecks | undefined): boolean {
    if (!checks || (method !== 'GET' && method !== 'HEAD') || typeof k !== 'string') return false;
    let m = KEYED_IMAGE_ROUTES[0].path.exec(rawPath);
    if (m) { const pk = decoded(m[1]); return pk !== null && checks.avatar(pk, k); }
    m = KEYED_IMAGE_ROUTES[1].path.exec(rawPath);
    if (m) {
        const id = decoded(m[1]);
        const n = decoded(m[2]);
        return id !== null && n !== null && /^\d+$/.test(n) && checks.postPhoto(id, Number(n), k);
    }
    m = KEYED_IMAGE_ROUTES[2].path.exec(rawPath);
    if (m) { const id = decoded(m[1]); return id !== null && checks.groupPicture(id, k); }
    return false;
}

/** Whether a request on `path` is a join the private preview refuses. */
export function isRefusedJoin(path: string): boolean {
    return JOIN_ROUTES.some((re) => re.test(path));
}

/** Whether a non-member may reach `path` during a private preview. Only /api/ paths are asked. */
export function isVisitorOpenRoute(path: string): boolean {
    return VISITOR_OPEN_ROUTES.some((r) => r.path.test(path));
}

/**
 * Koa middleware, mounted BEFORE the signature middleware (https-server.ts): a join, and an unsigned request (which
 * can't be a member's), or one claiming a key that is no member here, to anything but the open routes, get the
 * preview's sentence rather than "missing signature" or "members only", so the apps show it as-is. It only ever
 * refuses on the claimed key, never admits on it: a request claiming a member's key goes on to be verified, and meets
 * privatePreviewGate below with the verified signer.
 */
export function privatePreviewEarlyGate(isMember: (pubkey: string | undefined) => boolean, images?: KeyedImageChecks) {
    return async function privatePreviewEarlyGateMiddleware(ctx: Context, next: Next): Promise<void> {
        if (!isPrivatePreview()) return next();
        const path = ctx.path.toLowerCase();
        if (!path.startsWith('/api/')) return next();
        const claimed = ctx.get('X-Public-Key').trim().toLowerCase();
        if (isRefusedJoin(path) || (!isVisitorOpenRoute(path) && (!claimed || !isMember(claimed))
            && !opensKeyedImage(ctx.method, ctx.path, ctx.query.k, images))) {
            ctx.status = 403;
            ctx.body = privatePreviewRefusal();
            return;
        }
        await next();
    };
}

/**
 * Koa middleware, mounted after the signature middleware (so `ctx.state.actor` is the verified signer) and before the
 * route modules (https-server.ts). `isMember` is the act test (state-engine isNodeMember): a suspended member is still
 * a member and signs in to see why.
 */
export function privatePreviewGate(isMember: (pubkey: string | undefined) => boolean, images?: KeyedImageChecks) {
    return async function privatePreviewGateMiddleware(ctx: Context, next: Next): Promise<void> {
        if (!isPrivatePreview()) return next();
        const path = ctx.path.toLowerCase();
        if (!path.startsWith('/api/')) return next();
        if (isRefusedJoin(path) || (!isMember(ctx.state.actor as string | undefined) && !isVisitorOpenRoute(path)
            && !opensKeyedImage(ctx.method, ctx.path, ctx.query.k, images))) {
            ctx.status = 403;
            ctx.body = privatePreviewRefusal();
            return;
        }
        await next();
    };
}
