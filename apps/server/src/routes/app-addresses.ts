/**
 * Settings → Network → "Addresses members' apps use" (request binding, engine/own-addresses.ts and
 * engine/member-signature.ts). Owners and admins; a moderator's session never reaches an admin route that is not on its
 * list (admin-auth.ts).
 *
 *   GET  /api/local/admin/app-addresses          this community's addresses, where each comes from (`former`: a
 *                                                 registrar name this key held before, accepted but not published), how many
 *                                                 people's apps signed for it today and on the busiest day of the last 7;
 *                                                 for a registrar name the address service no longer gives this community,
 *                                                 `standing` (services/registrar-name-watch.ts nameStandings: at risk and
 *                                                 still accepted, contradicted by its own key still answering there, or
 *                                                 `lost`); a lost one is marked `lost`, with how many members' apps were
 *                                                 refused there (`tried`);
 *                                                 whether any of them names the community (`named`: a loopback name
 *                                                 listed for an SSH tunnel doesn't); on a node that knows none of its
 *                                                 names, the addresses apps reached it at, each with its count and
 *                                                 whether an owner's or admin's app did: `unconfirmed`, offered to
 *                                                 confirm with one tap, which is only ever the host Settings is open at
 *                                                 (`?host=`, on all three), and `heldBack`, every other one, each with
 *                                                 its reason (engine/address-offers.ts; a Settings from before that
 *                                                 shows `unconfirmed` only, so it never offers a held-back one); how
 *                                                 many signed in the old format (apps too old to name a community); the
 *                                                 switch date; where the community lives now (`primaryAddress`, as
 *                                                 /api/community/info says it); and how many members' apps signed for any
 *                                                 of its former names, today and on the busiest day of the last 7
 *                                                 (`formerApps`, lost-name L4: the members still to move).
 *   POST /api/local/admin/app-addresses/confirm  { address }: "Yes, that's its address." Adds it to the owner-confirmed
 *                                                 list (node_config.ownerAddresses, carried in the take-over envelope).
 *                                                 A lost name is refused (409, with why): confirming it would not bring it
 *                                                 back, since the mark is per host, whatever lists it.
 *   POST /api/local/admin/app-addresses/remove   { address }: takes an owner-confirmed address off the list again.
 *
 * An address is only ever added by an owner or admin here, or by config the operator set (the registrar's name,
 * CF_RECORD_NAME, BEANPOOL_ADDRESSES). Never from a request's Host header.
 */

import Router from '@koa/router';
import { updateNodeConfig } from '../state-engine.js';
import {
    configuredAddresses, forgetOwnAddresses, isLostAddress, knowsItsNames, normalizeAddress, ownerConfirmedAddresses,
    primaryAddress,
} from '../engine/own-addresses.js';
import { registrarNames } from '../engine/registrar-names.js';
import { nameStandings } from '../services/registrar-name-watch.js';
import {
    ownAddressesUsage, signatureUsage, staffSeenAddresses, unboundSignaturesAccepted, unboundSignaturesUntilDay,
} from '../engine/member-signature.js';
import { offerablePageHost, offerStanding, type AddressSighting, type HeldBackReason } from '../engine/address-offers.js';
import { logger } from '../logger.js';
import type { RouteDeps } from './types.js';

/** More than any real community needs; a bound on what one Settings session can write. */
export const MAX_OWNER_ADDRESSES = 20;

/**
 * `pageHost` is the host Settings is open at (`?host=`): the only host offered with one tap (engine/address-offers.ts),
 * with its counts, or none when no app reached the node there yet. Every other host apps reached is held back with its
 * counts and reason. The page's host is held back too when the directory this node holds lists it (4114569450), and is
 * on neither list when it is a beanpool.org name, this machine or its network, or already one of this node's names.
 */
