// Beanpool node-address registrar — Cloudflare Worker.
//   fetch:     claim / heal / rotate / status / release / holder (signed by node key) + admin approve/pause/resume/block/
//              release + switchboard
//   scheduled: attestation sweep — pauses a live name's routing only on proof that something other than its own node
//              answers at it (ANOTHER node key, or for about an hour a page that is no attest at all), never on anything
//              the registrar merely can't verify, and never when the sweep as a whole looks wrong; then upkeep: a live name nothing answers at whose routing Cloudflare lost is repaired, a claim whose provisioning never finished is finished, and deletions
//              Cloudflare refused earlier (migrations/0004_teardown.sql) are retried. Beside it, the outside checks of
//              our own servers (src/watch.js: WATCH_TARGETS) and the daily line to the admin's phone.
// A name belongs to the node key that claimed it; the registrar can stop routing it but never hands it to another
// key. It frees only when its owner releases it (after a 30-day hold for that key), when the admin releases it (the
// same hold, unless the admin frees it now; a name the admin blocked or paused is held from every key, its own
// included), or (a later PR) after a long, warned abandonment. States: migrations/0002_states.sql, and releaseRow
// below for why a release holds.
// Design: scratch/registrar/DESIGN-2026-09-24-fable.md, docs/node-dns-registrar.md. CF calls: src/cf.js.

import * as cf from './cf.js';
import * as db from './db.js';
import { verifySignedRequest, signedQuery, verifyEd25519, requestProto, requestNonce, protoOf, PROTOCOLS, attestMessage, ACCEPTED_PROTOS, CLOCK_SKEW_S } from './sign.js';
import { ADMIN_HTML } from './admin-html.js';
import * as alerts from './alerts.js';
import * as settings from './settings.js';
import { accessMode, accessIdentity } from './access.js';
import { watchOurServers, serversStatus, watchTargets, WATCH_CRON } from './watch.js';

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/; // 3–32, no leading/trailing hyphen
const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
// A signed request that doesn't verify. accepted_proto lets a node that signed under a protocol this Worker doesn't
// speak retry once under one it does (design §3.3, §5.1).
const badSignature = () => json({ error: 'bad signature', accepted_proto: ACCEPTED_PROTOS }, 401);
const nowS = () => Math.floor(Date.now() / 1000);

// The protocols this Worker can serve right now: all of them while D1 has the nonce table (migration 0006), and without
// it only those that sign no nonce. Checked against D1 at most once a minute per isolate: /health and the 401s answer it.
const nonceTable = new WeakMap();   // env.DB -> { at, ok }
async function nonceTableExists(env) {
    if (!env.DB) return true;   // no database to ask (a unit test of /health): nothing to say against v2
    const seen = nonceTable.get(env.DB);
    if (seen && Date.now() - seen.at < 60_000) return seen.ok;
    let ok = true;
    try { await env.DB.prepare('SELECT 1 FROM request_nonces LIMIT 0').run(); } catch { ok = false; }
    nonceTable.set(env.DB, { at: Date.now(), ok });
    return ok;
}
const protosWithoutNonce = () => ACCEPTED_PROTOS.filter((p) => !PROTOCOLS[p].nonce);
const acceptedProtos = async (env) => ((await nonceTableExists(env)) ? ACCEPTED_PROTOS : protosWithoutNonce());

// The key that signed a request, or the Response refusing it: a bad signature, or — under a protocol that signs a
// nonce (v2) — a nonce this key has sent before: a request the Worker already took, replayed. The nonce is taken
// before the request does anything. A v1 request signs none, and still verifies until its timestamp is too old
// (sign.js): v1 is accepted until every node sends v2.
async function signer(request, env, bodyText) {
    const pubkey = await verifySignedRequest(request, bodyText);
    if (!pubkey) return badSignature();
    const n = requestNonce(request);
    if (n) {
        let taken;
        try { taken = await db.takeNonce(env, pubkey, n.nonce, n.ts); }
        catch (e) {
            // A Worker deployed before migration 0006 has no nonce table. The v2 request can't be recorded, so it is
            // not served; the node reads the accepted_proto, signs the same request under v1 (no nonce), and works.
            console.error('[NONCE_TABLE]', e.message || e);
            return json({ error: 'bad signature', accepted_proto: protosWithoutNonce() }, 401);
        }
        if (!taken) return json({ error: 'request already used' }, 401);
    }
    return pubkey;
}

// Why a request failed stays in the Worker's log, under a short reference the answer carries: a Cloudflare error
// names the account and the zone, and its body is Cloudflare's (L4 of the 2026-10-01 review).
const errorRef = () => crypto.randomUUID().slice(0, 8);
const DEFAULT_ORIGIN = 'http://beanpool-node:8080';
const key16 = (pubkey) => `${String(pubkey).slice(0, 16)}…`;

// --- Ownership ---
// How long an owner-released name is held for the same key before any key may claim it (design D3: 30 days).
export function releaseCooloffS(env) {
    const n = parseInt(env.RELEASE_COOLOFF_S, 10);
    return Number.isFinite(n) && n >= 0 ? n : 30 * 86400;
}

// A released row that holds nothing, not even for its old key: the admin's release with "free now" (and every admin
// release before decision D-C), or a gated claim the admin never approved, withdrawn by its key or rejected by the
// admin (the name was never that key's to hold). The admin's default release ('admin-held') holds, as its owner's does.
const freedAtOnce = (row) => row.status === 'released' && (row.pause_reason === 'admin' || row.pause_reason === 'withdrawn');

// The admin's default release of a name it had taken from its key — blocked, or paused by the admin: held from EVERY
// key, that one included ('admin-held-all'), then free. Block's promise (its node can neither heal nor release it) and
// the admin's pause (only the admin lifts it) hold through a release: the key the admin stopped never takes the name
// back (r4117740868). Past the hold it is free, to that key as to anyone — a new claimant, so a gated name waits for
// approval again.
const heldFromAll = (row) => row?.status === 'released' && row.pause_reason === 'admin-held-all';
const stoppedByAdmin = (row) => row.status === 'blocked' || (row.status === 'paused' && row.pause_reason === 'admin');

// The key the admin stopped, asking for the name the admin's release still holds from it: refused as a block is.
const blockedOut = (env, row, pubkey, now) => heldFromAll(row) && row.node_pubkey === pubkey && holdsName(env, row, now);

// Does `row` keep its name from every key but its owner's? Only three things let a name go: its owner's release
// once the hold is over (at once for a claim nobody approved), the admin's release (the same hold — from its owner too
// when the admin had blocked or paused it — or at once with "free now"), and abandonment. Every other state —
// including one this code does not know, like a legacy 'revoked' row — holds the name.
export function holdsName(env, row, now = nowS()) {
    if (!row || row.status === 'abandoned') return false;
    if (row.status === 'released') {
        if (freedAtOnce(row)) return false;
        return now - (row.released_at || 0) < releaseCooloffS(env);
    }
    return true;
}

// Is `row` the claimant's own name, to heal or take back? Not once it is abandoned or freed at once, nor once the admin
// released it from a block or its own pause (held from every key): then the old key is just another claimant.
export const isOwnRow = (row, pubkey) =>
    !!row && row.node_pubkey === pubkey && row.status !== 'abandoned' && !freedAtOnce(row) && !heldFromAll(row);

// A claim still waiting for the admin: pending, on a name that is not auto-approved, or held for approval although it is
// (held_reason: over a limit, the admin's hold switch, the DNS zone near full — claimGate). (Any other pending auto name
// is one whose provisioning has not finished — Cloudflare failed, or its Worker was cut off — and nobody's approval is
// awaited: its next claim or heal finishes it, and so does the sweep, finishOrphans.)
const awaitingApproval = async (env, a) => a.status === 'pending' && (!!a.held_reason || (await db.policyTier(env, a.name)) !== 'auto');

// On probation (migration 0011, design §4.3.2): a live name that has not yet answered as its own node in enough sweeps in
// a row, for long enough (settings probation_sweeps, probation_s). Routed, but off the switchboard (/i/), its node told
// `probation: true` (its directory listing waits), and its "New community" alert waits for its verification (applyVerdict).
// Only NULL is probation: a row read from a database without the column (undefined) is never held back by it.
const onProbation = (a) => !!a && a.verified_at === null;

// Why a row is in its state, as its node is told: a pause's or release's reason, and for a pending row whether it waits
// for the admin ('awaiting-approval') or is an auto name still being made ('provisioning': the node asks again, never
// waits for an approval nobody will give — scratch/global-node/DESIGN-registrar-trust-fable.md §5).
const reasonOf = async (env, a) => a.pause_reason
    || (a.status === 'pending' ? ((await awaitingApproval(env, a)) ? 'awaiting-approval' : 'provisioning') : null);
const sinceOf = (a) => ({ paused: a.paused_at, blocked: a.paused_at, released: a.released_at, pending: a.requested_at })[a.status] ?? null;

// The audit trail must not undo what it records: a failed write is logged, never thrown.
async function logEvent(env, name, event, detail) {
    try { await db.insertEvent(env, name, event, detail); }
    catch (e) { console.error('[NAME_EVENT]', name, event, e.message || e); }
}

// The admin's phone hears of it too (src/alerts.js, design §2.2): `make` builds the message — a name, its community
// name and counts, never its contact — or null when there is nothing to tell. Like logEvent, it never undoes what it
// reports.
async function tell(env, make) {
    try { const ev = await make(); if (ev) await alerts.notify(env, ev); }
    catch (e) { console.error('[ALERT]', e.message || e); }
}

// --- Cloudflare resources ---
const dnsTarget = (a) => a.mode === 'direct'
    ? { type: 'A', content: a.public_ip, proxied: true }
    : { type: 'CNAME', content: `${a.tunnel_id}.cfargotunnel.com`, proxied: true };

// Make Cloudflare route `a`, idempotently (design §2.5): keep the tunnel if Cloudflare still has it, re-PUT the
// ingress, and find the DNS record by name — keep it, PATCH it if it points elsewhere, POST only if there is none
// (or the record is the wrong type for the mode, which Cloudflare can't PATCH: then it is replaced).
// Never deprovisions first. Returns the ids and what had to be (re)made: changed ⊆ ['tunnel', 'dns']; a new tunnel
// means a new token. Throws on a Cloudflare failure, having written nothing to the row and removed any tunnel it made.
// The record is found by hostname, so once the row has changed it may be another tenure's, or another request's of
// this one: it is changed only while the row is still `expected` (the row as the caller read or last wrote it, ids
// and target included); otherwise ensure throws `raced`, having changed no record.
async function ensure(env, a, expected) {
    const changed = [];
    let tunnel_id = null;
    if (a.mode === 'tunnel') {
        if (a.tunnel_id && await cf.getTunnel(env, a.tunnel_id)) tunnel_id = a.tunnel_id;
        else {
            tunnel_id = (await createTunnelFor(env, a, expected)).id;
            changed.push('tunnel');
        }
    } else if (a.mode === 'direct') {
        if (!a.public_ip) throw new Error('direct mode needs public_ip');
    } else {
        throw new Error(`unknown mode ${a.mode}`);
    }
    try {
        if (a.mode === 'tunnel') await cf.setTunnelIngress(env, tunnel_id, a.hostname, a.origin || DEFAULT_ORIGIN);
        const want = dnsTarget({ ...a, tunnel_id });
        let rec = await cf.findDnsRecord(env, a.hostname);
        const intact = rec && rec.type === want.type && rec.content === want.content && rec.proxied === want.proxied;
        if (!intact && !(await db.isUnchanged(env, a.name, expected, { withIds: true }))) throw raced();
        if (rec && rec.type !== want.type) {
            // Cloudflare won't change a record's type in place (tunnel ↔ direct is CNAME ↔ A): replace it.
            try { await cf.deleteDnsRecord(env, rec.id); } catch (e) { if (e?.status !== 404) throw e; }
            rec = null;
        }
        let dns_record_id;
        if (!rec) {
            dns_record_id = (await cf.createDnsRecord(env, a.name, want)).id;
            changed.push('dns');
        } else {
            dns_record_id = rec.id;
            if (rec.content !== want.content || rec.proxied !== want.proxied) {
                await cf.patchDnsRecord(env, rec.id, want);
                changed.push('dns');
            }
        }
        // Moving tunnel → direct: once the address is routed, the owner's old tunnel has nothing left to serve (not
        // before: a failure above leaves the row routed on it). The row stops recording it, so one Cloudflare won't
        // delete is owed.
        if (a.mode === 'direct' && a.tunnel_id) {
            try { await cf.deleteTunnel(env, a.tunnel_id); }
            catch (e) { if (e?.status !== 404) await owe(env, '[MODE_SWITCH_LEFT]', a.name, 'tunnel', a.tunnel_id, e); }
        }
        return { tunnel_id, dns_record_id, changed };
    } catch (e) {
        // A tunnel made just now is recorded nowhere (the caller writes nothing on a throw), and Cloudflare refuses
        // a second tunnel of the same name: left behind, it would fail every retry. It goes — or is owed.
        if (changed.includes('tunnel')) {
            try { await cf.deleteTunnel(env, tunnel_id); }
            catch (d) { if (d?.status !== 404) await owe(env, '[PROVISION_ORPHAN]', a.name, 'tunnel', tunnel_id, d); }
        }
        throw e;
    }
}

const raced = () => Object.assign(new Error('the name changed meanwhile'), { raced: true });
const cleaningUp = (name) => Object.assign(new Error(`a tunnel named bp-${name} is still being removed at Cloudflare`), { cleaningUp: true });

// A tunnel nobody records is nobody's once it is this old: a request records a tunnel it made within seconds.
const STALE_TUNNEL_S = 600;

// A new bp-<name> tunnel for `a`. Cloudflare refuses a second live tunnel of one name (1013), so one left behind — by
// an earlier holder, or a delete Cloudflare refused — would fail every tunnel for the name, for good. On that refusal
// the ones provably nobody's go, and the tunnel is made again (once): not the row's, and owed (teardown), or made
// before this tenure began, or made over STALE_TUNNEL_S ago — over ORPHAN_AFTER_S ago for a pending tenure: a claim
// whose Worker was cut off after making its tunnel leaves one no row records, and every request that could still be
// making a pending name's tunnel (its claim, its node's heal, an approve, a sweep) has had its node's 25 s and
// waitUntil's 30 s by then, so the sweep and its node's heal finish the name in minutes, not 10 (review of #2125). One
// that may still be a request's in flight is left: `cleaningUp` (the caller answers 503, try again shortly). If the
// row changed meanwhile, the tunnel may be the request that changed it: `raced`.
async function createTunnelFor(env, a, expected) {
    const tunnelName = `bp-${a.name}`;
    try { return await cf.createTunnel(env, tunnelName); }
    catch (e) { if (!cf.tunnelNameTaken(e)) throw e; }
    if (!(await db.isUnchanged(env, a.name, expected, { withIds: true }))) throw raced();
    const owedRows = await db.listTeardown(env, a.name).catch((e) => { console.error('[TEARDOWN_READ]', a.name, e.message || e); return []; });
    const owed = new Set(owedRows.filter((t) => t.kind === 'tunnel').map((t) => t.cf_id));
    const before = Math.max(a.requested_at || 0, nowS() - (expected.status === 'pending' ? ORPHAN_AFTER_S : STALE_TUNNEL_S));
    const stale = (await cf.listTunnelsNamed(env, tunnelName)).filter((t) => t.id !== a.tunnel_id && t.id !== expected.tunnel_id
        && (owed.has(t.id) || Date.parse(t.created_at) / 1000 < before));
    if (!stale.length) throw cleaningUp(a.name);
    for (const t of stale) {
        try { await cf.deleteTunnel(env, t.id); }
        catch (d) {
            if (d?.status !== 404) { await owe(env, '[STALE_TUNNEL]', a.name, 'tunnel', t.id, d); throw cleaningUp(a.name); }
        }
        if (owed.has(t.id)) await db.dropTeardown(env, 'tunnel', t.id);
        console.warn('[STALE_TUNNEL]', a.name, t.id, `deleted: no row records it, and it was ${owed.has(t.id) ? 'owed' : 'made before this tenure or long ago'}`);
    }
    try { return await cf.createTunnel(env, tunnelName); }
    catch (e) { throw cf.tunnelNameTaken(e) ? cleaningUp(a.name) : e; }
}

// What routes `name` at Cloudflare that the registrar did not make, before a new tenure's first ensure(): every host
// record at the hostname (A and AAAA may stand side by side, and ensure() would replace one after another), unless
// `row` (the last tenure's, or a pending claim's own) records it or it is owed (teardown) — those the takeover deletes
// as its own; and, at a name the registrar never held before (`heldBefore` false), any live bp-<name> tunnel. Where it
// did hold the name, a tunnel nothing records may be its own leftover, and createTunnelFor already deletes one only
// when provably stale. A pending tenure being finished (`since`: when it began) also owns what it made itself before
// it stopped — a Worker that died part way, or a record Cloudflare made but answered an error for: a bp-<name> tunnel
// made since it began, deleted since or not, and a CNAME to one (only the registrar makes bp- tunnels); for a direct
// tenure, an A record at the public_ip its row declares (NB-1 of the #1985 review: nobody makes a hand record at a
// pending row's label, README "Hand records"). Anything else is someone else's: one of our own servers, routed by
// hand. Null when there is nothing. Throws if Cloudflare can't say: "can't tell" never reads as "nothing there".
async function outsideRegistrar(env, name, row, heldBefore, since = null) {
    const owed = await db.listTeardown(env, name);
    const ours = (kind, id) => id === row?.[kind === 'dns' ? 'dns_record_id' : 'tunnel_id'] || owed.some((t) => t.kind === kind && t.cf_id === id);
    const named = since === null && heldBefore ? [] : await cf.listTunnelsNamed(env, `bp-${name}`, { withDeleted: since !== null });
    const made = new Set(since === null ? [] : named.filter((t) => Date.parse(t.created_at) / 1000 >= since - CF_CLOCK_SLACK_S).map((t) => t.id));
    const madeTarget = (r) => (r.type === 'CNAME' && [...made].some((id) => r.content === `${id}.cfargotunnel.com`))
        || (since !== null && row?.mode === 'direct' && r.type === 'A' && !!row.public_ip && r.content === row.public_ip);
    const dns = (await cf.findDnsRecords(env, `${name}.${env.BASE_DOMAIN}`)).filter((r) => !ours('dns', r.id) && !madeTarget(r));
    const tunnels = heldBefore ? 0 : named.filter((t) => !t.deleted_at && !ours('tunnel', t.id) && !made.has(t.id)).length;
    return dns.length || tunnels ? { dns, tunnels } : null;
}

