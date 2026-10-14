/**
 * "Your events" and per-event reminders (docs/events-on-the-map.md §2.2).
 *
 *   GET /api/events/mine                  — the signer's own RSVPs, soonest first
 *   PUT /api/events/:postId/reminder      — the signer's reminders for one event
 *   GET /api/events/zone?lat=&lng=        — the time zone of a pin, for the event form (DESIGN-event-times §2)
 *   GET /api/events/zones                 — every zone this node accepts, for the form's picker
 *
 * Both are the SIGNER's and nobody else's. The member is `ctx.state.actor`, which only the signature
 * middleware sets, and never a field in the body or the query — the same rule the RSVP route already keeps
 * ("nobody RSVPs for someone else"), and the reason there is no `publicKey` parameter here to get wrong.
 *
 * The per-event write additionally needs an RSVP: a reminder for an event you have not said you are going
 * to is not a thing, and the check is 403 rather than 404 because whether the event exists is not a secret.
 */

import Router from '@koa/router';
import {
    listMyEvents, setEventReminderOffsets, parseReminderOffsets,
    NO_RSVP_MESSAGE, BAD_OFFSETS_MESSAGE,
} from '../state-engine.js';
import type { RouteDeps } from './types.js';
import { zoneOfPin, describeZone, acceptedZones } from '../engine/event-zone.js';

export function createEventsRoutes(_deps: RouteDeps): Router {
    const router = new Router();

    /**
     * GET /api/events/zone?lat=&lng=  → { tz, label, offsetMinutes }
     *
     * The zone an in-person event's clock belongs to, looked up offline from the pin (engine/event-zone.ts), with its
     * words ("Lagos time") and its offset now. The form shows it, with the picker one tap away; the node does the
     * same lookup at create/edit only when the app sends no zone. A signed read like every member read: the form is
     * only ever open to a member.
     */
    router.get('/api/events/zone', async (ctx) => {
        const rawLat = ctx.query.lat;
        const rawLng = ctx.query.lng;
        const tz = typeof rawLat === 'string' && typeof rawLng === 'string' && rawLat && rawLng ? zoneOfPin(Number(rawLat), Number(rawLng)) : null;
        if (!tz) {
            ctx.status = 400;
            ctx.body = { error: 'lat and lng must be a point on the map' };
            return;
        }
        ctx.body = describeZone(tz);
    });

    /**
     * GET /api/events/zones  → { zones: [{ tz, label, offsetMinutes }] }
     *
     * Served rather than bundled, so the list is exactly what this node accepts (an app on Hermes has no
     * Intl.supportedValuesOf). ETag-cached; rebuilt hourly as offsets move with DST.
     */
    router.get('/api/events/zones', async (ctx) => {
        const { zones, etag } = acceptedZones();
        ctx.set('ETag', etag);
        ctx.set('Cache-Control', 'private, max-age=3600');
        // A compressed answer goes out with the tag made weak (W/), and comes back that way.
        const inm = ctx.get('If-None-Match');
        if (inm && inm.split(',').some(t => t.trim().replace(/^W\//, '') === etag)) {
            ctx.status = 304;
            return;
        }
        ctx.body = { zones };
    });

    /**
     * GET /api/events/mine
     *
     * NOT on the public-read allowlist and not meant to be: it is one member's calendar. When
     * ENFORCE_READ_AUTH is off the middleware lets an unsigned GET through with no actor, so the 401 below
     * is the gate in that case, not a formality.
     */
    router.get('/api/events/mine', async (ctx) => {
        const actor = ctx.state?.actor as string | undefined;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'A signed request is required' };
            return;
        }
        ctx.body = { events: listMyEvents(actor) };
    });

    /**
     * PUT /api/events/:postId/reminder   body `{ offsets: number[] | null }`
     *
     * `null` puts the event back on the member's Settings default; `[]` turns reminders off for this one.
     * An offset outside the five the picker offers is a 400 — the set is closed on purpose, so a client
     * bug shows up here rather than as a reminder nobody expected.
     */
    router.put('/api/events/:postId/reminder', async (ctx) => {
        const actor = ctx.state?.actor as string | undefined;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'A signed request is required' };
            return;
        }
        const body = (ctx as any).requestBody || {};
        if (!Object.prototype.hasOwnProperty.call(body, 'offsets')) {
            ctx.status = 400;
            ctx.body = { error: 'offsets is required — an array of minutes, or null for your default' };
            return;
        }
        let offsets: number[] | null;
        try {
            offsets = parseReminderOffsets(body.offsets);
        } catch {
            ctx.status = 400;
            ctx.body = { error: BAD_OFFSETS_MESSAGE };
            return;
        }
        try {
            const saved = setEventReminderOffsets(ctx.params.postId, actor, offsets);
            ctx.body = { success: true, reminderOffsets: saved.offsets };
        } catch (e: any) {
            const msg = e?.message || 'Could not save that reminder';
            ctx.status = msg === NO_RSVP_MESSAGE ? 403 : 400;
            ctx.body = { error: msg };
        }
    });

    return router;
}