export function appAddressesReport(pageHost?: unknown) {
    const usage = signatureUsage();
    const count = (kind: string, address: string) => usage.find((u) => u.kind === kind && u.address === address);
    const standings = nameStandings();
    const addresses = configuredAddresses().map((a) => {
        const u = count('own', a.address);
        const tried = a.lost ? count('lost', a.address) : undefined;
        const standing = standings.get(a.address);
        return {
            address: a.address, source: a.source, ...(a.former ? { former: true } : {}), today: u?.today ?? 0, busiestDay: u?.busiestDay ?? 0,
            ...(a.lost ? { lost: true, tried: { today: tried?.today ?? 0, busiestDay: tried?.busiestDay ?? 0 } } : {}),
            ...(standing ? { standing } : {}),
        };
    });
    // Hosts apps signed for while this node knew none of its names (accepted until the switch). Any the owner has since
    // confirmed drop off both lists, as they are on the one above.
    const known = new Set(addresses.map((a) => a.address));
    const staff = staffSeenAddresses();
    const page = offerablePageHost(pageHost);
    const unconfirmed: AddressSighting[] = [];
    const heldBack: (AddressSighting & { reason: HeldBackReason; directory?: { name: string | null } })[] = [];
    const place = (sighting: AddressSighting) => {
        const standing = offerStanding(sighting.address, page);
        if (standing.offer) unconfirmed.push(sighting);
        else heldBack.push({ ...sighting, reason: standing.reason, ...(standing.directory ? { directory: standing.directory } : {}) });
    };
    for (const u of usage) {
        if (u.kind !== 'unconfirmed' || known.has(u.address)) continue;
        place({ address: u.address, today: u.today, busiestDay: u.busiestDay, ownerOrAdmin: staff.has(u.address) });
    }
    // The page's host when no app has reached the node there yet this week.
    if (page && ![...unconfirmed, ...heldBack].some((u) => u.address === page)) {
        place({ address: page, today: 0, busiestDay: 0, ownerOrAdmin: staff.has(page) });
    }
    const old = count('old_app', '');
    return {
        primaryAddress: primaryAddress(),
        formerApps: ownAddressesUsage(addresses.filter((a) => a.former).map((a) => a.address)),
        addresses,
        named: knowsItsNames(),
        unconfirmed,
        heldBack,
        oldApps: { today: old?.today ?? 0, busiestDay: old?.busiestDay ?? 0 },
        unboundSignaturesUntil: unboundSignaturesUntilDay(),
        unboundSignaturesAccepted: unboundSignaturesAccepted(),
    };
}

export function createAppAddressesRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { checkAdminAuth } = deps;
    const bodyOf = (ctx: any) => (ctx as any).requestBody || (ctx.request as any)?.body || {};

    router.get('/api/local/admin/app-addresses', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        ctx.set('Cache-Control', 'no-store');
        ctx.body = appAddressesReport(ctx.query.host);
    });

    router.post('/api/local/admin/app-addresses/confirm', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const address = normalizeAddress(bodyOf(ctx).address);
        if (!address) {
            ctx.status = 400;
            ctx.body = { error: 'Send { "address": "community.example.org" }: a web address, with no path.' };
            return;
        }
        if (isLostAddress(address)) {
            const why = registrarNames().find((e) => e.address === address)?.lost?.why;
            ctx.status = 409;
            ctx.body = {
                code: 'lost_address',
                error: why === 'released'
                    ? `${address} was this community's name until it released it, and the hold is over. It can't be confirmed; claim it again, or choose another address.`
                    : `Another community holds ${address} and answers there, so this community refuses what apps sign for it. It can't be confirmed; choose another address.`,
            };
            return;
        }
        const current = ownerConfirmedAddresses();
        if (!current.includes(address)) {
            if (current.length >= MAX_OWNER_ADDRESSES) {
                ctx.status = 409;
                ctx.body = { error: `This community already has ${MAX_OWNER_ADDRESSES} confirmed addresses. Remove one you no longer use first.` };
                return;
            }
            updateNodeConfig({ ownerAddresses: [...current, address] });
            forgetOwnAddresses();
            logger.security('AUTH', `App address confirmed in Settings by ${(ctx.state as any)?.actor || 'the admin password'}: ${address}`);
        }
        ctx.set('Cache-Control', 'no-store');
        ctx.body = appAddressesReport(ctx.query.host);
    });

    router.post('/api/local/admin/app-addresses/remove', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const address = normalizeAddress(bodyOf(ctx).address);
        // The list as this node reads it (and Settings shows it), not as stored: a take-over envelope stores the
        // primary's list as it came, and an address accepted as this community's must be one Settings can remove.
        const current = ownerConfirmedAddresses();
        if (!address || !current.includes(address)) {
            ctx.status = 404;
            ctx.body = { error: 'That address is not one confirmed in Settings. Addresses from the registrar or the server’s own settings are changed there.' };
            return;
        }
        updateNodeConfig({ ownerAddresses: current.filter((a) => a !== address) });
        forgetOwnAddresses();
        logger.security('AUTH', `App address removed in Settings by ${(ctx.state as any)?.actor || 'the admin password'}: ${address}`);
        ctx.set('Cache-Control', 'no-store');
        ctx.body = appAddressesReport(ctx.query.host);
    });

    return router;
}