// Cloudflare's clock against the Worker's: a tunnel a claim made is never dated before the claim by more than this.
const CF_CLOCK_SLACK_S = 60;

// What is in the way of finishing pending tenure `a` (a claim whose provisioning failed, or the admin's approve): what
// it made itself since `requested_at` is its own.
const outsidePending = async (env, a) =>
    outsideRegistrar(env, a.name, a, await db.claimedBefore(env, a.name, a.requested_at), a.requested_at);

const aRecord = (r) => `${/^[AEIOU]/.test(r.type) ? 'an' : 'a'} ${r.type} record`;

// Refuse the claim, change nothing at Cloudflare or in the table but the audit trail, and tell the admin (hostnames
// and counts only).
async function refuseOutside(env, name, pubkey, found, by = `claim by key ${key16(pubkey)}`) {
    const what = [...found.dns.map(aRecord), found.tunnels && `${found.tunnels} bp-${name} tunnel${found.tunnels === 1 ? '' : 's'}`]
        .filter(Boolean).join(' and ');
    console.warn('[OUTSIDE_REGISTRAR]', name, `${by} refused: ${what} the registrar did not make`);
    await logEvent(env, name, 'claim-refused', `${by} refused: ${what} at Cloudflare the registrar did not make; nothing changed. If the name is ours, add a name_policy row (blocked) by migration.`);
    await tell(env, () => alerts.outsideRegistrar(env, name, what));
    return json({ error: 'name in use outside the registrar' }, 409);
}

// Delete a row's tunnel and DNS record. Returns the ids still to remember: null once a resource is gone (deleted
// now, or a 404), the old id if Cloudflare refused — a live tunnel we lost track of could not be re-checked by
// the owner's next heal, which would then mint a second tunnel beside it.
async function deprovision(env, a) {
    return { dns_record_id: await dnsOff(env, a), tunnel_id: await tunnelOff(env, a) };
}

// Routing off, tunnel kept: an admin pause, or a heal or take-back whose edge re-attest failed.
async function dnsOff(env, a) {
    if (!a.dns_record_id) return null;
    try { await cf.deleteDnsRecord(env, a.dns_record_id); return null; }
    catch (e) { return e?.status === 404 ? null : a.dns_record_id; }
}

async function tunnelOff(env, a) {
    if (!a.tunnel_id) return null;
    try { await cf.deleteTunnel(env, a.tunnel_id); return null; }
    catch (e) { return e?.status === 404 ? null : a.tunnel_id; }
}

async function tunnelTokenOrNothing(env, a) {
    if (a.mode !== 'tunnel' || !a.tunnel_id) return undefined;
    try { return await cf.getTunnelToken(env, a.tunnel_id); } catch { return undefined; /* the node asks /status again */ }
}

// A keyholder is told that it failed, and a reference to the log line; only the admin is told Cloudflare's answer.
const provisionFailed = (e, { admin = false } = {}) => {
    if (e?.cleaningUp) {
        console.warn('[PROVISION_WAIT]', e.message);
        return json({ error: 'cleaning up this name\'s earlier routing at Cloudflare; try again shortly' }, 503);
    }
    const ref = errorRef();
    console.error('[PROVISION_FAIL]', ref, e.stack || e.message || e);
    return json({ error: 'provisioning failed', ref, ...(admin ? { detail: String(e.message || e) } : {}) }, 502);
};

// --- Owed deletions ---
// A tunnel or record a request let go of — the old holder's at a take-over, one a failed request made, one an undo
// or a resume could not delete, a take-down's record, the record a failed re-attest took back down — that Cloudflare
// refused to delete is owed (teardown, migration 0004), never dropped: a live bp-<name> tunnel nobody records fails
// every later tunnel for the name, and a record left up keeps routing a node the registrar no longer routes. Logged
// under `tag`. The sweep retries it (settleOwed); a tunnel still alive is also deleted by the name's next tunnel
// (createTunnelFor).
async function owe(env, tag, name, kind, id, err) {
    if (!id) return;
    console.error(tag, name, kind, id, String(err?.message || err || 'Cloudflare refused its delete'), '— owed: the sweep retries it');
    try { await db.oweTeardown(env, name, kind, id, nowS()); }
    catch (e) { console.error('[TEARDOWN_UNRECORDED]', name, kind, id, e.message || e); }
}

// One owed deletion, retried — unless it is the name's routing now:
//   - a record at a live name's hostname is the live row's to keep: the row's repair runs first (it adopts the record,
//     or points it back where the row says — an undo whose PATCH-back Cloudflare refused leaves one pointing
//     elsewhere), and a record the live row, read again after it, records is owed no more once the hostname routes as
//     that row says (a repair Cloudflare refused leaves the record pointing wherever a missed request left it: owed
//     until it doesn't) — and dropped only while that row is unchanged: a pause, block or release landing during the
//     repair wrote its row, then owed this same record onto this entry (a no-op), and dropping it then would leave the
//     take-down's record up for good;
//   - a tunnel the row still routes on, or an admin pause keeps for its node, is left for now but stays owed: a request
//     moving the row off it (a heal to a direct address) may be in flight. It goes once no row keeps it.
// True once it is gone (deleted now, or a 404) or owed no more.
async function settleOwed(env, t) {
    let row = await db.getAllocation(env, t.name);
    if (t.kind === 'dns') {
        if (row?.status === 'live') { await repairLive(env, t.name); row = await db.getAllocation(env, t.name); }
        if (row?.status === 'live' && row.dns_record_id === t.cf_id)
            return (await routesAsRow(env, row)) && db.dropTeardownIfUnchanged(env, t.kind, t.cf_id, t.name, row);
    } else if (row?.tunnel_id === t.cf_id && (row.status === 'live' || (row.status === 'paused' && row.pause_reason === 'admin'))) {
        return false;
    }
    try { await (t.kind === 'tunnel' ? cf.deleteTunnel(env, t.cf_id) : cf.deleteDnsRecord(env, t.cf_id)); }
    catch (e) {
        if (e?.status !== 404) { await db.teardownRefused(env, t.kind, t.cf_id, String(e.message || e)); return false; }
    }
    // A request may have gone live on it just as it went (a claim adopting the record, a heal re-attested through the
    // tunnel): if the row is live now, its routing is made whole.
    if ((await db.getAllocation(env, t.name))?.status === 'live') await repairLive(env, t.name);
    console.warn('[TEARDOWN_DONE]', t.name, t.kind, t.cf_id, `owed since ${t.since}`);
    await db.dropTeardown(env, t.kind, t.cf_id);
    return true;
}

// --- Races ---
// A request reads the row, works at Cloudflare (ensure; on a kept tunnel, an edge re-attest of up to 15 s), then
// writes. Whatever is decided meanwhile stands:
//   - bringing routing up (heal, claim, take-back, approve, resume): every write after a Cloudflare call holds only
//     while the row is as this request read or last wrote it — tenure, state, the tunnel and record ids and the
//     target they route to (db.updateIfUnchanged withIds) — and ensure() changes the record at the hostname only
//     while it is. So does taking back routing a failed re-attest put up. On a miss the request undoes what it did
//     (undo: a record it changed that is now another tenure's is put back to that tenure) and answers with the row as
//     it now is. A write that records Cloudflare work that changed anything also counts a decision (recorded), even
//     when it writes the values the row already has: a PATCH keeps the record's id, so a request pointing the record
//     back at the target the row records — the sweep's repair, a bare heal — writes nothing new, and a heal that had
//     moved the name to a new address and read the row before it would still match, and record an address Cloudflare
//     no longer routes (r4101264972).
//   - taking routing down (the admin's pause and block, a release, the sweep's pause): the row is written FIRST,
//     then Cloudflare (stopRouting), so a request that read the row earlier misses its own write. That write always
//     counts a decision (decision_seq), so one that changes no status — blocking a blocked name, pausing a paused
//     one — is missed by a request in flight all the same. Its records go only while the row still holds it.
//   - a check can't be atomic with Cloudflare: whichever side lost the race and cleaned up, if the row is live when
//     it is done, its routing is made whole again (repairLive) — a record deleted from under it is re-made. And the
//     sweep repairs any live name nothing answers at whose routing Cloudflare no longer has (upkeep), so no ordering
//     leaves a live name dark for good: nodes never heal a name /status calls live.

// The decision counter a write carries: the row's, plus one. NULL (a row no decision has touched) counts as 0.
const decision = (a) => ({ decision_seq: (a.decision_seq ?? 0) + 1 });

// What a write over `a` records of ensure()'s work: the ids it routes on, and a decision when Cloudflare changed
// anything, so that no request that read the row before this write can match its own afterwards (see Races).
const recorded = (ids, a) => ({ tunnel_id: ids.tunnel_id, dns_record_id: ids.dns_record_id, ...(ids.changed.length ? decision(a) : {}) });

// What ensure() made at Cloudflare when it made nothing (it threw `raced`): there is nothing to undo.
const NOTHING = { tunnel_id: null, dns_record_id: null, changed: [] };

// What a live row routes to, for telling whether it changed between two reads.
const routeOf = (r) => JSON.stringify(r && [r.status, r.node_pubkey, r.requested_at, r.dns_record_id, r.status === 'live' ? dnsTarget(r) : null]);

// A request whose conditional write missed: the row changed while it was at Cloudflare. Undone as far as the row,
// as it now is, allows (a Cloudflare call refused here is logged and left):
//   - a tunnel it made goes unless the row is now live on it (nobody else was given its token, and a kept tunnel
//     nobody can connect to would fail every re-attest);
//   - the record it found or made at the hostname goes unless the row is now live. If the row is live and this
//     request changed that record, it may be another tenure's now (ensure works by hostname): it is put back to
//     what the live row says — re-pointed at the row's target when it is the record the row knows, deleted when it
//     isn't (a record the row doesn't know would outlive the row's own release or pause, which delete by id). Then
//     the row is read again and, if it changed meanwhile, the same again (3 tries). A record this request didn't
//     change is left to the live row;
//   - then, if the row is live, its routing is made whole (repairLive): this request's clean-up — a record it took
//     down after a failed re-attest, a PATCH-back that found the record gone — may have raced the row going live.
// Returns the row as it now is.
async function undo(env, name, ids) {
    const now = await undoOnly(env, name, ids);
    return now?.status === 'live' ? repairLive(env, name) : now;
}

async function undoOnly(env, name, ids) {
    let now = await db.getAllocation(env, name);
    const drop = async (what, id, del) => {
        try { await del(); } catch (e) { if (e?.status !== 404) await owe(env, '[UNDO_FAILED]', name, what, id, e); }
    };
    if (ids.changed.includes('tunnel') && !(now?.status === 'live' && now.tunnel_id === ids.tunnel_id))
        await drop('tunnel', ids.tunnel_id, () => cf.deleteTunnel(env, ids.tunnel_id));
    const rec = ids.dns_record_id;
    for (let i = 0; rec && i < 3; i++) {
        if (now?.status !== 'live') { await drop('dns', rec, () => cf.deleteDnsRecord(env, rec)); break; }
        if (!ids.changed.includes('dns')) break;
        if (now.dns_record_id === rec) {
            try { await cf.patchDnsRecord(env, rec, dnsTarget(now)); }
            catch (e) { if (e?.status !== 404) await drop('dns', rec, () => cf.deleteDnsRecord(env, rec)); }
        } else {
            await drop('dns', rec, () => cf.deleteDnsRecord(env, rec));
        }
        const again = await db.getAllocation(env, name);
        if (routeOf(again) === routeOf(now)) break;
        now = again;
    }
    console.warn('[RACE]', name, `changed under a request (now ${now?.status ?? 'gone'}): what it did at Cloudflare is undone`);
    return now;
}

// A live row's hostname routes what the row says — made so again when it doesn't: heal's repair, done by the
// registrar. Run where a clean-up may have raced a request that went live meanwhile (the record, or the tunnel, it
// removed is a live row's now), and by the sweep for a live name nothing answers at. ensure() on the row as it now is
// — a tunnel Cloudflare no longer has is made again, and its token reaches the owner's node through the signed
// /status, which nodes poll and act on while live — its ids recorded only while the row is still that; on a miss,
// undone, and tried again on the row as it then is (3 tries). Never routes a row that isn't live. Returns the row as
// it now is.
async function repairLive(env, name) {
    for (let i = 0; i < 3; i++) {
        const row = await db.getAllocation(env, name);
        if (row?.status !== 'live') return row;
        let ids;
        try { ids = await ensure(env, row, row); }
        catch (e) {
            if (e.raced) continue;
            console.error('[REPAIR_FAILED]', name, e.message || e);
            return row;
        }
        const made = recorded(ids, row);
        if (!ids.changed.length && made.tunnel_id === (row.tunnel_id ?? null) && made.dns_record_id === (row.dns_record_id ?? null)) return row;
        if (await db.updateIfUnchanged(env, name, row, made, { withIds: true })) {
            const what = ids.changed.length ? `${ids.changed.join(', ')} re-made` : 'the record at its hostname recorded';
            console.warn('[REPAIRED]', name, what);
            await logEvent(env, name, 'repaired', `live, but not routed as its row says: ${what} by the registrar`
                + (ids.changed.includes('tunnel') ? ' (a new tunnel: its node gets the token from /status)' : ''));
            await tell(env, () => alerts.repaired(env, name, ids.changed.length ? `re-made its ${ids.changed.join(' and ')}` : 'recorded the record at its hostname'));
            return { ...row, ...made };
        }
        await undoOnly(env, name, ids);
    }
    return db.getAllocation(env, name);
}

// The record at `hostname`, if there is one, goes too: one a request put up but had not recorded when routing came
// down. Returns the id of a record still there (Cloudflare refused its delete), or `known` when it can't tell.
async function dnsOffAt(env, hostname, known) {
    let rec;
    try { rec = await cf.findDnsRecord(env, hostname); } catch { return known; }
    if (!rec) return null;
    try { await cf.deleteDnsRecord(env, rec.id); return null; }
    catch (e) { return e?.status === 404 ? null : rec.id; }
}

// Routing down, row first: `to` is written over `a` — the row as just read, ids and all — only if nothing changed
// it since; then Cloudflare loses what `a` recorded (the tunnel too, unless `keepTunnel`; with `byHostname`, any
// record at the hostname as well); then the row keeps only what Cloudflare refused to delete. `to` null: the state
// stands (a block repeated), but the decision is still counted — a request in flight must not route over it — and
// the clean-up runs. False, having touched nothing, if the row changed.
// The clean-up is this decision's only while the row still holds it: a record goes only while it does — a decision
// or request that landed since (the admin's resume, a release and another key's claim) may have put up or re-pointed
// its own at the hostname. The tunnel `a` recorded goes regardless: whatever rode it dies with it. What Cloudflare
// refused stays on the row; a record is also owed, so the sweep retries it — a paused, blocked or released name
// would otherwise stay routed. (A tunnel is not owed: with no record it routes nothing. A resume, take-back or
// take-over deletes it first; the owner's heal reuses it, and routes only on an edge re-attest.) And since no check
// is atomic with Cloudflare, a row that moved on during the clean-up and is live gets its routing made whole again
// (repairLive): a record deleted from under it, or the tunnel it went live on.
async function stopRouting(env, a, to, { keepTunnel = false, byHostname = false } = {}) {
    const written = { ...to, ...decision(a) };
    if (!(await db.updateIfUnchanged(env, a.name, a, written, { withIds: true }))) return false;
    const mine = { ...a, ...written };
    const holds = () => db.isUnchanged(env, a.name, mine, { withIds: true });
    const left = { tunnel_id: a.tunnel_id ?? null, dns_record_id: a.dns_record_id ?? null };
    let tried = false;
    if (await holds()) { left.dns_record_id = await dnsOff(env, a); tried = true; }
    if (!keepTunnel) left.tunnel_id = await tunnelOff(env, a);
    if (byHostname && await holds()) { left.dns_record_id = await dnsOffAt(env, a.hostname, left.dns_record_id); tried = true; }
    if (tried) await owe(env, '[TAKEDOWN_LEFT]', a.name, 'dns', left.dns_record_id);
    if (left.tunnel_id !== (a.tunnel_id ?? null) || left.dns_record_id !== (a.dns_record_id ?? null))
        await db.updateIfUnchanged(env, a.name, mine, left, { withIds: true });
    if (!(await db.isUnchanged(env, a.name, { ...mine, ...left }, { withIds: true }))) await repairLive(env, a.name);
    return true;
}

// The answer to the owner's heal or claim whose write missed: nothing done, and the row as it now is.
async function asNow(env, now, pubkey) {
    if (!isOwnRow(now, pubkey)) return json({ error: 'name changed meanwhile', status: now?.status ?? 'none' }, 409);
    if (now.status === 'blocked') return json({ error: 'name blocked' }, 403);
    return {
        name: now.name, hostname: now.hostname, mode: now.mode, community_name: now.community_name, contact: now.contact,
        status: now.status, reason: await reasonOf(env, now), since: sinceOf(now), changed: [], newTunnel: false, tunnel_id: now.tunnel_id,
    };
}

// --- Node-facing (signed) ---
async function handleAvailable(url, env) {
    const name = String(url.searchParams.get('name') || '').toLowerCase();
    if (!NAME_RE.test(name)) return json({ available: false, reason: 'invalid' });
    const tier = await db.policyTier(env, name);
    if (tier === 'blocked') return json({ available: false, reason: 'reserved' });
    const taken = holdsName(env, await db.getAllocation(env, name));
    return json({ available: !taken, reason: taken ? 'taken' : (tier === 'gated' ? 'needs-approval' : 'free'), tier });
}

// What a claim or heal body may change on the owner's row: only the fields it carries.
function bodyFields(b) {
    const f = {};
    if (b.mode === 'tunnel' || b.mode === 'direct') f.mode = b.mode;
    if (typeof b.origin === 'string' && b.origin) f.origin = b.origin;
    if (typeof b.public_ip === 'string' && b.public_ip) f.public_ip = b.public_ip;
    const comm = b.community_name !== undefined ? b.community_name : b.communityName;
    if (typeof comm === 'string' && comm.trim()) f.community_name = comm.trim();
    if (typeof b.contact === 'string' && b.contact.trim()) f.contact = b.contact.trim();
    return f;
}

// --- What a keyholder may set (L3 of the 2026-10-01 review) ---
// Display text — a community's name, its operator's contact: any script (communities are worldwide), but no control
// characters, no line or paragraph separators and no bidi overrides, which would let a row disguise itself on the admin
// page. An email address is at most 254 characters.
const TEXT_MAX = { community_name: 120, communityName: 120, contact: 254 };
const BAD_TEXT = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;
// Where a tunnel sends a name's traffic, as Cloudflare's ingress takes it: http(s)://host[:port], and nothing more.
// Nodes send http://127.0.0.1:<port> (once http://beanpool-node:8080).
const ORIGIN_MAX = 200;
const ORIGIN_RE = /^https?:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?\/?$/i;
// A direct name's address goes into an A record: IPv4.
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const isSet = (v) => v !== undefined && v !== null && v !== '';

function validOrigin(v) {
    if (typeof v !== 'string' || v.length > ORIGIN_MAX || !ORIGIN_RE.test(v)) return false;
    try { new URL(v); return true; } catch { return false; }   // a port over 65535, a malformed IPv6 address
}

// What is wrong with the display labels (community name, contact) a claim, heal or update body sets, or null. A label
// absent or null is not set.
function labelProblem(b) {
    for (const [key, max] of Object.entries(TEXT_MAX)) {
        const v = b[key];
        if (v === undefined || v === null) continue;
        if (typeof v !== 'string') return `${key} must be text`;
        const t = v.trim();   // what is stored
        if ([...t].length > max) return `${key} is longer than ${max} characters`;
        if (BAD_TEXT.test(t)) return `${key} contains an invisible formatting or control character`;
    }
    return null;
}
// What is wrong with the fields that decide routing, or null.
function routeProblem(b) {
    if (isSet(b.origin) && !validOrigin(b.origin)) return `origin must be http(s)://host[:port], at most ${ORIGIN_MAX} characters`;
    if (isSet(b.public_ip) && !(typeof b.public_ip === 'string' && IPV4_RE.test(b.public_ip))) return 'public_ip must be an IPv4 address';
    return null;
}
// What is wrong with the fields a claim, heal or update body sets, or null. Answered with a 400 before the request
// writes anything.
function fieldProblem(b) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return 'the body must be a JSON object';
    return labelProblem(b) || routeProblem(b);
}
// For a request by the key that already holds the name: routing outranks a label, so a label that fails its checks is
// dropped from the body and logged here, never a reason to refuse a claim or heal (a node whose community name carries
// a character it can't see would otherwise stay dark through every tick). Returns the problem with the routing
// fields, which are still refused, or null; `b` is changed in place.
function dropBadLabels(b, who) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return 'the body must be a JSON object';
    for (const key of Object.keys(TEXT_MAX)) {
        const problem = labelProblem({ [key]: b[key] });
        if (!problem) continue;
        console.warn('[LABEL_DROPPED]', who, problem);
        delete b[key];
    }
    return routeProblem(b);
}
const badField = (problem) => json({ error: problem }, 400);
// A direct name is an A record at its node's address: with none known, nothing could be made, so the claim or heal is
// refused before it writes anything (SEC-REG-01, verified 2026-10-16) rather than leave a pending row that fails at
// Cloudflare (or at the admin's approve).
const DIRECT_NEEDS_IP = 'direct mode needs public_ip (the server\'s public IPv4 address); without one, claim in tunnel mode';

// --- Names per key (M1 of the 2026-10-01 review) ---
// How many names one node key may hold at once (db.countHeldBy: live, pending, paused or blocked, and its own releases
// still inside their hold), CLAIM_LIMIT_PER_KEY, 3 unless set. A node uses one name, and its release is held for it
// RELEASE_COOLOFF_S so it can take it back: a node that renames twice inside that hold holds three. And three per key
// keeps one key to three Cloudflare tunnels: the account's ~1,000 would take hundreds of keys, not one script with one
// key (claims from many keys are for a per-IP budget at Cloudflare, not this). Only a new name counts against it: a
// name its key holds is healed and taken back whatever the count, and a key over the limit keeps every name it has.
// The live number is a setting (src/settings.js claim_limit_per_key): `s`, the settings this request read, or the env's.
export function claimLimit(env, s = settings.resolve(env)) {
    return s.claim_limit_per_key;
}
const overLimit = (held, limit) => json({
    error: `this node key already holds ${held} name${held === 1 ? '' : 's'}, and one key may hold ${limit}: release one first (a release counts until its hold ends)`,
    limit, held,
}, 403);

// Routing back on: every run of foreign answers (applyVerdict) starts again from nothing.
const LIVE = { status: 'live', pause_reason: null, paused_at: null, attest_fails: 0, swap_fails: 0 };

// Routing back on for the owner's name that is not live — a pause its heal lifts, or its own release taken back —
// only when nobody but the owner can be answering: at once on a tunnel made in this request (only this signed
// request gets its token); otherwise (a tunnel that outlived a pause or a release, or a direct address) only on an
// edge re-attest the owner's key signed. `res` is the row as the caller last wrote it, with what ensure() made. Writes
// the row live — only while it is still `res`, ids and all — and returns { live: true, attest? }, or { missed: true }
// for the caller to undo; else takes routing back off — again only while the row is still `res`: once it changed, the
// record may be a newer decision's or request's (a resume gone live on it), and the caller undoes instead — and
// returns { live: false, verdict, why, dns_record_id } for the caller to record. A record Cloudflare refused to delete
// is also owed: the row stays paused, which neither the sweep's attest nor its upkeep looks at, so nothing else would
// ever take it down, and it would keep routing whoever failed the re-attest.
async function routeIfOnlyOwner(env, res, ids, now) {
    const goLive = async (fields, out) => ((await db.updateIfUnchanged(env, res.name, res, fields, { withIds: true })) ? out : { missed: true });
    if (res.mode === 'tunnel' && ids.changed.includes('tunnel')) return goLive(LIVE, { live: true });
    const r = await classify(env, res);
    if (r.verdict === 'ok') return goLive({ ...LIVE, last_attest_at: now, last_ok_at: now }, { live: true, attest: 'ok' });
    if (!(await db.isUnchanged(env, res.name, res, { withIds: true }))) return { missed: true };
    const left = await dnsOff(env, res);
    await owe(env, '[REATTEST_LEFT]', res.name, 'dns', left);
    return { live: false, ...r, dns_record_id: left };
}

// The owner's own held name (live, paused or pending): bring it back to what it should be. Never deprovisions
// first; ensure() reuses whatever Cloudflare still has. Returns { status, …, changed, newTunnel } or a Response.
//   live    → repair (re-assert tunnel, ingress, DNS).
//   pending → an auto name whose provisioning failed is retried; a gated one keeps waiting for the admin.
//   paused  → the admin's pause only the admin lifts. Any other pause resumes under routeIfOnlyOwner; otherwise
//             routing goes back off and the name stays paused — and the owner's.
// A heal whose write missed is undone; if the name is still its key's and live, but its row doesn't record what this
// heal carries (a new address, mode or origin), the heal is tried again on the row as it now is (`tries` in all): a
// repair or a bare heal that read the row at the node's old address — the sweep's repair runs just as a node moves,
// when nothing answers at its old address — would otherwise leave the node answered live where it no longer is.
async function heal(env, cur, b, now, tries = 3) {
    const fields = bodyFields(b);
    const a = { ...cur, ...fields };
    // The address this heal routes to: the body's, or the one the row already has.
    if (a.mode === 'direct' && !a.public_ip) return badField(DIRECT_NEEDS_IP);
    const reply = (extra) => ({
        name: a.name, hostname: a.hostname, mode: a.mode, community_name: a.community_name, contact: a.contact, ...extra,
        ...(extra.status === 'live' && onProbation(cur) ? { probation: true } : {}),
    });
    // Every write holds only while the row is as read (`cur`), then as this heal last wrote it (`res`), ids and target
    // and all; if it changed, the heal is undone.
    let ids = NOTHING;
    const missed = async () => {
        const row = await undo(env, cur.name, ids);
        if (tries > 1 && row?.status === 'live' && isOwnRow(row, cur.node_pubkey) && Object.entries(fields).some(([k, v]) => row[k] !== v)) {
            const again = await db.getAllocation(env, cur.name);
            if (again?.status === 'live' && isOwnRow(again, cur.node_pubkey)) return heal(env, again, b, now, tries - 1);
        }
        return asNow(env, row, cur.node_pubkey);
    };

    // Not routed by a heal: only where its node now is is recorded, and only over the row as read. Written over an
    // approval or the admin's resume that went live meanwhile, it would leave a live row naming a target Cloudflare
    // doesn't route.
    if (await awaitingApproval(env, cur)) {
        if (!(await db.updateIfUnchanged(env, cur.name, cur, fields, { withIds: true }))) return missed();
        return reply({ status: 'pending', reason: 'awaiting-approval', since: cur.requested_at, note: 'awaiting approval', changed: [] });
    }
    if (cur.status === 'paused' && cur.pause_reason === 'admin') {
        if (!(await db.updateIfUnchanged(env, cur.name, cur, fields, { withIds: true }))) return missed();
        return reply({ status: 'paused', reason: 'admin', since: cur.paused_at, changed: [] });
    }

    // A pending row is a new tenure whose provisioning failed: finishing it takes over nothing the registrar did not
    // make, as its claim would not have (NB1 of the #1978 review) — what that claim made before it stopped is its own.
    if (cur.status === 'pending') {
        let found;
        try { found = await outsidePending(env, cur); }
        catch (e) { return provisionFailed(e); }
        if (found) {
            if (!(await db.isUnchanged(env, cur.name, cur, { withIds: true }))) return missed();
            return refuseOutside(env, cur.name, cur.node_pubkey, found);
        }
    }

    try { ids = await ensure(env, a, cur); } catch (e) { return e.raced ? missed() : provisionFailed(e); }
    const made = recorded(ids, cur);
    if (!(await db.updateIfUnchanged(env, cur.name, cur, { ...fields, ...made }, { withIds: true }))) return missed();
    const res = { ...a, ...made };
    const newTunnel = ids.changed.includes('tunnel');

    if (cur.status === 'live') {
        if (ids.changed.length) await logEvent(env, cur.name, 'healed', `repaired by its owner: ${ids.changed.join(', ')} re-made`);
        // A request whose write missed undoes by pointing the record at the row as it then is, and writes nothing: one
        // landing between this heal's last Cloudflare call and its write pointed the record back at the target this
        // heal moved the name off, unseen. So a heal that changed what a live name routes to checks Cloudflare after.
        if (routeOf(cur) !== routeOf(res)) await routedOrRepaired(env, cur.name);
        return reply({ status: 'live', changed: ids.changed, newTunnel, tunnel_id: ids.tunnel_id });
    }

    if (cur.status === 'pending') {
        // An auto name whose first provisioning failed: this is that claim, finished.
        if (!(await db.updateIfUnchanged(env, cur.name, res, { ...LIVE, decided_at: now, decided_by: 'auto' }, { withIds: true }))) return missed();
        await logEvent(env, cur.name, 'healed', `pending (provisioning had failed) → live: ${ids.changed.join(', ') || 'nothing'} made`);
        return reply({ status: 'live', changed: ids.changed, newTunnel, tunnel_id: ids.tunnel_id });
    }
    const was = `paused (${cur.pause_reason || 'no reason'})`;
    const g = await routeIfOnlyOwner(env, res, ids, now);
    if (g.missed) return missed();
    if (g.live) {
        await logEvent(env, cur.name, 'resumed', `${was} → live: healed by its owner${g.attest ? ', edge re-attest ok' : ' on a fresh tunnel'}`);
        return reply({ status: 'live', changed: ids.changed, newTunnel, tunnel_id: ids.tunnel_id, ...(g.attest ? { attest: g.attest } : {}) });
    }
    if (!(await db.updateIfUnchanged(env, cur.name, res, { dns_record_id: g.dns_record_id }, { withIds: true }))) return missed();
    await logEvent(env, cur.name, 'heal-refused', `stays ${was}: edge re-attest ${g.verdict} (${g.why})`);
    await tell(env, () => alerts.healRefused(env, cur.name, g.verdict, cur.paused_at));
    return reply({ status: cur.status, reason: await reasonOf(env, cur), since: sinceOf(cur), changed: ids.changed, attest: g.verdict, why: g.why });
}

// A name nobody else holds, or the claimant's own released one taken back: a new tenure. A gated name waits for
// the admin — unless it is the same key taking back a name the admin (or policy) already let it have. A name the
// admin released, or an abandoned one, is not the old key's any more (isOwnRow): that key waits like anyone.
// A take-back is routed as a heal from a pause is (routeIfOnlyOwner): until then its row is paused for its key
// ('unverified'), so one whose provisioning fails is finished by its next claim — a heal — never unchecked.
// `gate`: what claimGate decided of a new name's claim (the settings read, its source, why it is held), or for a key's own
// release taken back only the settings ({ s }).
async function takeName(env, existing, pubkey, b, now, gate = null) {
    const name = String(b.name).toLowerCase();
    const mode = b.mode === 'direct' ? 'direct' : 'tunnel';
    // A new tenure keeps no address of the old one (public_ip below is the body's only), so the body must carry it.
    if (mode === 'direct' && !bodyFields(b).public_ip) return badField(DIRECT_NEEDS_IP);
    const tier = await db.policyTier(env, name);
    const sameKey = isOwnRow(existing, pubkey);
    const s = gate?.s ?? settings.resolve(env);
    // An auto name held for the admin's approval (claimGate: over a limit, the hold switch, the zone near full) waits as a
    // gated one does: nothing is made at Cloudflare until the admin approves it (D6 = hold, never refuse). A key's own
    // name is never held.
    const held = tier === 'auto' && !sameKey ? (gate?.held ?? null) : null;
    const approved = (tier === 'auto' && !held) || (sameKey && !!existing.decided_at);
    const takeBack = sameKey && approved;
    const decided = { decided_at: now, decided_by: tier === 'auto' ? 'auto' : (existing?.decided_by || 'admin') };
    // A new name for this key counts against its limit (claimLimit). Its own release taken back inside the hold is
    // already counted; one past the hold isn't (it was free to anyone), so it counts as a new name does.
    const limit = claimLimit(env, s);
    const since = now - releaseCooloffS(env);
    const counted = sameKey && holdsName(env, existing, now);
    if (!counted) {
        const held = await db.countHeldBy(env, pubkey, since);
        if (held >= limit) return overLimit(held, limit);
    }
    // Another key's new tenure takes over nothing at Cloudflare the registrar did not make (F1 of the 2026-10-15
    // review): ensure() adopts the record it finds at the hostname, and createTunnelFor deletes a bp-<name> tunnel it
    // can't place. A key's own name (a heal, a take-back) skips this and keeps adopting by hostname: how it heals.
    // A gated claim reaches Cloudflare only at the admin's approve, which checks the same (adminAction).
    if (!sameKey && approved) {
        let found;
        try { found = await outsideRegistrar(env, name, existing, !!existing); } catch (e) { return provisionFailed(e); }
        if (found) {
            // A claim that landed meanwhile made it (a racing claim's tunnel): the name is that claim's.
            const still = existing ? await db.isUnchanged(env, name, existing, { withIds: true }) : !(await db.getAllocation(env, name));
            if (!still) return json({ error: 'name taken' }, 409);
            return refuseOutside(env, name, pubkey, found);
        }
    }
    const set = bodyFields(b);
    const fields = {
        node_pubkey: pubkey, hostname: `${name}.${env.BASE_DOMAIN}`, mode, status: takeBack ? 'paused' : 'pending',
        community_name: set.community_name ?? null,
        origin: set.origin ?? null, public_ip: set.public_ip ?? null, contact: set.contact ?? null,
        attest_fails: 0, swap_fails: 0, requested_at: now,
        decided_at: takeBack ? decided.decided_at : null, decided_by: takeBack ? decided.decided_by : null,
        pause_reason: takeBack ? 'unverified' : null, paused_at: takeBack ? now : null,
        released_at: null, warned_at: null, last_contact_at: now,
        // The same key's own tunnel may be reused (ensure checks it); another key's never is.
        tunnel_id: sameKey ? existing.tunnel_id : null, dns_record_id: sameKey ? existing.dns_record_id : null,
        // Migration 0011's columns, where the database has them: why it is held, and a new key's tenure on probation (its
        // own release taken back keeps the verification it had).
        ...(s.schema ? { held_reason: held, ...(sameKey ? {} : { verified_at: null, ok_sweeps: null }) } : {}),
    };
    // Another claim by the same key may have landed between the count and this write: counted again once the name is
    // won, and over the limit, this claim gives it back before it reaches Cloudflare (so racing claims may all be
    // refused, but never all kept) — while the row is still as it wrote it. If a decision landed on it meanwhile (the
    // admin's), the claim carries on, as any claim whose row changed does: it answers the row as it now is.
    const overAfter = async () => {
        if (counted) return 0;
        const held = await db.countHeldBy(env, pubkey, since);
        return held > limit ? held : 0;
    };
    if (!existing) {
        try { await db.insertAllocation(env, { name, ...fields }); }
        catch { return json({ error: 'name taken' }, 409); } // UNIQUE race
        const over = await overAfter();
        if (over && await db.deleteIfUnchanged(env, name, { name, ...fields })) return overLimit(over - 1, limit);
        await db.updateAllocation(env, name, { last_contact_at: now });
        await logEvent(env, name, 'claimed', `claimed by key ${key16(pubkey)} (${mode}, tier ${tier})`);
    } else {
        // Its own key taking back its release: a tunnel the release could not delete goes now, so the take-back is
        // on a fresh one; one Cloudflare still won't delete is kept, and routes only after a re-attest.
        if (sameKey && existing.tunnel_id) fields.tunnel_id = (await deprovision(env, { tunnel_id: existing.tunnel_id })).tunnel_id;
        Object.assign(fields, decision(existing));   // a new tenure counts as a decision; `a` below carries it
        if (!(await db.replaceAllocation(env, name, existing, fields))) return json({ error: 'name taken' }, 409); // raced
        const over = await overAfter();
        if (over) {
            const was = { ...existing };   // the row exactly as it was, the old holder's ids included
            delete was.name;
            if (await db.updateIfUnchanged(env, name, { ...existing, ...fields }, was)) return overLimit(over - 1, limit);
        }
        // Another key taking a freed name: whatever the old holder left at Cloudflare goes — once this claim has won.
        // What Cloudflare refuses to delete is owed, never dropped: no row will record it again.
        if (!sameKey) {
            const left = await deprovision(env, existing);
            await owe(env, '[TAKEOVER_LEFT]', name, 'dns', left.dns_record_id);
            await owe(env, '[TAKEOVER_LEFT]', name, 'tunnel', left.tunnel_id);
        }
        await logEvent(env, name, 'claimed', sameKey
            ? `taken back by its own key ${key16(pubkey)} (was ${existing.status})`
            : `claimed by key ${key16(pubkey)}; it was ${existing.status}, last held by ${key16(existing.node_pubkey)}`);
    }

    // Where a new name came from, kept a day (claim_sources): the per-source budgets count it, /admin groups it.
    if (gate?.src && !sameKey) await recordSource(env, { at: now, name, node_pubkey: pubkey, ...gate.src, held_reason: held });

    if (!approved) {
        await tell(env, async () => (held
            ? alerts.namesHeld(env, { reason: held, told: gate.why.told, words: gate.why.words, waiting: await db.countAwaitingApproval(env), bucket: Math.floor(now / 3600) })
            : alerts.nameRequest(env, { name, ...fields }, await db.countAwaitingApproval(env))));
        return json({ status: 'pending', hostname: fields.hostname, note: 'awaiting approval' });
    }
    const a = { name, ...fields };
    // From here every write holds only while the row is this tenure as written (`a`), then as this claim last wrote it,
    // ids and all; if it changed, the claim is undone. A failure leaves the row held by this key ('pending', or a
    // take-back's 'paused'); its next claim retries.
    let ids = NOTHING;
    const missed = async () => claimReply(env, await asNow(env, await undo(env, name, ids), pubkey));
    try { ids = await ensure(env, a, a); } catch (e) { return e.raced ? missed() : provisionFailed(e); }
    const made = recorded(ids, a);
    const out = { status: 'live', hostname: a.hostname, community_name: a.community_name, contact: a.contact };
    // A new tenure is on probation (its "New community" alert, its directory listing and the switchboard wait for it).
    if (onProbation({ verified_at: a.verified_at !== undefined ? a.verified_at : existing?.verified_at })) out.probation = true;
    if (takeBack) {
        if (!(await db.updateIfUnchanged(env, name, a, made, { withIds: true }))) return missed();
        const res = { ...a, ...made };
        const g = await routeIfOnlyOwner(env, res, ids, now);
        if (g.missed) return missed();
        if (!g.live) {
            const reason = g.verdict === 'impostor' ? 'impostor' : 'unverified';
            if (!(await db.updateIfUnchanged(env, name, res, { pause_reason: reason, dns_record_id: g.dns_record_id }, { withIds: true }))) return missed();
            await logEvent(env, name, 'paused', `taken back, but not routed: edge re-attest ${g.verdict} (${g.why}); name kept for ${key16(pubkey)}, whose heal re-attests`);
            return json({ ...out, status: 'paused', reason, since: now, attest: g.verdict, why: g.why });
        }
        if (g.attest) out.attest = g.attest;
    } else if (!(await db.updateIfUnchanged(env, name, a, { ...made, status: 'live', ...decided }, { withIds: true }))) {
        return missed();
    }
    const token = await tunnelTokenOrNothing(env, { ...a, ...made });
    if (token !== undefined) out.tunnelToken = token;
    return json(out);
}

// What a claim answers for the claimant's own name: heal's reply, with the token for a live tunnel name (claim has
// always answered one with it; nodes save what it returns).
async function claimReply(env, out) {
    if (out instanceof Response) return out;
    const body = { ...out };
    delete body.newTunnel; delete body.tunnel_id;
    if (body.status === 'live') {
        const token = await tunnelTokenOrNothing(env, out);
        if (token !== undefined) body.tunnelToken = token;
    }
    return json(body);
}

async function handleClaim(request, env, bodyText) {
    const pubkey = await signer(request, env, bodyText);
    if (pubkey instanceof Response) return pubkey;
    let b; try { b = JSON.parse(bodyText || '{}'); } catch { return json({ error: 'bad json' }, 400); }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return badField('the body must be a JSON object');
    const routing = routeProblem(b);
    if (routing) return badField(routing);

    const name = String(b.name || '').toLowerCase();
    if (!NAME_RE.test(name)) return json({ error: 'invalid name (3–32; a–z 0–9 -; no leading/trailing hyphen)' }, 400);
    const now = nowS();
    const existing = await db.getAllocation(env, name);
    // A new claim with a label that fails its checks is refused; the key's own name drops the label instead.
    if (isOwnRow(existing, pubkey)) dropBadLabels(b, `${name} ${key16(pubkey)}`);
    else { const label = labelProblem(b); if (label) return badField(label); }
    await db.touchContact(env, pubkey, now, requestProto(request));

    // The claimant's own name: a heal (or taking back its own release). Ownership outranks a policy row added
    // after the claim; only the admin's block stops it — and the admin's release of it, through its hold.
    if (isOwnRow(existing, pubkey)) {
        if (existing.status === 'blocked') return json({ error: 'name blocked' }, 403);
        if (existing.status === 'released' || existing.status === 'revoked') return takeName(env, existing, pubkey, { ...b, name }, now, { s: await settings.read(env) });
        return claimReply(env, await heal(env, existing, b, now));
    }
    if (blockedOut(env, existing, pubkey, now)) return json({ error: 'name blocked' }, 403);

    const tier = await db.policyTier(env, name);
    if (tier === 'blocked') return json({ error: 'name reserved' }, 403);
    if (holdsName(env, existing, now)) return json({ error: 'name taken', owner: 'other' }, 409);
    const gate = await claimGate(request, env, name, tier, now);
    if (gate instanceof Response) return gate;
    return takeName(env, existing, pubkey, { ...b, name }, now, gate);
}

// --- Where new names come from, and when they wait (scratch/global-node/DESIGN-registrar-trust-fable.md §4, slice S3) ---
// What Cloudflare's edge says of a claim's client, on every request (design D5): its address (CF-Connecting-IP, which the
// edge sets and no client can), its network (request.cf.asn, asOrganization) and its country. The address is kept only as
// HMAC-SHA-256 under the Worker secret SOURCE_KEY: never stored, logged or sent — and without the secret not even hashed
// (an unkeyed hash of an IPv4 address is a lookup away from it), so a claim then has no source and no per-source budget
// applies. An IPv6 address counts by its /64, the block one host is given.
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
export function sourceAddress(raw) {
    const ip = String(raw || '').trim().toLowerCase();
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return ip;
    if (!/^[0-9a-f:.]+$/.test(ip) || !ip.includes(':')) return null;
    const v4 = ip.match(/:(\d{1,3}(?:\.\d{1,3}){3})$/);   // ::ffff:192.0.2.1, an IPv4 client
    if (v4) return v4[1];
    const halves = ip.split('::');
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    if (halves.length === 2 && head.length + tail.length > 7) return null;
    const groups = halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head;
    if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
    return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}
async function sourceOf(request, env) {
    const cfp = request.cf || {};
    const key = typeof env.SOURCE_KEY === 'string' ? env.SOURCE_KEY : '';
    const addr = sourceAddress(request.headers.get('cf-connecting-ip'));
    let source_hash = null;
    if (key && addr) {
        const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        source_hash = hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(addr)));
    }
    const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\p{Cc}/gu, '').slice(0, max) : null);
    return {
        source_hash,
        asn: Number.isSafeInteger(cfp.asn) && cfp.asn > 0 ? cfp.asn : null,
        as_org: text(cfp.asOrganization, 100),
        country: typeof cfp.country === 'string' && /^[A-Z]{2}$/.test(cfp.country) ? cfp.country : null,
    };
}
const SOURCE_KEEP_S = 86400;
async function recordSource(env, r) {
    try {
        await db.pruneSources(env, r.at - SOURCE_KEEP_S);   // a day, no longer (the sweep deletes them too: pruneSources)
        await db.recordSource(env, r);
    } catch (e) { console.error('[CLAIM_SOURCE]', r.name, e.message || e); }
}
const network = (src) => (src.asn ? ` (AS${src.asn}${src.as_org ? ` ${src.as_org}` : ''}${src.country ? `, ${src.country}` : ''})` : '');

// Why a new auto name is held for the admin's approval, or null (D6 = hold, never refuse: Marty 2026-10-18 — "bots
// creating lots could lock out legit users", so no limit refuses a claim; past one, the name waits for the admin, who
// approves the real ones and rejects a bot's batch in one click). In order: the admin's switch; its source past
// source_per_hour or source_per_day; the new-name budget across all keys (SEC-REG-05) past new_names_per_hour or
// _per_day; the names holding or about to hold a DNS record past capacity_hold_at (the last places are the admin's).
// `reason` is what the row records (held_reason); `told` keys its alert, once an hour each.
function heldWhy(s, f, src, now) {
    if (settings.holding(s, now))
        return { reason: 'hold-all', told: 'hold-all', words: `Hold all new names is on, until ${new Date(s.hold_until * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` };
    if (src.source_hash && f.source_hour >= s.source_per_hour)
        return { reason: 'source', told: 'source', words: `more than ${s.source_per_hour} new names from one source in an hour${network(src)}` };
    if (src.source_hash && f.source_day >= s.source_per_day)
        return { reason: 'source', told: 'source', words: `more than ${s.source_per_day} new names from one source in 24 hours${network(src)}` };
    if (f.auto_hour >= s.new_names_per_hour)
        return { reason: 'budget', told: 'budget-hour', words: `${f.auto_hour} new names across all nodes in the last hour (budget ${s.new_names_per_hour})` };
    if (f.auto_day >= s.new_names_per_day)
        return { reason: 'budget', told: 'budget-day', words: `${f.auto_day} new names across all nodes in the last 24 hours (budget ${s.new_names_per_day})` };
    if (f.names >= s.capacity_hold_at)
        return { reason: 'near-full', told: 'near-full', words: `the DNS zone is near full: ${f.names} names of ${s.capacity}, holding from ${s.capacity_hold_at}` };
    return null;
}

// A claim of a new name (nobody's, or freed by another key): refused 403 when its source or its network is blocked
// (blocked_sources: the admin's "Block all", or a network the admin blocked), before anything is written; else what
// takeName needs — the settings read, its source, and why it is held (heldWhy; an auto name only: a gated one waits
// anyway). Told: a network past asn_per_day new names in a day, once a day (nothing is held for it alone: a hosting
// network carries many honest nodes); the names past capacity_alert_at, once a day. One D1 read decides it all
// (db.claimFacts). Without migration 0011 (no settings table) nothing can be held or recorded: the new-name budget
// refuses with a 429, as it did before it.
async function claimGate(request, env, name, tier, now) {
    const s = await settings.read(env);
    if (!s.schema) {
        if (tier === 'auto') { const spent = await newNameBudgetSpent(env, now, s); if (spent) return spent; }
        return { s, src: null, held: null };
    }
    const src = await sourceOf(request, env);
    const f = await db.claimFacts(env, { hash: src.source_hash, asn: src.asn }, now, now - 3600, now - SOURCE_KEEP_S);
    if (f.blocked) {
        console.warn('[SOURCE_BLOCKED]', name, `claim refused: its ${f.blocked === 'asn' ? `network AS${src.asn}` : 'source'} is blocked`);
        return json({ error: 'new names from your network are blocked for now; if this is a mistake, write to the BeanPool project' }, 403);
    }
    const day = Math.floor(now / 86400);
    if (src.asn && f.asn_day + 1 > s.asn_per_day)
        await tell(env, () => alerts.networkBusy(env, { asn: src.asn, as_org: src.as_org, country: src.country, names: f.asn_day + 1, limit: s.asn_per_day, day }));
    if (f.names >= s.capacity_alert_at)
        await tell(env, () => alerts.capacityNear(env, { names: f.names + 1, capacity: s.capacity, alert_at: s.capacity_alert_at, hold_at: s.capacity_hold_at, day }));
    const why = heldWhy(s, f, src, now);
    return { s, src, held: tier === 'auto' && why ? why.reason : null, why };
}

// --- New names across all keys (SEC-REG-05, verified 2026-10-16) ---
// Keys are free, so the per-key limit (claimLimit) does not stop many keys: each new auto name makes a tunnel and a DNS
// record at Cloudflare, whose caps (~1,000 tunnels per account; 200 or 1,000 records per zone, our own hand records
// included) one script could fill. So new auto names, across all keys, are budgeted per hour and per day (the settings
// new_names_per_hour and new_names_per_day). Past either, a new auto name is held for the admin's approval (heldWhy:
// D6, hold, never refuse), and the admin's phone is told once an hour — in counts, never a name or a key. Untouched: a
// gated claim (it makes nothing at Cloudflare until the admin approves), and a key's own names (heals, take-backs). The
// count is read, not reserved, so claims racing at the edge may pass it by a few.
const NEW_NAME_WINDOWS = [
    { key: 'hour', env: 'NEW_NAMES_PER_HOUR', s: 3600, words: 'the last hour' },
    { key: 'day', env: 'NEW_NAMES_PER_DAY', s: 86400, words: 'the last 24 hours' },
];
// The live numbers are settings (src/settings.js new_names_per_hour, _per_day): `s`, or the env's.
export function newNameBudget(env, s = settings.resolve(env)) {
    return { hour: s.new_names_per_hour, day: s.new_names_per_day };
}
// A 429 when a window's budget is spent, else null: on a database without migration 0011 only (claimGate), where a name
// past the budget can't be held for approval. With it, the name is held instead (heldWhy).
async function newNameBudgetSpent(env, now, s) {
    const budget = newNameBudget(env, s);
    for (const w of NEW_NAME_WINDOWS) {
        const made = await db.autoNamesSince(env, now - w.s);
        if (made < budget[w.key]) continue;
        console.warn('[NEW_NAME_BUDGET]', `${made} new auto names in ${w.words}; budget ${budget[w.key]} (${w.env}): claim refused`);
        await tell(env, () => alerts.newNameBudgetSpent(env, { window: w.key, words: w.words, made, budget: budget[w.key], setting: w.env, bucket: Math.floor(now / w.s) }));
        const retry = w.key === 'hour' ? 600 : 3600;
        return json({ error: `too many new names were claimed in ${w.words}, across all nodes: try again later`, retry_after: retry }, 429);
    }
    return null;
}

// POST /api/registrar/heal — the owner re-asserts its name (design §2.2). Answers a fresh tunnelToken only when the
// tunnel had to be re-made (a node that already runs the old one keeps running it), and `changed`.
async function handleHeal(request, env, bodyText) {
    const pubkey = await signer(request, env, bodyText);
    if (pubkey instanceof Response) return pubkey;
    let b; try { b = JSON.parse(bodyText || '{}'); } catch { return json({ error: 'bad json' }, 400); }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return badField('the body must be a JSON object');
    const routing = routeProblem(b);
    if (routing) return badField(routing);
    const now = nowS();
    const cur = b.name ? await db.getAllocation(env, String(b.name).toLowerCase()) : await db.getOwnAllocation(env, pubkey);
    if (isOwnRow(cur, pubkey)) dropBadLabels(b, `${cur.name} ${key16(pubkey)}`);
    else { const label = labelProblem(b); if (label) return badField(label); }
    await db.touchContact(env, pubkey, now, requestProto(request));
    if (blockedOut(env, cur, pubkey, now)) return json({ error: 'name blocked' }, 403);
    if (!isOwnRow(cur, pubkey)) return json({ error: 'no name to heal', status: 'none' }, 404);
    if (cur.status === 'blocked') return json({ error: 'name blocked' }, 403);
    if (cur.status === 'released' || cur.status === 'revoked')
        return json({ error: 'name released — claim it to take it back', status: cur.status, name: cur.name }, 409);
    const out = await heal(env, cur, b, now);
    if (out instanceof Response) return out;
    const body = { ...out };
    delete body.newTunnel; delete body.tunnel_id;
    if (body.status === 'live' && out.newTunnel) {
        const token = await tunnelTokenOrNothing(env, out);
        if (token !== undefined) body.tunnelToken = token;
    }
    return json(body);
}

// POST /api/registrar/rotate {name?, origin?} — the owner's name onto a fresh tunnel (M3 of the 2026-10-01 review): a new
// token, and the old tunnel deleted at Cloudflare, so a connector running on a copy of its token (a standby given away,
// a token shown on a screen) is cut off. A copied data folder or backup is NOT: it holds the node key, and /status gives it the new token. `origin` re-points the tunnel at the same time.
// Signed by the name's key, for its own tunnel name that is live, or paused by anything but the admin (then the rotate is
// its heal, on a fresh tunnel). The record at the hostname is kept and re-pointed, never deleted: a resolver that saw the
// name missing would remember that for up to half an hour.
// Row first, as every take-down: the old tunnel leaves the row (a decision) before Cloudflare deletes it, so a request
// that read the row earlier (a heal, the sweep's repair) misses its write rather than route the name onto it again. If
// Cloudflare won't delete it, it goes back on the row and nothing has changed: 503, since its token still works and the
// rotate must not look done. Then the owner's heal (heal()) makes the fresh tunnel, and the answer carries its token. If
// that fails, the old tunnel is gone all the same, and the node's next heal (or the sweep's repair) makes the new one.
// One per name every ROTATE_EVERY_S: each deletes and makes a tunnel at Cloudflare, whose API budget every community's
// claims and heals share, so a key may not churn it. A heal is never held back by it.
const ROTATE_EVERY_S = 300;
async function handleRotate(request, env, bodyText) {
    const pubkey = await signer(request, env, bodyText);
    if (pubkey instanceof Response) return pubkey;
    let b; try { b = JSON.parse(bodyText || '{}'); } catch { return json({ error: 'bad json' }, 400); }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return badField('the body must be a JSON object');
    const routing = routeProblem(b);
    if (routing) return badField(routing);
    const now = nowS();
    const read = () => (typeof b.name === 'string' && b.name
        ? db.getAllocation(env, b.name.toLowerCase())
        : db.getOwnAllocation(env, pubkey));
    const first = await read();
    if (isOwnRow(first, pubkey)) dropBadLabels(b, `${first.name} ${key16(pubkey)}`);
    else { const label = labelProblem(b); if (label) return badField(label); }
    await db.touchContact(env, pubkey, now, requestProto(request));
    return onFreshRow(read, async (cur) => {
        if (blockedOut(env, cur, pubkey, now)) return json({ error: 'name blocked' }, 403);
        if (!isOwnRow(cur, pubkey)) return json({ error: 'no name to rotate', status: 'none' }, 404);
        if (cur.status === 'blocked') return json({ error: 'name blocked' }, 403);
        if (cur.status === 'released' || cur.status === 'revoked')
            return json({ error: 'name released — claim it to take it back (a take-back is on a fresh tunnel)', status: cur.status, name: cur.name }, 409);
        if (cur.status === 'paused' && cur.pause_reason === 'admin') return json({ error: 'paused by the admin' }, 403);
        if (await awaitingApproval(env, cur)) return json({ error: 'awaiting approval: the name has no tunnel yet', status: 'pending', name: cur.name }, 409);
        if ((b.mode === 'tunnel' || b.mode === 'direct' ? b.mode : cur.mode) !== 'tunnel')
            return json({ error: 'a direct name runs no tunnel, so it has no token to rotate: a heal with its new public_ip re-points it' }, 400);
        const last = await db.lastEventAt(env, cur.name, 'rotated');
        if (last !== null && now - last < ROTATE_EVERY_S) {
            const wait = ROTATE_EVERY_S - (now - last);
            return json({ error: `this name was given a new tunnel ${now - last} s ago: one rotate every ${ROTATE_EVERY_S / 60} minutes (try again in ${wait} s)`, retry_after: wait }, 429);
        }
        // A pending row's heal below refuses what the registrar did not make at the name: refused here first, a rotate
        // that changes nothing logs no `rotated` and leaves the name its rotate (NB-6 of the #1985 review).
        if (cur.status === 'pending') {
            let found;
            try { found = await outsidePending(env, cur); }
            catch (e) { return provisionFailed(e); }
            if (found) return (await db.isUnchanged(env, cur.name, cur, { withIds: true })) ? refuseOutside(env, cur.name, pubkey, found, `rotate by key ${key16(pubkey)}`) : null;
        }

        const old = cur.tunnel_id ?? null;
        const dropped = { ...cur, tunnel_id: null, ...decision(cur) };
        if (!(await db.updateIfUnchanged(env, cur.name, cur, { tunnel_id: null, decision_seq: dropped.decision_seq }, { withIds: true }))) return null;
        const kept = old ? await tunnelOff(env, { tunnel_id: old }) : null;
        if (kept) {
            // Recorded on the row again (a tunnel nobody records would block every fresh one for the name), or — the row
            // changed meanwhile — owed, so the sweep deletes it once Cloudflare lets it.
            if (!(await db.updateIfUnchanged(env, cur.name, dropped, { tunnel_id: kept }, { withIds: true })))
                await owe(env, '[ROTATE_LEFT]', cur.name, 'tunnel', kept, 'Cloudflare refused its delete, and the row changed meanwhile');
            console.warn('[ROTATE_REFUSED]', cur.name, `Cloudflare did not delete tunnel ${kept}: nothing rotated`);
            return json({ error: 'Cloudflare did not delete the old tunnel, so nothing changed and its token still works: try again shortly' }, 503);
        }
        await logEvent(env, cur.name, 'rotated', `rotated by its owner ${key16(pubkey)}: ${old ? `tunnel ${old} deleted, so nothing runs on a copy of its token any more` : 'it had no tunnel'}; a fresh one is made now`);
        const out = await heal(env, dropped, b, now);
        if (out instanceof Response) return out;
        const body = { ...out, rotated: true };
        delete body.newTunnel; delete body.tunnel_id;
        if (body.status === 'live') {
            const token = await tunnelTokenOrNothing(env, out);
            if (token !== undefined) body.tunnelToken = token;
        }
        return json(body);
    });
}

// Answers a live tunnel name's token: only to its key, and under v2 only to a request nobody sent before (signer), so a
// captured /status can't be replayed for it.
// `?name=`: the name the node stores, answered about while it is this key's row (a key can hold more than one: an
// install's claim answered after the owner's pick). Without it, or for a name that is not this key's, the key's first
// row as before. Read only when x-bp-signature-query covers it (sign.js signedQuery): a captured /status replayed inside
// the clock window with another `?name=` gets the first row, as before `?name=` existed, never the row it names.
async function handleStatus(request, env) {
    const pubkey = await signer(request, env, '');
    if (pubkey instanceof Response) return pubkey;
    await db.touchContact(env, pubkey, nowS(), requestProto(request));
    const asked = ((await signedQuery(request, '', pubkey)).get('name') || '').toLowerCase();
    const named = NAME_RE.test(asked) ? await db.getAllocation(env, asked) : null;
    // Any state: answering 'none' for a name the node still owns is what made nodes wipe their saved address
    // (2026-09-24 incident).
    const a = named && named.node_pubkey === pubkey ? named : await db.getOwnAllocation(env, pubkey);
    if (!a) return json({ status: 'none' });
    const out = {
        status: a.status, name: a.name, hostname: a.hostname, mode: a.mode, community_name: a.community_name, contact: a.contact,
        reason: await reasonOf(env, a), since: sinceOf(a),
    };
    // Until when this key may take its release back: never one the admin holds from it too ('admin-held-all').
    if (a.status === 'released' && !freedAtOnce(a) && !heldFromAll(a)) out.held_until = (a.released_at || 0) + releaseCooloffS(env);
    if (a.status === 'live') {
        const token = await tunnelTokenOrNothing(env, a);
        if (token !== undefined) out.tunnelToken = token;
        // Routed, but not yet listed: the node's directory push waits until this is gone (onProbation).
        if (onProbation(a)) out.probation = true;
    }
    return json(out);
}

// POST /api/registrar/holder {name} — who holds this name? (design scratch/registrar/DESIGN-lost-name-audience-opus.md
// §5.1). A node asks about a name it held; it stops accepting that name only when this answer names ANOTHER key and
// that key answers at the name too (the node's side, L3), so this answers from the same rules a claim is decided by
// (holdsName, isOwnRow, policyTier), and nothing else:
//   'you'      the asker's key holds it: any state that holds a name (blocked and paused included), or its own
//              release still inside the hold;
//   'other'    another key holds it, on the same terms: `holder_key` is that key — the only answer that names one;
//   'reserved' nobody holds it, and policy keeps it from every claim (our fleet's names); or, to the key the admin
//              blocked (or paused) and then released, its old name while that release holds it from every key;
//   'free'     nobody holds it: no row, a release past its hold or freed at once, abandoned.
// 'you' also says `state` (the row's status), `since` (when this key's tenure began: its claim or its take-back), and
// `held_until` for its release still inside the hold. 'other' says only whose it is — { name, held, holder_key } —
// never another community's moderation state (blocked, paused), when it claimed, or when its hold ends: the answer
// goes to any key, and L3 needs no more (r4117741404). A key a name routes to is public already (its node's
// /api/attest answers anyone); a gated claim's key still waiting for approval is not, and is named here all the same,
// as L3's "another key holds it" needs it.
// Signed like /status. A POST, so the name is inside the signed bytes (the signature covers the path, not the query).
// Read-only: it writes nothing but a v2 request's nonce (signer) — not even the contact every other signed request
// records (the node's own /status does that) — and asks nothing of Cloudflare or of any node. An older Worker answers
// 404: a node that gets that learns nothing, and drops nothing.
async function handleHolder(request, env, bodyText) {
    const pubkey = await signer(request, env, bodyText);
    if (pubkey instanceof Response) return pubkey;
    let b; try { b = JSON.parse(bodyText || '{}') || {}; } catch { return json({ error: 'bad json' }, 400); }
    const name = typeof b.name === 'string' ? b.name.toLowerCase() : '';
    if (!NAME_RE.test(name)) return json({ error: 'invalid name (3–32; a–z 0–9 -; no leading/trailing hyphen)' }, 400);
    const now = nowS();
    const row = await db.getAllocation(env, name);
    // The key the admin blocked (or paused), its name released by the admin and held from it too: nobody it may claim.
    if (blockedOut(env, row, pubkey, now)) return json({ name, held: 'reserved' });
    if (holdsName(env, row, now)) {
        if (!isOwnRow(row, pubkey)) return json({ name, held: 'other', holder_key: row.node_pubkey });
        return json({
            name, held: 'you', state: row.status, since: row.requested_at ?? null,
            ...(row.status === 'released' ? { held_until: (row.released_at || 0) + releaseCooloffS(env) } : {}),
        });
    }
    return json({ name, held: (await db.policyTier(env, name)) === 'blocked' ? 'reserved' : 'free' });
}

async function handleUpdate(request, env, bodyText) {
    const pubkey = await signer(request, env, bodyText);
    if (pubkey instanceof Response) return pubkey;
    await db.touchContact(env, pubkey, nowS(), requestProto(request));
    let b; try { b = JSON.parse(bodyText || '{}'); } catch { return json({ error: 'bad json' }, 400); }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return badField('the body must be a JSON object');
    // `name`: the name the node stores (SEC-REG-02, verified 2026-10-16) — a key can hold more than one, and the newest
    // is not always the one in use. Served only while it is this key's and held for use (pending, live, paused: the
    // states getAllocationByPubkey reads); anything else is a 404, another key's row untouched. Without it (older nodes),
    // the key's newest such row, as before.
    const asked = typeof b.name === 'string' && b.name ? b.name.toLowerCase() : null;
    const a = asked
        ? (NAME_RE.test(asked) ? await db.getAllocation(env, asked) : null)
        : await db.getAllocationByPubkey(env, pubkey);
    if (!a || a.node_pubkey !== pubkey || !['pending', 'live', 'paused'].includes(a.status)) return json({ error: 'allocation not found' }, 404);
    // An update of the key's own name: a bad label is dropped, not a reason to refuse (the rest still applies).
    const problem = dropBadLabels(b, `${a.name} ${key16(pubkey)}`);
    if (problem) return badField(problem);
    const updates = {};
    const commVal = b.community_name !== undefined ? b.community_name : b.communityName;
    if (commVal !== undefined) {
        updates.community_name = typeof commVal === 'string' && commVal.trim() ? commVal.trim() : null;
    }
    if (b.contact !== undefined) {
        updates.contact = typeof b.contact === 'string' && b.contact.trim() ? b.contact.trim() : null;
    }
    if (Object.keys(updates).length > 0) {
        await db.updateAllocation(env, a.name, updates);
    }
    return json({ status: 'ok', name: a.name, ...updates });
}

// Tunnel and DNS go; the row stays, 'released', and `by` (its pause_reason) says whether it holds the name:
//   'owner'      its owner's release: held for the same key RELEASE_COOLOFF_S (that key may take it back), then free;
//   'admin-held' the admin's release, by default: held the same way (decision D-C, Marty 2026-09-28 — a name the
//                admin frees, by a misclick or otherwise, must not pass to another key while members' apps still
//                use it);
//   'admin-held-all' the admin's default release of a name it had blocked or paused: held RELEASE_COOLOFF_S from
//                every key, its own included (heldFromAll), then free;
//   'admin'      the admin's release with "free now", for a name being freed for someone new — and a gated claim
//                nobody approved, rejected by the admin: free at once (to anyone, the old key included);
//   'withdrawn'  a gated claim nobody approved, withdrawn by its key: free at once.
// 'admin' is what every admin release wrote before D-C, so those rows stay free, and a Worker rolled back past D-C
// reads 'admin-held' and 'admin-held-all' as an owner's release: held for its key. The row is written first
// (stopRouting); false, with nothing done, if it changed since `a` was read. `actor`: who the admin is (actorOf).
async function releaseRow(env, a, by, now, actor = ADMIN) {
    const to = { status: 'released', released_at: now, pause_reason: by, paused_at: null, attest_fails: 0 };
    if (!(await stopRouting(env, a, to))) return false;
    const days = `${Math.round(releaseCooloffS(env) / 86400)} days`;
    const held = `held ${days} for`;
    await logEvent(env, a.name, 'released', ({
        admin: `released by ${actor} (was ${a.status}): free now`,
        'admin-held': `released by ${actor} (was ${a.status}): ${held} key ${key16(a.node_pubkey)}, then free`,
        'admin-held-all': `released by ${actor} (was ${a.status}): held ${days} from every key, its own ${key16(a.node_pubkey)} included, then free`,
        withdrawn: `withdrawn by its key ${key16(a.node_pubkey)} before the admin approved it: free now`,
    })[by] ?? `released by its owner ${key16(a.node_pubkey)} (was ${a.status}): ${held} that key, then free`);
    return true;
}

// A decision taken on the row as read, re-taken (up to 3 times) on the row as it now is when its first write finds
// the row changed — `act` answers null then.
async function onFreshRow(read, act) {
    for (let i = 0; i < 3; i++) {
        const r = await act(await read());
        if (r) return r;
    }
    return json({ error: 'the name kept changing; try again' }, 409);
}

// POST /api/registrar/release (and /offline, its old name) — signed by the owner.
async function handleRelease(request, env, bodyText) {
    const pubkey = await signer(request, env, bodyText);
    if (pubkey instanceof Response) return pubkey;
    let b = {}; try { b = JSON.parse(bodyText || '{}') || {}; } catch { /* /offline has always taken any body */ }
    const now = nowS();
    await db.touchContact(env, pubkey, now, requestProto(request));
    const read = () => (typeof b.name === 'string' && b.name
        ? db.getAllocation(env, b.name.toLowerCase())
        : db.getOwnAllocation(env, pubkey));
    return onFreshRow(read, async (a) => {
        if (blockedOut(env, a, pubkey, now)) return json({ error: 'name blocked' }, 403);
        if (!isOwnRow(a, pubkey)) return json({ status: 'none' });
        if (a.status === 'blocked') return json({ error: 'name blocked' }, 403);
        // An admin pause is the admin's to lift (resume, or the admin's own release, which holds the name from this
        // key too). Released by its owner, it would be gone, and the owner's next claim a take-back: live again with
        // no resume.
        if (a.status === 'paused' && a.pause_reason === 'admin') return json({ error: 'paused by the admin' }, 403);
        if (a.status === 'released') return json({ status: 'released', name: a.name, held_until: (a.released_at || now) + releaseCooloffS(env) });
        // A gated claim the admin never approved was never this key's name: nothing to hold it for.
        if (await awaitingApproval(env, a))
            return (await releaseRow(env, a, 'withdrawn', now)) ? json({ status: 'released', name: a.name }) : null;
        return (await releaseRow(env, a, 'owner', now)) ? json({ status: 'released', name: a.name, held_until: now + releaseCooloffS(env) }) : null;
    });
}

// Constant-time string comparison to prevent timing attacks on secret checks.
export function timingSafeEqualStrings(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = new TextEncoder().encode(a);
    const bufB = new TextEncoder().encode(b);
    let result = bufA.length ^ bufB.length;
    const len = Math.max(bufA.length, bufB.length);
    for (let i = 0; i < len; i++) {
        const byteA = i < bufA.length ? bufA[i] : 0;
        const byteB = i < bufB.length ? bufB[i] : 0;
        result |= byteA ^ byteB;
    }
    return result === 0;
}

// --- Admin ---
// Every action is logged in name_events. None of them frees a name except `release`.
const checkAdmin = (request, env) =>
    !!env.ADMIN_SECRET && timingSafeEqualStrings(request.headers.get('x-admin-secret'), env.ADMIN_SECRET);

// Who is the admin on this request: Cloudflare Access when any ACCESS_* var is set (src/access.js) — the email its signed
// token names, and ADMIN_SECRET opens nothing (one way in, not two); with none set (a self-hoster with no Access in
// front, README "Admin sign-in"), the ADMIN_SECRET header, as before. { email } (null by the secret), or null: refused.
async function adminIdentity(request, env) {
    if (!accessMode(env)) return checkAdmin(request, env) ? { email: null } : null;
    const who = await accessIdentity(request, env);
    if (who.email) return { email: who.email };
    console.warn('[ADMIN_ACCESS] refused:', who.error);
    return null;
}
// Who did it, in the events and alerts: the email Access signed in, or "the admin" (the secret names nobody).
const ADMIN = 'the admin';
const actorOf = (who) => who?.email || ADMIN;
// A refusal says how to sign in when it is Access (the page shows that, not a secret box); the secret's says nothing.
const unauthorized = (env) => json({ error: 'unauthorized', ...(accessMode(env) ? { sign_in: 'cloudflare-access' } : {}) }, 401);
// Access signs the admin in with a cookie, which a browser also sends with a form another site posts here. So, under
// Access, an admin POST must carry a header no other site can make a browser send (x-bp-admin: 1, as the page sends),
// and an Origin, when it has one, of this site. (The secret is such a header already.)
const crossSite = (request, url) => request.headers.get('x-bp-admin') !== '1'
    || (request.headers.has('origin') && request.headers.get('origin') !== url.origin);

// The admin's action whose write missed (the row changed while it was at Cloudflare): undone, and nothing done.
async function adminMissed(env, name, ids) {
    const now = await undo(env, name, ids);
    return json({ error: 'the name changed meanwhile; nothing was done', status: now?.status ?? null }, 409);
}

// The admin lifting a pause (any reason) or a block, routed by heal's rule (routeIfOnlyOwner): at once on a fresh
// tunnel, a kept one (or a direct address) only on an edge re-attest the owner's key signed. The tunnel kept by a
// block, or by a pause the admin didn't make (the sweep's, a take-back's, the incident's), is deleted first, as a
// take-back's is, so resume is on a fresh one whose token only the owner's signed /status gets; one Cloudflare
// still won't delete is re-attested. The admin's own pause keeps its tunnel: its node is still on it. Not routed:
// the admin's hold is lifted all the same, and the name stays paused for its key until its heal passes the
// re-attest.
// Row first, as the other admin actions: resume is recorded (decision_seq) only over the row as read, so a request
// that read it earlier misses its writes, and an owner's heal that went live first makes resume decide again on the
// row as it now is (onFreshRow) rather than delete the tunnel that heal is live on. The same write takes a tunnel
// about to be deleted off the row, so a heal reading it meanwhile can't go live on it; one Cloudflare won't delete
// goes back on the row.
async function adminResume(env, a, was, now, actor) {
    const drop = !!a.tunnel_id && !(a.status === 'paused' && a.pause_reason === 'admin');
    const first = { ...decision(a), ...(drop ? { tunnel_id: null } : {}) };
    if (!(await db.updateIfUnchanged(env, a.name, a, first, { withIds: true }))) return null;
    const cur = { ...a, ...first };
    const left = drop ? (await deprovision(env, { tunnel_id: a.tunnel_id })).tunnel_id : null;
    if (left) {
        if (!(await db.updateIfUnchanged(env, a.name, cur, { tunnel_id: left }, { withIds: true }))) {
            // Changed meanwhile: resume stops. The tunnel is recorded on the row as it now is, while that is still
            // this tenure and records none — a tunnel nobody records would block every fresh one for the name.
            const fresh = await db.getAllocation(env, a.name);
            const kept = fresh?.node_pubkey === a.node_pubkey && fresh.requested_at === a.requested_at && !fresh.tunnel_id
                && await db.updateIfUnchanged(env, a.name, fresh, { tunnel_id: left }, { withIds: true });
            if (!kept) await owe(env, '[RESUME_ORPHAN]', a.name, 'tunnel', left, 'Cloudflare refused its delete and no row records it');
            return adminMissed(env, a.name, NOTHING);
        }
        cur.tunnel_id = left;
    }
    let ids;
    try { ids = await ensure(env, cur, cur); } catch (e) { return e.raced ? adminMissed(env, a.name, NOTHING) : provisionFailed(e, { admin: true }); }
    const made = recorded(ids, cur);
    if (!(await db.updateIfUnchanged(env, a.name, cur, made, { withIds: true }))) return adminMissed(env, a.name, ids);
    const res = { ...cur, ...made };
    const g = await routeIfOnlyOwner(env, res, ids, now);
    if (g.missed) return adminMissed(env, a.name, ids);
    if (g.live) {
        await logEvent(env, a.name, 'resumed', `resumed by ${actor} (was ${was})${g.attest ? ': edge re-attest ok' : ': on a fresh tunnel'}`);
        return json({ status: 'live', name: a.name, changed: ids.changed, ...(g.attest ? { attest: g.attest } : {}) });
    }
    const reason = g.verdict === 'impostor' ? 'impostor' : 'unverified';
    const held = { status: 'paused', pause_reason: reason, paused_at: a.status === 'paused' ? a.paused_at : now, dns_record_id: g.dns_record_id };
    if (!(await db.updateIfUnchanged(env, a.name, res, held, { withIds: true }))) return adminMissed(env, a.name, ids);
    await logEvent(env, a.name, 'resume-refused', `resumed by ${actor} (was ${was}), but not routed: edge re-attest ${g.verdict} (${g.why}); paused/${reason} for ${key16(a.node_pubkey)}, whose heal re-attests`);
    return json({ status: 'paused', name: a.name, reason, attest: g.verdict, why: g.why });
}

// Approve: a pending claim goes live at once, as any new claim does (its tunnel is made now).
async function adminGoLive(env, a, event, detail, extra = {}) {
    let ids;
    try { ids = await ensure(env, a, a); } catch (e) { return e.raced ? adminMissed(env, a.name, NOTHING) : provisionFailed(e, { admin: true }); }
    const live = { ...recorded(ids, a), ...LIVE, ...extra, ...(a.held_reason ? { held_reason: null } : {}) };
    if (!(await db.updateIfUnchanged(env, a.name, a, live, { withIds: true }))) return adminMissed(env, a.name, ids);
    await logEvent(env, a.name, event, detail);
    return json({ status: 'live', name: a.name, changed: ids.changed });
}

// Pause, block and release write the row first, and only while it is as read: if it changed in between, the action
// is decided again on the row as it now is (onFreshRow). `opts.freeNow`: release frees the name at once.
// What the admin did reaches the admin's phone too, as the Worker answered it (A5; a resume whose re-attest failed says so).
// `opts.who`: the admin (adminIdentity), named in the events and the alert.
async function handleAdmin(env, name, action, opts = {}) {
    const res = await onFreshRow(() => db.getAllocation(env, name), (a) => (a ? adminAction(env, a, action, nowS(), opts) : json({ error: 'unknown name' }, 404)));
    if (res.status === 200) await tell(env, async () => alerts.adminDid(env, name, action, await res.clone().json(), opts.who?.email));
    return res;
}

async function adminAction(env, a, action, now, { freeNow = false, who = null } = {}) {
    const actor = actorOf(who);
    const name = a.name;
    const was = `${a.status}${a.pause_reason ? `/${a.pause_reason}` : ''}`;
    switch (action) {
        case 'approve':
            if (a.status !== 'pending') return json({ error: 'not pending' }, 400);
            {
                // The claim's first ensure(): it takes over nothing the registrar did not make (takeName says why), but
                // what an earlier approve of it made before it stopped is its own (NB-2 of the #1985 review).
                let found;
                try { found = await outsidePending(env, a); }
                catch (e) { return provisionFailed(e, { admin: true }); }
                if (found) return refuseOutside(env, name, a.node_pubkey, found, `approve by ${actor}`);
            }
            // An auto name pending is one still being made ("Setting up", "Finish now"): nobody's approval was needed, and
            // it stays auto (it counts in the new-name budget as the claim that made it would have).
            if (!(await awaitingApproval(env, a)))
                return adminGoLive(env, a, 'healed', `finished by ${actor} (an auto name: its claim's provisioning had not finished)`, { decided_at: now, decided_by: 'auto' });
            return adminGoLive(env, a, 'approved', `approved by ${actor}`, { decided_at: now, decided_by: 'admin' });
        case 'pause': {
            // Routing off, name and tunnel kept; its owner can neither heal nor release it — only `resume` (or `release`,
            // which then holds the name from every key, its own included).
            if (a.status !== 'live' && a.status !== 'paused') return json({ error: `cannot pause a ${a.status} name` }, 400);
            const to = { status: 'paused', pause_reason: 'admin', paused_at: a.status === 'paused' ? a.paused_at : now };
            if (!(await stopRouting(env, a, to, { keepTunnel: true, byHostname: true }))) return null;
            await logEvent(env, name, 'paused', `paused by ${actor} (was ${was})`);
            return json({ status: 'paused', name, reason: 'admin' });
        }
        case 'resume':
            if (a.status !== 'paused' && a.status !== 'blocked') return json({ error: `cannot resume a ${a.status} name` }, 400);
            return adminResume(env, a, was, now, actor);
        case 'block':
        case 'revoke': {
            // The kill switch. Routing and tunnel go; the name is held, never free — an impostor must not inherit a
            // name the admin killed (design §2.1). The admin's release of it holds it from every key, this one included,
            // before it is free. `revoke` is its old name. Blocking a blocked name again removes whatever routing is
            // still there, and stands against a resume in flight.
            if (a.status === 'blocked') {
                if (!(await stopRouting(env, a, null, { byHostname: true }))) return null;
                await logEvent(env, name, 'blocked', `blocked again by ${actor}: any routing left removed`);
                return json({ status: 'blocked', name });
            }
            if (!(await stopRouting(env, a, { status: 'blocked', pause_reason: 'admin', paused_at: now }, { byHostname: true }))) return null;
            await logEvent(env, name, 'blocked', `blocked by ${actor} (was ${a.status}); key ${key16(a.node_pubkey)}`);
            return json({ status: 'blocked', name });
        }
        case 'release': {
            // Held RELEASE_COOLOFF_S by default, unless the admin frees it now (releaseRow): for its key, as its owner's
            // own release is — or, for a name the admin had blocked or paused, from every key, that one included
            // (`reason` says so). A gated claim nobody approved was never its key's: rejecting it frees the name at
            // once, as its key's own withdrawal does. A release already held stays as it is, its hold running from
            // when it began, until the admin frees it now.
            if (a.status === 'abandoned' || freedAtOnce(a)) return json({ status: 'released', name });
            const atOnce = freeNow || await awaitingApproval(env, a);
            const held = (by, at) => ({ ...(by === 'admin-held-all' ? { reason: by } : {}), held_until: at + releaseCooloffS(env) });
            if (a.status === 'released' && !atOnce) return json({ status: 'released', name, ...held(a.pause_reason, a.released_at || 0) });
            const by = atOnce ? 'admin' : (stoppedByAdmin(a) ? 'admin-held-all' : 'admin-held');
            if (!(await releaseRow(env, a, by, now, actor))) return null;
            return json({ status: 'released', name, ...(atOnce ? {} : held(by, now)) });
        }
        case 'forget':
            return forgetRow(env, a, now, actor);
    }
    return json({ error: 'unknown action' }, 400);
}

// --- Remove from the list ---
// A released name nobody holds any more (holdsName) and no key can take back as its own (isOwnRow) — freed at once, or
// the admin's release from every key past its hold — becomes 'abandoned': it leaves the admin's list (db.listActive)
// and stays free to anyone, as it already was. Removing changes nothing about who may claim the name — only what the
// list shows; its history stays in name_events. Refused (409) for every other row: a name someone holds (live,
// pending, paused, blocked), a release still inside its hold, and an owner's or 'admin-held' release past its hold,
// which its old key still takes back as its own (live again without the admin's approval, outside the new-name
// budget: abandoned, that key would be a new claimant — r4302742456). "Free now" first, which says what it frees and
// ends that take-back on purpose. Whatever the row still records at Cloudflare — a delete Cloudflare refused at the
// release — goes first, row first as every take-down's does (stopRouting): what Cloudflare refuses again stays on the
// row and is owed (teardown), the tunnel too, so the sweep retries it and a later claim of the name deletes it as its own.
async function forgetRow(env, a, now, actor = ADMIN) {
    const name = a.name;
    // Removed already (a double click, another tab): nothing done, and it says so — no event, no alert, not counted.
    if (a.status === 'abandoned') return json({ status: 'abandoned', name, already: true });
    if (a.status !== 'released')
        return json({ error: `${name} is ${a.status}: only a released name nobody holds can be removed from the list`, status: a.status }, 409);
    if (holdsName(env, a, now)) {
        const until = (a.released_at || 0) + releaseCooloffS(env);
        return json({ error: `${name} is still held (${a.pause_reason || 'released'}) until ${new Date(until * 1000).toISOString()}: free it now first`, status: a.status, held_until: until }, 409);
    }
    if (isOwnRow(a, a.node_pubkey))
        return json({ error: `${name} can still be taken back by the key that released it (${a.pause_reason || 'released'}): free it now first`, status: a.status, takes_back: true }, 409);
    const had = [a.tunnel_id && 'tunnel', a.dns_record_id && 'DNS record'].filter(Boolean);
    if (!(await stopRouting(env, a, { status: 'abandoned' }))) return null;
    const after = await db.getAllocation(env, name);
    if (after?.status === 'abandoned') await owe(env, '[FORGET_LEFT]', name, 'tunnel', after.tunnel_id);
    const left = after?.status === 'abandoned' ? [after.tunnel_id && 'tunnel', after.dns_record_id && 'DNS record'].filter(Boolean) : [];
    const freeSince = freedAtOnce(a) ? (a.released_at || 0) : (a.released_at || 0) + releaseCooloffS(env);
    await logEvent(env, name, 'removed', `removed from the list by ${actor} (was released/${a.pause_reason || '—'}, free since `
        + `${new Date(freeSince * 1000).toISOString()}): abandoned, free to anyone as it was`
        + (had.length ? `; its leftover ${had.join(' and ')} ${left.length ? `deleted, but Cloudflare refused the ${left.join(' and ')}: owed, the sweep retries` : 'deleted at Cloudflare'}` : ''));
    return json({ status: 'abandoned', name });
}

// The bulk form: the names the admin's list showed as removable, each decided as its own forget is (onFreshRow), at
// most FORGET_MAX a request (the page sends them in batches). Answers which were removed, which were refused and why,
// and (`already`, only when there are any) which were removed before; the admin's phone hears of the removed once. FORGET_MAX keeps one request inside D1's smallest per-invocation budget
// (50 queries on Workers Free): a forget is about 6 queries, its one alert about 10.
// "Free all and remove" ({ "free_now": true }; Marty, 2026-10-18: every July test name gone, most of them released by
// their own key, which forget refuses while that key can take them back): each released name is first freed as its
// own "Free now" frees it — adminAction's release, free now, so its old key's take-back ends, with its 'released'
// event — then removed as above. Any other row is refused untouched, as forget refuses it. Free and forget together are
// 11 to 14 queries a name, and the alert about 10 (measured): 2 names a request stay under 35 even when Cloudflare
// refuses every delete (3 reach 48). The page sends its click's names in such batches with one `run` id and their
// `total`: the admin's phone hears of the click once (alerts.adminFreedAll), not of every batch — 45 names are 23
// requests, past the hourly cap of 20. A request with no run is told as Remove all released's is.
const FORGET_MAX = 5;
const FREE_FORGET_MAX = 2;
const RUN_RE = /^[A-Za-z0-9-]{8,64}$/;
async function handleForgetMany(env, bodyText, who = null) {
    let b; try { b = JSON.parse(bodyText || '{}'); } catch { return json({ error: 'bad json' }, 400); }
    const freeNow = b?.free_now === true;
    const max = freeNow ? FREE_FORGET_MAX : FORGET_MAX;
    const names = Array.isArray(b?.names) ? [...new Set(b.names.map((n) => String(n).toLowerCase()))] : null;
    if (!names || !names.length || names.length > max || !names.every((n) => NAME_RE.test(n)))
        return json({ error: `names must be 1 to ${max} names` }, 400);
    const run = freeNow && typeof b.run === 'string' && RUN_RE.test(b.run) ? b.run : null;
    const total = Number.isInteger(b.total) && b.total > 0 && b.total <= 100000 ? b.total : null;
    const actor = actorOf(who);
    const removed = [];
    const refused = [];
    const already = [];
    const freed = [];
    for (const name of names) {
        const res = await onFreshRow(() => db.getAllocation(env, name), async (a) => {
            if (!a) return json({ error: 'unknown name' }, 404);
            if (freeNow && a.status === 'released' && !freedAtOnce(a)) {
                const out = await adminAction(env, a, 'release', nowS(), { freeNow: true, who });
                if (!out) return null;   // changed meanwhile: decided again on the row as it now is
                if (out.status !== 200) return out;
                if (!freed.includes(name)) freed.push(name);
                a = await db.getAllocation(env, name);
                if (!a) return json({ error: 'unknown name' }, 404);
            }
            return forgetRow(env, a, nowS(), actor);
        });
        const out = await res.json();
        if (res.status !== 200) refused.push({ name, ...out });
        else (out.already ? already : removed).push(name);
    }
    if (removed.length) await tell(env, () => (run
        ? alerts.adminFreedAll(env, { who: who?.email, run, total })
        : alerts.adminRemoved(env, removed, { who: who?.email, freed: freed.filter((n) => removed.includes(n)).length })));
    return json({ removed, refused, ...(already.length ? { already } : {}), ...(freeNow ? { freed } : {}) });
}

// --- Switchboard (Invite resolution / trampoline) ---
// A paused community still exists (the app shows it unreachable, which is true), so its invites still resolve;
// a released, abandoned or blocked name's do not. Nor do a name's on probation (onProbation): beanpool.org vouches for
// a new name only once it has answered as its own node for a while (design §4.3.2).
const routesInvites = (alloc) => !!alloc && (alloc.status === 'live' || alloc.status === 'paused') && !onProbation(alloc);

// `?n=` names the node to join, as a label or a hostname. Only a name this registrar holds live is answered, and only
// at its own hostname; anything else is refused (null), never sent on: beanpool.org must not vouch for a host it doesn't
// route (M2 of the 2026-10-01 review — `?n=` sent the app's join flow to any server, under a beanpool.org link).
async function liveHostname(env, queryN) {
    const base = `.${env.BASE_DOMAIN || 'beanpool.org'}`;
    const label = queryN.endsWith(base) ? queryN.slice(0, -base.length) : queryN;
    if (!NAME_RE.test(label) || !env.DB) return null;
    try {
        const alloc = await db.getAllocation(env, label);
        return alloc?.status === 'live' && !onProbation(alloc) && alloc.hostname === `${label}${base}` ? alloc.hostname : null;
    } catch { return null; }
}

async function resolveNodeHostname(env, code, queryN) {
    if (queryN) return liveHostname(env, queryN);
    if (!code) return null;

    if (env.DB) {
        try {
            const invite = await db.getInvite(env, code);
            if (invite && invite.node_name) {
                const alloc = await db.getAllocation(env, invite.node_name);
                if (routesInvites(alloc)) {
                    if (alloc.hostname) return alloc.hostname;
                    return `${invite.node_name}.${env.BASE_DOMAIN || 'beanpool.org'}`;
                }
            }
        } catch { /* ignore */ }

        try {
            const alloc = await db.getAllocation(env, code.toLowerCase());
            if (routesInvites(alloc) && alloc.hostname) {
                return alloc.hostname;
            }
        } catch { /* ignore */ }
    }
    return null;
}

async function handleSwitchboard(url, env) {
    const code = decodeURIComponent(url.pathname.replace(/^\/i\//, '')).trim();
    const queryN = (url.searchParams.get('n') || '').trim().toLowerCase();

    const hostname = await resolveNodeHostname(env, code, queryN);
    if (!hostname) {
        const errHtml = `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>Invite Not Found</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1.25rem;text-align:center;color:#1f2937}
.card{background:#f9fafb;border:1px solid #e5e7eb;border-radius:.75rem;padding:2rem;margin-top:2rem}
h1{font-size:1.5rem;color:#dc2626}</style></head><body>
<h1>🫘 Invite code not found</h1>
<div class=card>
<p>The invite code you followed is invalid, expired, or unmapped.</p>
<p>Please check your link or ask the node operator for a fresh invite.</p>
</div>
</body></html>`;
        return new Response(errHtml, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    const scheme = `beanpool://join?node=${encodeURIComponent(hostname)}&code=${encodeURIComponent(code)}`;
    const html = `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>Join on beanpool</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1.25rem;text-align:center;color:#1f2937}
.btn{display:block;margin:.75rem 0;padding:.9rem;border-radius:.75rem;background:#10b981;color:#fff;text-decoration:none;font-weight:700}
.muted{color:#6b7280;font-size:.9rem}</style></head><body>
<h1>🫘 You're invited</h1>
<p>Open the invite in the beanpool app.</p>
<a class=btn href="${scheme}">Open in beanpool</a>
<a class=btn href="https://apps.apple.com/app/beanpool">Get it on the App Store</a>
<a class=btn href="https://play.google.com/store/apps/details?id=org.beanpool">Get it on Google Play</a>
<p class=muted>${hostname ? 'Community node: ' + hostname : ''}</p>
</body></html>`;
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// --- Attestation ---
// Three verdicts, and only one of them is evidence against a node. On 2026-09-24 a Worker that could not verify
// the nodes' signing format called every node a 'mismatch' and revoked two names; so now (design:
// scratch/registrar/DESIGN-2026-09-24-fable.md §2.3):
//   'ok'           — the registered key signed our nonce, recently.
//   'impostor'     — a fresh attest for our nonce whose signature VERIFIES under a key that is not the registered
//                    one: proof that another node answers at this hostname. The only verdict that counts.
//   'unverifiable' — everything else: unreachable, timeout, non-2xx, not JSON, not an attest for our nonce, stale,
//                    or a signature that verifies under no key we can check (an unknown signing format, or a
//                    `proto` this Worker doesn't speak). That is what a sleeping solar node, a format drift, or a
//                    bug on OUR side looks like — never evidence.
// Content that isn't an attest at all — a 2xx that is not JSON, or JSON with no signature: a page, so something other
// than a BeanPool node answers at the name (a stranger's server at a direct name's old IP address, a connector on a
// copy of the tunnel's token) — is unverifiable here too, and carries `swap: true`. A BeanPool node never answers it:
// its /api/attest is an attest, or a 4xx/5xx. It is evidence only slowly, over an hour of sweeps (design D2:
// applyVerdict).
const ATTEST_TIMEOUT_MS = 15_000;

async function classify(env, a) {
    const nonce = crypto.randomUUID();
    let res;
    try {
        res = await fetch(`https://${a.hostname}/api/attest?nonce=${encodeURIComponent(nonce)}`, {
            cf: { cacheTtl: 0 }, headers: { 'user-agent': 'beanpool-registrar-attest' },
            signal: AbortSignal.timeout(ATTEST_TIMEOUT_MS),
        });
    } catch { return { verdict: 'unverifiable', why: 'unreachable' }; }
    if (!res.ok) return { verdict: 'unverifiable', why: `http ${res.status}` };
    let j;
    try { j = await res.json(); } catch { return { verdict: 'unverifiable', why: 'not json', swap: true }; }
    const signer = typeof j?.pubkey === 'string' ? j.pubkey.toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(signer) || j.nonce !== nonce || typeof j.signature !== 'string')
        return { verdict: 'unverifiable', why: 'not an attest for this nonce', swap: typeof j?.signature !== 'string' };
    const ts = parseInt(j.timestamp, 10);
    if (!ts || Math.abs(nowS() - ts) > 120) return { verdict: 'unverifiable', why: 'stale timestamp' };
    const proto = protoOf(j.proto);   // the signing protocol the node names; none = the default
    if (!proto) return { verdict: 'unverifiable', why: `unknown proto ${JSON.stringify(j.proto).slice(0, 24)}` };
    if (!(await verifyEd25519(signer, attestMessage(proto, nonce, j.timestamp), j.signature)))
        return { verdict: 'unverifiable', why: 'signature does not verify' };
    if (signer === String(a.node_pubkey).toLowerCase()) return { verdict: 'ok' };
    return { verdict: 'impostor', why: `valid signature by ${signer.slice(0, 16)}…` };
}

export async function attestOne(env, a) {
    return (await classify(env, a)).verdict;
}

// Did something other than the name's own node answer? Another node's key, or a page (design D2).
const foreign = (r) => r.verdict === 'impostor' || !!r.swap;
// Is a run of foreign answers open on the row?
const runOpen = (a) => !!(a.attest_fails || a.swap_fails);

// What answers at a live name in this sweep: classify, and while a run is open on the row, an 'ok' is asked again, up to
// RUN_ASKS answers in all. Two connectors on one tunnel — its node's, and one on a copy of its token — share the name's
// visitors between them, so the owner's own answer must not hide the other's (M3 of the 2026-10-01 review: with one
// ask a sweep, a run of impostor answers was ended by every 'ok' in between, and never paused). The first foreign
// answer is the sweep's; three of the node's own end the run. A name with no run open is asked once.
const RUN_ASKS = 3;
async function sight(env, a) {
    const r = await classify(env, a);
    if (r.verdict !== 'ok' || !runOpen(a)) return r;
    for (let i = 1; i < RUN_ASKS; i++) {
        const again = await classify(env, a);
        if (foreign(again)) return { ...again, why: `${again.why}, between answers from its own key` };
    }
    return r;
}

// How many sweeps in a row of foreign answers pause a name for a content swap: SWAP_FAIL_LIMIT, 12 unless set (design
// D2 = b, Marty 2026-09-24: about an hour of sweeps every 5 minutes).
export function swapFailLimit(env) {
    return settings.resolve(env).swap_fail_limit;   // the live number is a setting (src/settings.js); the sweep reads it from D1
}

// Is this sweep's picture of the world believable? (design §2.4) If not, the registrar assumes it is the one at
// fault and acts on no row.
//   - the canary (CANARY_NAME, one of our own nodes) must be live and 'ok'. Unset = no canary check.
//   - foreign answers (impostors and content swaps together, design §2.4) must not exceed max(2, 10% of live): real
//     ones are rare and independent; many at once is us. Nor may every live name have one: max(2, …) can't be
//     exceeded while live <= 2, and a small fleet (the live set after 09-24) is where a key-comparison or parsing bug
//     would otherwise pause every name.
//   - unverifiable must not exceed half of live: a registrar that can't see most of the world shouldn't trust
//     what it thinks it sees in the rest.
// verifiedSweep: an applied sweep in which the verifier was seen working — the canary 'ok', or with no canary
// configured at least one name 'ok'. Only such a sweep counts a content swap (design D2: "the canary passed in every
// one of them").
function judgeSweep(env, results) {
    const count = (v) => results.filter((r) => r.verdict === v).length;
    const s = {
        live: results.length, ok: count('ok'), unverifiable: count('unverifiable'), impostor: count('impostor'),
        content_swap: results.filter((r) => r.swap).length,
    };
    const many = s.impostor + s.content_swap;
    const canary = env.CANARY_NAME ? results.find((r) => r.a.name === env.CANARY_NAME) : null;
    if (env.CANARY_NAME && canary?.verdict !== 'ok') s.action = 'suspended:canary';
    else if (many > Math.max(2, s.live * 0.1) || (s.live > 0 && many === s.live)) s.action = 'suspended:mass';
    else if (s.unverifiable > s.live / 2) s.action = 'suspended:unverifiable';
    else s.action = 'applied';
    return s;
}
const verifiedSweep = (env, s) => s.action === 'applied' && (env.CANARY_NAME ? true : s.ok > 0);

// Phase 2 for one row. Re-reads it first, so a verdict is only ever applied to the allocation that was attested,
// not one the owner re-claimed or released while the sweep ran. Two runs are counted, over applied sweeps in a row:
//   attest_fails — 'impostor' verdicts (another node's key signed our nonce): ATTEST_FAIL_LIMIT (2) of them pause the
//                  name, pause_reason 'impostor';
//   swap_fails   — sweeps in which something other than the name's own node answered (an impostor, or a content swap:
//                  a page, `swap`): swapFailLimit (12, about an hour) of them pause it, pause_reason 'content-swap'
//                  (design D2 = b). A content swap counts only in a sweep that saw the verifier working (`verified`):
//                  otherwise it neither counts nor ends a run.
// 'ok' (three of them, while a run is open: sight) ends both runs. Any other 'unverifiable' — nothing answered, an
// error, a signature we can't check — is never evidence: it never counts and never pauses, but it ends both runs, so a
// sighting can't pair with another one days of silence later. A content swap ends a run of impostor verdicts, as it
// always did (attest_fails counts consecutive ones), and continues the run of foreign answers.
// A pause is the kill switch: it stops ROUTING, and the name stays its owner's (design §2.3). Tunnel and DNS both go: a
// connector running on a leaked token dies with the tunnel, and the owner's heal comes back on a fresh tunnel whose
// token only its signed request receives — or, a direct name, only after an attest through the name under its key —
// so nobody else can ride the resume.
// Probation (design §4.3.2) is counted here too: a name on it (onProbation) counts its ok sweeps in a row (ok_sweeps), and
// is verified on the ok that makes them limits.probation_sweeps once it has been live limits.probation_s — written only
// while the row is still the tenure the sweep read, and pushed onto `verifiedNow` for the sweep's one "New community"
// alert. Anything but an ok in an applied sweep starts the count again; a suspended sweep neither counts nor ends it.
async function applyVerdict(env, r, limits, verified, verifiedNow = []) {
    const { a, verdict, why } = r;
    const swap = !!r.swap;
    if (swap && !verified) return;                                     // not counted, and no run ended
    // No run to end, and no probation count to start again: no read, no write.
    if (verdict === 'unverifiable' && !swap && !runOpen(a) && !(onProbation(a) && a.ok_sweeps)) return;
    const cur = await db.getAllocation(env, a.name);
    if (!cur || cur.status !== 'live' || cur.node_pubkey !== a.node_pubkey || cur.requested_at !== a.requested_at) return;
    const ended = {
        ...(cur.attest_fails ? { attest_fails: 0 } : {}), ...(cur.swap_fails ? { swap_fails: 0 } : {}),
        ...(onProbation(cur) && cur.ok_sweeps ? { ok_sweeps: 0 } : {}),
    };
    if (verdict === 'ok') {
        const now = nowS();
        const ok = { ...ended, attest_fails: 0, last_attest_at: now, last_ok_at: now };
        if (!onProbation(cur)) { await db.updateAllocation(env, a.name, ok); return; }
        const oks = (cur.ok_sweeps || 0) + 1;
        const done = oks >= limits.probation_sweeps && now - (cur.decided_at || cur.requested_at || now) >= limits.probation_s;
        if ((await db.updateIfUnchanged(env, a.name, cur, { ...ok, ok_sweeps: oks, ...(done ? { verified_at: now } : {}) })) && done) {
            await logEvent(env, a.name, 'verified', `probation over: ${oks} ok sweeps in a row, live since ${new Date((cur.decided_at || cur.requested_at) * 1000).toISOString()}; listed on the switchboard, and its node's directory listing goes ahead`);
            verifiedNow.push(cur);
        }
        return;
    }
    if (!foreign(r)) {
        await db.updateAllocation(env, a.name, ended);
        return;
    }
    const fails = verdict === 'impostor' ? (cur.attest_fails || 0) + 1 : 0;
    const swaps = (cur.swap_fails || 0) + 1;
    const reason = verdict === 'impostor' && fails >= limits.impostor ? 'impostor' : (swaps >= limits.swap ? 'content-swap' : null);
    if (!reason) {
        await db.updateAllocation(env, a.name, { attest_fails: fails, swap_fails: swaps, ...(ended.ok_sweeps === 0 ? { ok_sweeps: 0 } : {}) });
        return;
    }
    // Row first (stopRouting): an owner's heal that read it live meanwhile then misses its write, and undoes.
    const to = { status: 'paused', pause_reason: reason, paused_at: nowS(), attest_fails: fails, swap_fails: swaps };
    if (!(await stopRouting(env, cur, to))) return;   // changed since the re-read: the next sweep looks again
    const seen = reason === 'impostor'
        ? `impostor ${fails}× in a row (${why})`
        : `content swap: something other than its node answered at ${cur.hostname} in ${swaps} sweeps in a row, the last ${why} — no attest`;
    console.warn(`[ATTEST_PAUSE] ${a.name}: ${seen} — routing off, name kept for its key`);
    await logEvent(env, a.name, 'paused', `${seen}: tunnel and DNS removed; name kept for ${key16(cur.node_pubkey)}, whose heal resumes it`);
    await tell(env, () => alerts.routingPaused(env, a.name, reason, reason === 'impostor' ? fails : swaps));
}

// Two phases: classify every live name while writing nothing, judge the sweep as a whole, and only then act.
// A suspended sweep resets nothing and increments nothing. Returns the judgement (also logged). Every D1 query it runs is
// counted (d1Meter), and finishing orphans comes last, with what is left.
export async function attestSweep(invocationEnv) {
    const d1 = d1Meter(invocationEnv);
    const env = d1.env;
    const s = await settings.read(env);                         // the live limits (src/settings.js), in one read
    const limits = {
        impostor: s.attest_fail_limit,                          // consecutive IMPOSTOR verdicts before a pause
        swap: s.swap_fail_limit,                                // consecutive sweeps of foreign answers before a pause
        probation_sweeps: s.probation_sweeps, probation_s: s.probation_s,
    };
    const live = await db.listByStatus(env, 'live');
    const BATCH = 10;                                           // bounded concurrency — don't hit the cron's wall-clock/subrequest limits at scale
    const results = [];
    for (let i = 0; i < live.length; i += BATCH) {
        results.push(...await Promise.all(live.slice(i, i + BATCH).map(async (a) => ({ a, ...(await sight(env, a)) }))));
    }

    const j = judgeSweep(env, results);
    try { await db.insertSweepLog(env, j, nowS()); } catch (e) { console.error('[SWEEP_LOG]', e.message || e); }
    const line = `[ATTEST_SWEEP] ${j.action} live=${j.live} ok=${j.ok} unverifiable=${j.unverifiable} impostor=${j.impostor} content_swap=${j.content_swap}`;
    if (j.action !== 'applied') {
        const seen = results.filter((r) => r.verdict !== 'ok').slice(0, 50).map((r) => `${r.a.name}:${r.verdict}(${r.why})`);
        console.error(`${line} — acting on NO verdict; the registrar assumes it is at fault. ${seen.join(' ')}`);
    } else {
        console.log(line);
        const verified = verifiedSweep(env, j);
        const verifiedNow = [];
        for (let i = 0; i < results.length; i += BATCH) {
            await Promise.all(results.slice(i, i + BATCH).map((r) => applyVerdict(env, r, limits, verified, verifiedNow)));
        }
        // The "New community" alert, at verification rather than at the claim (design §4.3.2): one for the sweep however
        // many it verified, so a bot's burst never rings the phone once a name. Sent with the sweep's one send.
        if (verifiedNow.length) {
            try { await alerts.queue(env, alerts.newCommunities(env, verifiedNow, await db.countLive(env))); }
            catch (e) { console.error('[ALERT]', e.message || e); }
        }
    }
    await upkeep(env, results, BATCH);
    await alertConditions(env, j, s);
    await finishOrphans(d1, s);
    await pruneSources(d1, s);
    // One send for the sweep, last: what alertConditions told, the New community alert of names it verified, and whatever still
    // waits from a failed send (a try every 5 minutes, with the cron). Under waitUntil: the sweep never waits for ntfy.
    await alerts.sendWaiting(env);
    return j;
}

// D1 runs at most D1_QUERIES queries an invocation on Workers Free (1000 on Paid); past them every one fails ("Exceeded
// the maximum number of queries per invocation"). The sweep spends about 11, and 2 a live name, before finishing
// orphans; three orphans and four live names went over it, and what failed was the alert conditions after them (review
// of #2125). So the sweep counts its own: `env.DB` counts every statement run (all the sweep's are prepare()d), and
// `left()` keeps alerts.SEND_D1 for every send still running beside it (`env.waitUntil`: a pause's alert, say), which
// may not have run its queries yet. The sweep never waits for one.
const D1_QUERIES = 50;
const sendD1 = (env) => (alerts.channelSet(env) ? alerts.SEND_D1 : 0);
function d1Meter(env) {
    let used = 0;
    const running = new Set();
    const counted = (stmt) => ({
        bind: (...a) => counted(stmt.bind(...a)),
        first: (...a) => { used++; return stmt.first(...a); },
        all: (...a) => { used++; return stmt.all(...a); },
        run: (...a) => { used++; return stmt.run(...a); },
        raw: (...a) => { used++; return stmt.raw(...a); },
    });
    const metered = Object.assign(Object.create(env), { DB: { prepare: (sql) => counted(env.DB.prepare(sql)) } });
    if (typeof env.waitUntil === 'function') {
        metered.waitUntil = (p) => {
            const t = Promise.resolve(p).catch(() => {}).finally(() => running.delete(t));
            running.add(t);
            env.waitUntil(t);
        };
    }
    return { env: metered, left: () => D1_QUERIES - used - running.size * sendD1(env) };
}

// What the sweep sees of the registrar itself reaches the admin's phone (src/alerts.js; A4, A7): a suspended sweep
// (urgent: the registrar distrusts itself), deletions Cloudflare has refused for over a day, the nonce table missing.
// Each is told when it starts, every 24 h while it lasts, and when it ends, by the sweep's send after its orphans
// (attestSweep): what is told here is in the outbox before them, so they never starve it.
// `settings`: the sweep's read of them. A database with the settings table (migration 0011) has the nonce table (0006)
// too, so it is not asked again: the sweep's D1 queries are counted (d1Meter).
async function alertConditions(env, s, settingsRead = null) {
    try {
        const now = nowS();
        const conditions = [alerts.sweepCondition(env, s), alerts.nonceCondition(!(settingsRead?.schema || await nonceTableExists(env)))];
        try {
            const owed = await db.owedSince(env, now - 86400);
            conditions.push(alerts.teardownCondition(owed.n, owed.oldest, now));
        } catch (e) { console.error('[ALERT_CONDITION]', 'teardown-owed', e.message || e); }
        await alerts.updateConditions(env, conditions, { send: false });
    } catch (e) { console.error('[ALERT_CONDITION]', e.message || e); }
}

// Upkeep, every sweep, applied or suspended alike: none of it is a verdict on a node, and none of it takes routing
// from a live name or routes one that isn't live.
//   - A live name the attest found dark — it reached no node at all: unreachable, Cloudflare's 530 for a tunnel with
//     no connector, or its 52x for a proxied address it got no answer from (a direct node down, or a record pointing
//     where no node is; a tunnel name never sees one while it goes through its tunnel) — is looked at: if Cloudflare no
//     longer routes it as its row says (its record gone or pointing elsewhere, its tunnel gone), it is repaired
//     (routedOrRepaired), and its record owed if the repair doesn't take. Nodes never heal a name /status calls live,
//     so a live name left dark by any ordering of requests would otherwise stay dark. A node merely asleep costs a
//     read or two; one that answered anything (even a reply this verifier can't check) costs nothing.
//   - Owed deletions (teardown) are retried.
//   - Request nonces whose timestamp can no longer verify (twice the clock window, sign.js) are dropped.
// Then the alert conditions, and last, with the D1 queries left, claims whose provisioning never finished (finishOrphans).
const dark = (r) => r.verdict === 'unverifiable' && (r.why === 'unreachable' || /^http 5(2\d|30)$/.test(r.why));

async function upkeep(env, results, batch) {
    const look = results.filter(dark);
    for (let i = 0; i < look.length; i += batch) {
        await Promise.all(look.slice(i, i + batch).map((r) => routedOrRepaired(env, r.a.name)));
    }
    try {
        for (const t of await db.listTeardown(env, null)) {
            try { await settleOwed(env, t); } catch (e) { console.error('[TEARDOWN_RETRY]', t.name, t.kind, t.cf_id, e.message || e); }
        }
    } catch (e) { console.error('[TEARDOWN_RETRY]', e.message || e); }
    try { await db.pruneNonces(env, nowS() - 2 * CLOCK_SKEW_S); } catch (e) { console.error('[NONCE_PRUNE]', e.message || e); }
}

// A claim of an auto name whose provisioning never finished — Cloudflare failed, or the Worker was cut off before
// waitUntil kept it alive — while its node does not ask again (a node from before 2026-10-18 reads a pending answer as
// "awaiting approval" and waits) is finished by the sweep (F3 of scratch/global-node/DESIGN-registrar-trust-fable.md
// §5.2), as its next claim would finish it (heal's pending branch): it takes over nothing the registrar did not make, and
// its node gets the tunnel's token from /status, as it does a repaired tunnel's. Only ORPHAN_AFTER_S after its claim (a
// request still making it has had its 30 s); at most ORPHANS_PER_SWEEP a sweep (each is about six Cloudflare calls,
// inside the cron's subrequest budget), and each only while the sweep's D1 queries left (d1Meter) hold ORPHAN_D1 and
// the sweep's send after it (review of #2125). It comes after the upkeep and the alert conditions, so it never starves
// them, and its New community alerts go with that one send. One past the budget, or one Cloudflare refuses again, stays
// pending for the next sweep (or its node, or the admin's "Finish now"); one something else routes is left for its
// node's claim or the admin's, which refuse it out loud.
const ORPHAN_AFTER_S = 120;
const ORPHANS_PER_SWEEP = 3;
const ORPHAN_D1 = 15;   // the most one takes (measured: 10; 12 with a leftover tunnel; 3 more with the outbox full)
async function finishOrphans(d1, s) {
    const env = d1.env;
    try {
        if (d1.left() < 1 + sendD1(env)) return;   // not even the list's read
        const now = nowS();
        // A name held for the admin's approval is never an orphan (s.schema: the database has held_reason).
        for (const a of await db.listOrphans(env, now - ORPHAN_AFTER_S, now - releaseCooloffS(env), ORPHANS_PER_SWEEP, s?.schema !== false)) {
            if (d1.left() < ORPHAN_D1 + sendD1(env)) {
                console.warn('[ORPHAN_WAIT]', a.name, `pending: ${d1.left()} of D1's ${D1_QUERIES} queries left this sweep; finishing it takes up to ${ORPHAN_D1}, and the sweep's send ${sendD1(env)}`);
                break;
            }
            try { await finishOrphan(env, a, now); } catch (e) { console.error('[ORPHAN]', a.name, e.message || e); }
        }
    } catch (e) { console.error('[ORPHAN]', e.message || e); }
}

// Where new names came from is kept a day, no longer (migration 0011): the sweep deletes older rows last, with a query it
// has to spare (d1Meter) — never one the orphans or its send need. A sweep with none left (orphans took them) leaves it
// to the next; every new name's claim deletes them too (recordSource), so the table never outgrows a day of claims.
async function pruneSources(d1, s) {
    if (!s?.schema || d1.left() < 1 + sendD1(d1.env)) return;
    try { await db.pruneSources(d1.env, nowS() - SOURCE_KEEP_S); } catch (e) { console.error('[SOURCE_PRUNE]', e.message || e); }
}

async function finishOrphan(env, a, now) {
    if (await outsidePending(env, a)) {
        console.warn('[ORPHAN_LEFT]', a.name, 'pending: something the registrar did not make routes the name at Cloudflare; left for its claim or the admin');
        return;
    }
    let ids;
    try { ids = await ensure(env, a, a); }
    catch (e) {
        if (!e.raced) console.warn('[ORPHAN_LEFT]', a.name, `pending: ${e.cleaningUp ? e.message : `Cloudflare failed again (${e.message || e})`}; the next sweep tries again`);
        return;
    }
    if (!(await db.updateIfUnchanged(env, a.name, a, { ...recorded(ids, a), ...LIVE, decided_at: now, decided_by: 'auto' }, { withIds: true }))) {
        await undo(env, a.name, ids);   // its node's claim, the admin, or a release decided first
        return;
    }
    console.warn('[ORPHAN_FINISHED]', a.name, `pending → live: ${ids.changed.join(', ') || 'nothing'} made by the sweep`);
    await logEvent(env, a.name, 'healed', `finished by the sweep (its claim's answer never reached its node): pending → live, ${ids.changed.join(', ') || 'nothing'} made`);
    // Its "New community" alert waits for its probation to end (applyVerdict).
}

// Does Cloudflare route the live `row` as it says: the record it records, pointing at its target, and its tunnel?
// Throws when Cloudflare can't say.
async function routesAsRow(env, row) {
    const rec = await cf.findDnsRecord(env, row.hostname);
    const want = dnsTarget(row);
    if (!rec || rec.id !== row.dns_record_id || rec.type !== want.type || rec.content !== want.content || rec.proxied !== want.proxied)
        return false;
    return row.mode !== 'tunnel' || !!(await cf.getTunnel(env, row.tunnel_id));
}

// A live name Cloudflare doesn't route as its row says is repaired (repairLive). If it still isn't — Cloudflare refused
// the repair, or can't say — its record is owed, so the sweep keeps at it (settleOwed repairs a live row's owed record
// until it routes as the row says) even once something answers there: upkeep looks only at a name nothing answers at,
// and a record left pointing at an old address a stranger now serves is not dark. Never throws.
async function routedOrRepaired(env, name) {
    let row;
    try {
        row = await db.getAllocation(env, name);
        if (row?.status !== 'live' || await routesAsRow(env, row)) return;
        row = await repairLive(env, name);
        if (row?.status !== 'live' || await routesAsRow(env, row)) return;
    } catch (e) { console.error('[REPAIR_CHECK]', name, e.message || e); }
    if (row?.status === 'live') await owe(env, '[REPAIR_OWED]', name, 'dns', row.dns_record_id, 'Cloudflare does not route it as its row says');
}

// An alert's send runs after the response, or beside the sweep (src/alerts.js notify): the env, with ctx.waitUntil on it.
const withWaitUntil = (workerEnv, ctx) => (typeof ctx?.waitUntil === 'function'
    ? Object.assign(Object.create(workerEnv), { waitUntil: (p) => ctx.waitUntil(p) })
    : workerEnv);

// A claim, heal or approve makes a name at Cloudflare in several calls (a tunnel, its ingress, its record, its token), each
// as slow as Cloudflare is that day. Its node may stop waiting first (its budget ran out, its connection dropped), and the
// runtime keeps only work under waitUntil alive past that (up to 30 s): anything else can be cancelled half way, leaving
// a pending row with nothing made. Under waitUntil the work lands whoever is still listening (F2 of
// scratch/global-node/DESIGN-registrar-trust-fable.md §5.2); the sweep finishes what even that missed (finishOrphans).
// A rotate and a release are Cloudflare work too, written to the row first (review of #2125): a rotate cut off there
// leaves a live row on no tunnel, its old one deleted and its fresh one recorded nowhere; a release, a released name
// still routed by a record nothing owes. So is every admin action, its page closed or its connection lost part way: a
// block or release cut off left the row still recording a tunnel Cloudflare kept, its token working, nothing owed; a
// pause, its record; a resume and Remove from the list are the same shape.
const finishing = (env, p) => {
    if (typeof env.waitUntil === 'function') env.waitUntil(p.catch(() => {}));
    return p;
};

// /admin's alerts panel: the alert book, and whether a daily summary is sent at all (it goes with the outside checks of
// our servers, src/watch.js, so not while WATCH_TARGETS is unset).
const alertPanel = async (env) => ({ ...await alerts.alertStatus(env), daily_line: watchTargets(env).length > 0 });

// Every POST body, read with a budget (SEC-REG-03, verified 2026-10-16): a signed request's is a few hundred bytes, and
// one over BODY_MAX is refused with a 413 as soon as it passes it, never read in full or hashed. Content-Length alone is
// not enough: a chunked or HTTP/2 body may carry none. Returns the text, or null when it is too large.
const BODY_MAX = 64 * 1024;
async function readBody(request) {
    if (Number(request.headers.get('content-length')) > BODY_MAX) return null;
    if (!request.body) return '';
    const reader = request.body.getReader();
    const parts = [];
    let n = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.byteLength;
        if (n > BODY_MAX) { await reader.cancel().catch(() => {}); return null; }
        parts.push(value);
    }
    const all = new Uint8Array(n);
    let at = 0;
    for (const part of parts) { all.set(part, at); at += part.byteLength; }
    return new TextDecoder().decode(all);
}

export default {
    async fetch(request, workerEnv, ctx) {
        const env = withWaitUntil(workerEnv, ctx);
        const url = new URL(request.url);
        const p = url.pathname;
        const method = request.method;
        try {
            let bodyText = '';
            if (method === 'POST') {
                bodyText = await readBody(request);
                if (bodyText === null) return json({ error: `request body too large (at most ${BODY_MAX} bytes)` }, 413);
            }
            // commit: the git SHA this Worker was deployed from (`wrangler deploy --var GIT_SHA:…`, the deploy workflow);
            // null for a deploy that didn't say. The workflow fails unless it is the commit it deployed.
            if (method === 'GET' && p === '/api/registrar/health')
                return json({ status: 'ok', commit: env.GIT_SHA || null, accepted_proto: await acceptedProtos(env) });
            if (method === 'GET' && p === '/api/registrar/available') return await handleAvailable(url, env);
            if (method === 'POST' && p === '/api/registrar/claim') return await finishing(env, handleClaim(request, env, bodyText));
            if (method === 'POST' && p === '/api/registrar/heal') return await finishing(env, handleHeal(request, env, bodyText));
            if (method === 'POST' && p === '/api/registrar/rotate') return await finishing(env, handleRotate(request, env, bodyText));
            if (method === 'GET' && p === '/api/registrar/status') return await handleStatus(request, env);
            if (method === 'POST' && p === '/api/registrar/holder') return await handleHolder(request, env, bodyText);
            if (method === 'POST' && p === '/api/registrar/update') return await handleUpdate(request, env, bodyText);
            // `/offline` is release's old name; today's nodes still call it (keep it for at least one release).
            if (method === 'POST' && (p === '/api/registrar/release' || p === '/api/registrar/offline'))
                return await finishing(env, handleRelease(request, env, bodyText));

            // The control room's API. Every route here answers only its admin (adminIdentity): Cloudflare Access's signed
            // token, or — with no ACCESS_* var set — the ADMIN_SECRET header. Unknown paths too: a 401 before a 404.
            if (p.startsWith('/api/local/admin/registrar/')) {
                const who = await adminIdentity(request, env);
                if (!who) return unauthorized(env);
                if (method === 'POST' && accessMode(env) && crossSite(request, url)) return json({ error: 'cross-site request refused' }, 403);
                // Who is signed in, for the page's "Signed in as …": the email Access signed in, or null by the secret.
                if (method === 'GET' && p === '/api/local/admin/registrar/whoami')
                    return json({ email: who.email, via: who.email ? 'cloudflare-access' : 'admin-secret' });
                // Each row says whether it holds its name now (holdsName) and, for a release still held, until when; a release
                // says too whether its old key can still take it back (isOwnRow, past the hold too). What the admin's list
                // offers ("Free now" while either is so, "Remove from the list" once neither is) is the Worker's rule (forgetRow).
                // `awaiting_approval`: a pending row waits for the admin (a gated name); a pending auto name is still being
                // made ("Setting up": its claim's Cloudflare work did not finish), and nobody needs to approve it.
                if (method === 'GET' && p === '/api/local/admin/registrar/pending') {
                    const now = nowS();
                    // As awaitingApproval decides it (a name with no policy row, or an empty tier, is auto), in one read.
                    const tiers = await db.pendingTiers(env);
                    return json({ allocations: (await db.listActive(env)).map((a) => {
                        const holds = holdsName(env, a, now);
                        const awaiting_approval = a.status === 'pending' && (tiers.get(a.name) || 'auto') !== 'auto';
                        if (a.status !== 'released') return { ...a, holds, awaiting_approval };
                        return { ...a, holds, awaiting_approval, takes_back: isOwnRow(a, a.node_pubkey), ...(holds ? { held_until: (a.released_at || 0) + releaseCooloffS(env) } : {}) };
                    }) });
                }
                // Remove from the list, in bulk: { "names": [...] } (handleForgetMany), and "Free all and remove" with
                // "free_now": true. One name's is /:name/forget below.
                if (method === 'POST' && p === '/api/local/admin/registrar/forget') return await finishing(env, handleForgetMany(env, bodyText, who));
                if (method === 'GET' && p === '/api/local/admin/registrar/events') {
                    const name = (url.searchParams.get('name') || '').toLowerCase();
                    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1), 1000);
                    return json({ events: await db.listEvents(env, NAME_RE.test(name) ? name : null, limit) });
                }
                // The control room's alerts (src/alerts.js): their state, the category toggles, and a test message.
                if (p === '/api/local/admin/registrar/alerts' && method === 'GET') return json(await alertPanel(env));
                if (p === '/api/local/admin/registrar/alerts/settings' && method === 'POST') {
                    let b; try { b = JSON.parse((bodyText) || '{}'); } catch { return json({ error: 'bad json' }, 400); }
                    if (!(await alerts.setCategoryMode(env, b?.category, b?.mode)))
                        return json({ error: `category must be one of ${alerts.CATEGORIES.join(', ')}, and mode one of ${alerts.MODES.join(', ')}` }, 400);
                    return json(await alertPanel(env));
                }
                // The outside checks of our servers (src/watch.js): each one's newest look, for /admin's "Our servers".
                if (p === '/api/local/admin/registrar/servers' && method === 'GET') return json(await serversStatus(env));
                if (p === '/api/local/admin/registrar/alerts/test' && method === 'POST') return json(await alerts.sendTest(env));
                const m = p.match(/^\/api\/local\/admin\/registrar\/([a-z0-9-]{3,32})\/(approve|pause|resume|block|release|revoke|forget)$/);
                if (m && method === 'POST') {
                    // Release takes { "free_now": true }; nothing else (no body, any other value) is the default hold.
                    let freeNow = false;
                    if (m[2] === 'release') {
                        let b; try { b = JSON.parse(bodyText || '{}'); } catch { return json({ error: 'bad json' }, 400); }
                        freeNow = b?.free_now === true;
                    }
                    return await finishing(env, handleAdmin(env, m[1], m[2], { freeNow, who }));
                }
                return json({ error: 'not found' }, 404);
            }

            // Never inside another site's frame (SEC-REG-06, verified 2026-10-16): the admin acts here. Under Access, not
            // even the page without a signed-in admin (Marty, 2026-10-17: nobody sees it without 2FA) — Access in front
            // never lets such a request through; one that comes another way (workers.dev) gets nothing.
            if (method === 'GET' && (p === '/admin' || p === '/admin/' || p === '/admin.html')) {
                if (accessMode(env) && !(await adminIdentity(request, env)))
                    return new Response('Sign in through Cloudflare Access to open the control room.\n', { status: 401, headers: {
                        'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
                    } });
                return new Response(ADMIN_HTML, { headers: {
                    'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'",
                    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
                } });
            }

            if (method === 'GET' && p.startsWith('/i/')) return await handleSwitchboard(url, env);

            return json({ error: 'not found' }, 404);
        } catch (e) {
            const ref = errorRef();
            console.error('[INTERNAL]', ref, method, p, e.stack || e.message || e);
            return json({ error: 'internal', ref }, 500);
        }
    },

    async scheduled(event, workerEnv, ctx) {
        // Each cron entry (wrangler.toml) runs its own job in its own invocation: the outside checks of our servers
        // (src/watch.js, from here — never from the server they watch) on WATCH_CRON, the sweep on the other — and on
        // anything else, as before them. Apart, servers that hang never hold the sweep's connections or subrequests.
        // A slow ntfy never holds either: each send is its own waitUntil.
        const env = withWaitUntil(workerEnv, ctx);
        ctx.waitUntil(event?.cron === WATCH_CRON ? watchOurServers(env) : attestSweep(env));
    },
};
