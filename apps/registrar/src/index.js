// Beanpool node-address registrar — Cloudflare Worker.
//   fetch:     claim / heal / status / release (signed by node key) + admin approve/pause/resume/block/release +
//              switchboard
//   scheduled: attestation sweep — pauses a live name's routing only on proof that ANOTHER node key answers at it,
//              never on anything the registrar merely can't verify, and never when the sweep as a whole looks wrong.
// A name belongs to the node key that claimed it; the registrar can stop routing it but never hands it to another
// key. It frees only when its owner releases it (after a 30-day hold for that key), when the admin releases it, or
// (a later PR) after a long, warned abandonment. States: migrations/0002_states.sql.
// Design: scratch/registrar/DESIGN-2026-09-24-fable.md, docs/node-dns-registrar.md. CF calls: src/cf.js.

import * as cf from './cf.js';
import * as db from './db.js';
import { verifySignedRequest, verifyEd25519, ATTEST_DOMAIN } from './sign.js';
import { ADMIN_HTML } from './admin-html.js';

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/; // 3–32, no leading/trailing hyphen
const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const nowS = () => Math.floor(Date.now() / 1000);
const DEFAULT_ORIGIN = 'http://beanpool-node:8080';
const key16 = (pubkey) => `${String(pubkey).slice(0, 16)}…`;

// --- Ownership ---
// How long an owner-released name is held for the same key before any key may claim it (design D3: 30 days).
export function releaseCooloffS(env) {
    const n = parseInt(env.RELEASE_COOLOFF_S, 10);
    return Number.isFinite(n) && n >= 0 ? n : 30 * 86400;
}

// A released row that holds nothing, not even for its old key: the admin's release, or a key withdrawing a gated
// claim the admin never approved (the name was never that key's to hold).
const freedAtOnce = (row) => row.status === 'released' && (row.pause_reason === 'admin' || row.pause_reason === 'withdrawn');

// Does `row` keep its name from every key but its owner's? Only three things let a name go: its owner's release
// once the hold is over (at once for a claim nobody approved), the admin's release, and abandonment. Every other
// state — including one this code does not know, like a legacy 'revoked' row — holds the name.
export function holdsName(env, row, now = nowS()) {
    if (!row || row.status === 'abandoned') return false;
    if (row.status === 'released') {
        if (freedAtOnce(row)) return false;
        return now - (row.released_at || 0) < releaseCooloffS(env);
    }
    return true;
}

// Is `row` the claimant's own name, to heal or take back? Not once it is abandoned or freed at once: then the old
// key is just another claimant.
const isOwnRow = (row, pubkey) =>
    !!row && row.node_pubkey === pubkey && row.status !== 'abandoned' && !freedAtOnce(row);

// A claim still waiting for the admin: pending, on a name that is not auto-approved. (A pending auto name is one
// whose provisioning failed; its next claim finishes it.)
const awaitingApproval = async (env, a) => a.status === 'pending' && (await db.policyTier(env, a.name)) !== 'auto';

const reasonOf = (a) => a.pause_reason || (a.status === 'pending' ? 'awaiting-approval' : null);
const sinceOf = (a) => ({ paused: a.paused_at, blocked: a.paused_at, released: a.released_at, pending: a.requested_at })[a.status] ?? null;

// The audit trail must not undo what it records: a failed write is logged, never thrown.
async function logEvent(env, name, event, detail) {
    try { await db.insertEvent(env, name, event, detail); }
    catch (e) { console.error('[NAME_EVENT]', name, event, e.message || e); }
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
// The record is found by hostname, so once the row has changed it may be another tenure's: it is changed only while
// the row is still `expected` (the row as the caller read or last wrote it); otherwise ensure throws `raced`,
// having changed no record.
async function ensure(env, a, expected) {
    const changed = [];
    let tunnel_id = null;
    if (a.mode === 'tunnel') {
        if (a.tunnel_id && await cf.getTunnel(env, a.tunnel_id)) tunnel_id = a.tunnel_id;
        else {
            tunnel_id = (await cf.createTunnel(env, `bp-${a.name}`)).id;
            changed.push('tunnel');
        }
    } else if (a.mode === 'direct') {
        if (!a.public_ip) throw new Error('direct mode needs public_ip');
        // Moving tunnel → direct: the owner's old tunnel has nothing left to serve.
        if (a.tunnel_id) { try { await cf.deleteTunnel(env, a.tunnel_id); } catch { /* already gone */ } }
    } else {
        throw new Error(`unknown mode ${a.mode}`);
    }
    try {
        if (a.mode === 'tunnel') await cf.setTunnelIngress(env, tunnel_id, a.hostname, a.origin || DEFAULT_ORIGIN);
        const want = dnsTarget({ ...a, tunnel_id });
        let rec = await cf.findDnsRecord(env, a.hostname);
        const intact = rec && rec.type === want.type && rec.content === want.content && rec.proxied === want.proxied;
        if (!intact && !(await db.isUnchanged(env, a.name, expected)))
            throw Object.assign(new Error('the name changed meanwhile'), { raced: true });
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
        return { tunnel_id, dns_record_id, changed };
    } catch (e) {
        // A tunnel made just now is recorded nowhere (the caller writes nothing on a throw), and Cloudflare refuses
        // a second tunnel of the same name: left behind, it would fail every retry. It goes.
        if (changed.includes('tunnel')) {
            try { await cf.deleteTunnel(env, tunnel_id); }
            catch (d) { console.error('[PROVISION_ORPHAN]', a.name, tunnel_id, d.message || d); }
        }
        throw e;
    }
}

// Delete a row's tunnel and DNS record. Returns the ids still to remember: null once a resource is gone (deleted
// now, or a 404), the old id if Cloudflare refused — a live tunnel we lost track of could not be re-checked by
// the owner's next heal, which would then mint a second tunnel beside it.
async function deprovision(env, a) {
    const gone = async (del) => { try { await del(); return true; } catch (e) { return e?.status === 404; } };
    const dnsGone = !a.dns_record_id || await gone(() => cf.deleteDnsRecord(env, a.dns_record_id));
    const tunnelGone = !a.tunnel_id || await gone(() => cf.deleteTunnel(env, a.tunnel_id));
    return { dns_record_id: dnsGone ? null : a.dns_record_id, tunnel_id: tunnelGone ? null : a.tunnel_id };
}

// Routing off, tunnel kept: an admin pause, or a heal or take-back whose edge re-attest failed.
async function dnsOff(env, a) {
    if (!a.dns_record_id) return null;
    try { await cf.deleteDnsRecord(env, a.dns_record_id); return null; }
    catch (e) { return e?.status === 404 ? null : a.dns_record_id; }
}

async function tunnelTokenOrNothing(env, a) {
    if (a.mode !== 'tunnel' || !a.tunnel_id) return undefined;
    try { return await cf.getTunnelToken(env, a.tunnel_id); } catch { return undefined; /* the node asks /status again */ }
}

const provisionFailed = (e) => {
    console.error('[PROVISION_FAIL]', e.stack || e.message || e);
    return json({ error: 'provisioning failed', detail: String(e.message || e) }, 502);
};

// --- Races ---
// A request reads the row, works at Cloudflare (ensure; on a kept tunnel, an edge re-attest of up to 15 s), then
// writes. Whatever is decided meanwhile stands:
//   - bringing routing up (heal, claim, take-back, approve, resume): every write after a Cloudflare call holds only
//     while the row's tenure and state are as read (db.updateIfUnchanged), and ensure() changes the record at the
//     hostname only while the row is as read. On a miss the request undoes what it did (undo: a record it changed
//     that is now another tenure's is put back to that tenure) and answers with the row as it now is.
//   - taking routing down (the admin's pause and block, a release, the sweep's pause): the row is written FIRST,
//     then Cloudflare (stopRouting), so a request that read the row earlier misses its own write. That write always
//     counts a decision (decision_seq), so one that changes no status — blocking a blocked name, pausing a paused
//     one — is missed by a request in flight all the same.

// The decision counter a write carries: the row's, plus one. NULL (a row no decision has touched) counts as 0.
const decision = (a) => ({ decision_seq: (a.decision_seq ?? 0) + 1 });

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
//     change is left to the live row.
// Returns the row as it now is.
async function undo(env, name, ids) {
    let now = await db.getAllocation(env, name);
    const drop = async (what, id, del) => {
        try { await del(); } catch (e) { if (e?.status !== 404) console.error('[UNDO_FAILED]', name, what, id, e.message || e); }
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
async function stopRouting(env, a, to, { keepTunnel = false, byHostname = false } = {}) {
    const written = { ...to, ...decision(a) };
    if (!(await db.updateIfUnchanged(env, a.name, a, written, { withIds: true }))) return false;
    const left = keepTunnel ? { tunnel_id: a.tunnel_id ?? null, dns_record_id: await dnsOff(env, a) } : await deprovision(env, a);
    if (byHostname) left.dns_record_id = await dnsOffAt(env, a.hostname, left.dns_record_id);
    if (left.tunnel_id !== (a.tunnel_id ?? null) || left.dns_record_id !== (a.dns_record_id ?? null))
        await db.updateIfUnchanged(env, a.name, { ...a, ...written }, left, { withIds: true });
    return true;
}

// The answer to the owner's heal or claim whose write missed: nothing done, and the row as it now is.
function asNow(now, pubkey) {
    if (!isOwnRow(now, pubkey)) return json({ error: 'name changed meanwhile', status: now?.status ?? 'none' }, 409);
    if (now.status === 'blocked') return json({ error: 'name blocked' }, 403);
    return {
        name: now.name, hostname: now.hostname, mode: now.mode, community_name: now.community_name, contact: now.contact,
        status: now.status, reason: reasonOf(now), since: sinceOf(now), changed: [], newTunnel: false, tunnel_id: now.tunnel_id,
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

const LIVE = { status: 'live', pause_reason: null, paused_at: null, attest_fails: 0 };

// Routing back on for the owner's name that is not live — a pause its heal lifts, or its own release taken back —
// only when nobody but the owner can be answering: at once on a tunnel made in this request (only this signed
// request gets its token); otherwise (a tunnel that outlived a pause or a release, or a direct address) only on an
// edge re-attest the owner's key signed. `res` is the row as ensure() left it. Writes the row live — only while it
// is still `expected`, the row as the caller read or last wrote it — and returns { live: true, attest? }, or
// { missed: true } for the caller to undo; else takes routing back off and returns { live: false, verdict, why,
// dns_record_id } for the caller to record.
async function routeIfOnlyOwner(env, expected, res, ids, now) {
    const goLive = async (fields, out) => ((await db.updateIfUnchanged(env, res.name, expected, fields)) ? out : { missed: true });
    if (res.mode === 'tunnel' && ids.changed.includes('tunnel')) return goLive(LIVE, { live: true });
    const r = await classify(env, res);
    if (r.verdict === 'ok') return goLive({ ...LIVE, last_attest_at: now, last_ok_at: now }, { live: true, attest: 'ok' });
    return { live: false, ...r, dns_record_id: await dnsOff(env, res) };
}

// The owner's own held name (live, paused or pending): bring it back to what it should be. Never deprovisions
// first; ensure() reuses whatever Cloudflare still has. Returns { status, …, changed, newTunnel } or a Response.
//   live    → repair (re-assert tunnel, ingress, DNS).
//   pending → an auto name whose provisioning failed is retried; a gated one keeps waiting for the admin.
//   paused  → the admin's pause only the admin lifts. Any other pause resumes under routeIfOnlyOwner; otherwise
//             routing goes back off and the name stays paused — and the owner's.
async function heal(env, cur, b, now) {
    const fields = bodyFields(b);
    const a = { ...cur, ...fields };
    const reply = (extra) => ({ name: a.name, hostname: a.hostname, mode: a.mode, community_name: a.community_name, contact: a.contact, ...extra });

    if (await awaitingApproval(env, cur)) {
        await db.updateAllocation(env, cur.name, fields);
        return reply({ status: 'pending', reason: 'awaiting-approval', since: cur.requested_at, note: 'awaiting approval', changed: [] });
    }
    if (cur.status === 'paused' && cur.pause_reason === 'admin') {
        await db.updateAllocation(env, cur.name, fields);
        return reply({ status: 'paused', reason: 'admin', since: cur.paused_at, changed: [] });
    }

    // From here every write holds only while the row is as read (`cur`); if it changed, the heal is undone.
    let ids = NOTHING;
    const missed = async () => asNow(await undo(env, cur.name, ids), cur.node_pubkey);
    try { ids = await ensure(env, a, cur); } catch (e) { return e.raced ? missed() : provisionFailed(e); }
    if (!(await db.updateIfUnchanged(env, cur.name, cur, { ...fields, tunnel_id: ids.tunnel_id, dns_record_id: ids.dns_record_id })))
        return missed();
    const res = { ...a, tunnel_id: ids.tunnel_id, dns_record_id: ids.dns_record_id };
    const newTunnel = ids.changed.includes('tunnel');

    if (cur.status === 'live') {
        if (ids.changed.length) await logEvent(env, cur.name, 'healed', `repaired by its owner: ${ids.changed.join(', ')} re-made`);
        return reply({ status: 'live', changed: ids.changed, newTunnel, tunnel_id: ids.tunnel_id });
    }

    if (cur.status === 'pending') {
        // An auto name whose first provisioning failed: this is that claim, finished.
        if (!(await db.updateIfUnchanged(env, cur.name, cur, { ...LIVE, decided_at: now, decided_by: 'auto' }))) return missed();
        await logEvent(env, cur.name, 'healed', `pending (provisioning had failed) → live: ${ids.changed.join(', ') || 'nothing'} made`);
        return reply({ status: 'live', changed: ids.changed, newTunnel, tunnel_id: ids.tunnel_id });
    }
    const was = `paused (${cur.pause_reason || 'no reason'})`;
    const g = await routeIfOnlyOwner(env, cur, res, ids, now);
    if (g.missed) return missed();
    if (g.live) {
        await logEvent(env, cur.name, 'resumed', `${was} → live: healed by its owner${g.attest ? ', edge re-attest ok' : ' on a fresh tunnel'}`);
        return reply({ status: 'live', changed: ids.changed, newTunnel, tunnel_id: ids.tunnel_id, ...(g.attest ? { attest: g.attest } : {}) });
    }
    if (!(await db.updateIfUnchanged(env, cur.name, cur, { dns_record_id: g.dns_record_id }))) return missed();
    await logEvent(env, cur.name, 'heal-refused', `stays ${was}: edge re-attest ${g.verdict} (${g.why})`);
    return reply({ status: cur.status, reason: reasonOf(cur), since: sinceOf(cur), changed: ids.changed, attest: g.verdict, why: g.why });
}

// A name nobody else holds, or the claimant's own released one taken back: a new tenure. A gated name waits for
// the admin — unless it is the same key taking back a name the admin (or policy) already let it have. A name the
// admin released, or an abandoned one, is not the old key's any more (isOwnRow): that key waits like anyone.
// A take-back is routed as a heal from a pause is (routeIfOnlyOwner): until then its row is paused for its key
// ('unverified'), so one whose provisioning fails is finished by its next claim — a heal — never unchecked.
async function takeName(env, existing, pubkey, b, now) {
    const name = String(b.name).toLowerCase();
    const mode = b.mode === 'direct' ? 'direct' : 'tunnel';
    const tier = await db.policyTier(env, name);
    const sameKey = isOwnRow(existing, pubkey);
    const approved = tier === 'auto' || (sameKey && !!existing.decided_at);
    const takeBack = sameKey && approved;
    const decided = { decided_at: now, decided_by: tier === 'auto' ? 'auto' : (existing?.decided_by || 'admin') };
    const fields = {
        node_pubkey: pubkey, hostname: `${name}.${env.BASE_DOMAIN}`, mode, status: takeBack ? 'paused' : 'pending',
        community_name: b.community_name || b.communityName || null,
        origin: b.origin || null, public_ip: b.public_ip || null, contact: b.contact || null,
        attest_fails: 0, requested_at: now,
        decided_at: takeBack ? decided.decided_at : null, decided_by: takeBack ? decided.decided_by : null,
        pause_reason: takeBack ? 'unverified' : null, paused_at: takeBack ? now : null,
        released_at: null, warned_at: null, last_contact_at: now,
        // The same key's own tunnel may be reused (ensure checks it); another key's never is.
        tunnel_id: sameKey ? existing.tunnel_id : null, dns_record_id: sameKey ? existing.dns_record_id : null,
    };
    if (!existing) {
        try { await db.insertAllocation(env, { name, ...fields }); }
        catch { return json({ error: 'name taken' }, 409); } // UNIQUE race
        await db.updateAllocation(env, name, { last_contact_at: now });
        await logEvent(env, name, 'claimed', `claimed by key ${key16(pubkey)} (${mode}, tier ${tier})`);
    } else {
        // Its own key taking back its release: a tunnel the release could not delete goes now, so the take-back is
        // on a fresh one; one Cloudflare still won't delete is kept, and routes only after a re-attest.
        if (sameKey && existing.tunnel_id) fields.tunnel_id = (await deprovision(env, { tunnel_id: existing.tunnel_id })).tunnel_id;
        Object.assign(fields, decision(existing));   // a new tenure counts as a decision; `a` below carries it
        if (!(await db.replaceAllocation(env, name, existing, fields))) return json({ error: 'name taken' }, 409); // raced
        // Another key taking a freed name: whatever the old holder left at Cloudflare goes — once this claim has won.
        if (!sameKey) await deprovision(env, existing);
        await logEvent(env, name, 'claimed', sameKey
            ? `taken back by its own key ${key16(pubkey)} (was ${existing.status})`
            : `claimed by key ${key16(pubkey)}; it was ${existing.status}, last held by ${key16(existing.node_pubkey)}`);
    }

    if (!approved) return json({ status: 'pending', hostname: fields.hostname, note: 'awaiting approval' });
    const a = { name, ...fields };
    // From here every write holds only while the row is this tenure as written (`a`); if it changed, the claim is
    // undone. A failure leaves the row held by this key ('pending', or a take-back's 'paused'); its next claim retries.
    let ids = NOTHING;
    const missed = async () => claimReply(env, asNow(await undo(env, name, ids), pubkey));
    try { ids = await ensure(env, a, a); } catch (e) { return e.raced ? missed() : provisionFailed(e); }
    const made = { tunnel_id: ids.tunnel_id, dns_record_id: ids.dns_record_id };
    const out = { status: 'live', hostname: a.hostname, community_name: a.community_name, contact: a.contact };
    if (takeBack) {
        if (!(await db.updateIfUnchanged(env, name, a, made))) return missed();
        const g = await routeIfOnlyOwner(env, a, { ...a, ...made }, ids, now);
        if (g.missed) return missed();
        if (!g.live) {
            const reason = g.verdict === 'impostor' ? 'impostor' : 'unverified';
            if (!(await db.updateIfUnchanged(env, name, a, { pause_reason: reason, dns_record_id: g.dns_record_id }))) return missed();
            await logEvent(env, name, 'paused', `taken back, but not routed: edge re-attest ${g.verdict} (${g.why}); name kept for ${key16(pubkey)}, whose heal re-attests`);
            return json({ ...out, status: 'paused', reason, since: now, attest: g.verdict, why: g.why });
        }
        if (g.attest) out.attest = g.attest;
    } else if (!(await db.updateIfUnchanged(env, name, a, { ...made, status: 'live', ...decided }))) {
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
    const pubkey = await verifySignedRequest(request, bodyText);
    if (!pubkey) return json({ error: 'bad signature' }, 401);
    let b; try { b = JSON.parse(bodyText || '{}'); } catch { return json({ error: 'bad json' }, 400); }

    const name = String(b.name || '').toLowerCase();
    if (!NAME_RE.test(name)) return json({ error: 'invalid name (3–32; a–z 0–9 -; no leading/trailing hyphen)' }, 400);
    const now = nowS();
    await db.touchContact(env, pubkey, now);
    const existing = await db.getAllocation(env, name);

    // The claimant's own name: a heal (or taking back its own release). Ownership outranks a policy row added
    // after the claim; only the admin's block stops it.
    if (isOwnRow(existing, pubkey)) {
        if (existing.status === 'blocked') return json({ error: 'name blocked' }, 403);
        if (existing.status === 'released' || existing.status === 'revoked') return takeName(env, existing, pubkey, { ...b, name }, now);
        return claimReply(env, await heal(env, existing, b, now));
    }

    const tier = await db.policyTier(env, name);
    if (tier === 'blocked') return json({ error: 'name reserved' }, 403);
    if (holdsName(env, existing, now)) return json({ error: 'name taken', owner: 'other' }, 409);
    return takeName(env, existing, pubkey, { ...b, name }, now);
}

// POST /api/registrar/heal — the owner re-asserts its name (design §2.2). Answers a fresh tunnelToken only when the
// tunnel had to be re-made (a node that already runs the old one keeps running it), and `changed`.
async function handleHeal(request, env, bodyText) {
    const pubkey = await verifySignedRequest(request, bodyText);
    if (!pubkey) return json({ error: 'bad signature' }, 401);
    let b; try { b = JSON.parse(bodyText || '{}'); } catch { return json({ error: 'bad json' }, 400); }
    const now = nowS();
    await db.touchContact(env, pubkey, now);
    const cur = b.name ? await db.getAllocation(env, String(b.name).toLowerCase()) : await db.getOwnAllocation(env, pubkey);
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

async function handleStatus(request, env) {
    const pubkey = await verifySignedRequest(request, '');
    if (!pubkey) return json({ error: 'bad signature' }, 401);
    await db.touchContact(env, pubkey, nowS());
    // Any state: answering 'none' for a name the node still owns is what made nodes wipe their saved address
    // (2026-09-24 incident).
    const a = await db.getOwnAllocation(env, pubkey);
    if (!a) return json({ status: 'none' });
    const out = {
        status: a.status, name: a.name, hostname: a.hostname, mode: a.mode, community_name: a.community_name, contact: a.contact,
        reason: reasonOf(a), since: sinceOf(a),
    };
    if (a.status === 'released' && !freedAtOnce(a)) out.held_until = (a.released_at || 0) + releaseCooloffS(env);
    if (a.status === 'live') {
        const token = await tunnelTokenOrNothing(env, a);
        if (token !== undefined) out.tunnelToken = token;
    }
    return json(out);
}

async function handleUpdate(request, env, bodyText) {
    const pubkey = await verifySignedRequest(request, bodyText);
    if (!pubkey) return json({ error: 'bad signature' }, 401);
    await db.touchContact(env, pubkey, nowS());
    const a = await db.getAllocationByPubkey(env, pubkey);
    if (!a) return json({ error: 'allocation not found' }, 404);
    let b; try { b = JSON.parse(bodyText || '{}'); } catch { return json({ error: 'bad json' }, 400); }
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

// Tunnel and DNS go; the row stays, 'released'. By its owner ('owner'): held for the same key RELEASE_COOLOFF_S,
// then free. By the admin ('admin'), or a gated claim nobody approved withdrawn by its key ('withdrawn'): free at
// once (to anyone, the old key included). The row is written first (stopRouting); false, with nothing done, if it
// changed since `a` was read.
async function releaseRow(env, a, by, now) {
    const to = { status: 'released', released_at: now, pause_reason: by, paused_at: null, attest_fails: 0 };
    if (!(await stopRouting(env, a, to))) return false;
    await logEvent(env, a.name, 'released', ({
        admin: `released by the admin (was ${a.status}): free now`,
        withdrawn: `withdrawn by its key ${key16(a.node_pubkey)} before the admin approved it: free now`,
    })[by] ?? `released by its owner ${key16(a.node_pubkey)} (was ${a.status}): held ${Math.round(releaseCooloffS(env) / 86400)} days for that key, then free`);
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
    const pubkey = await verifySignedRequest(request, bodyText);
    if (!pubkey) return json({ error: 'bad signature' }, 401);
    let b = {}; try { b = JSON.parse(bodyText || '{}') || {}; } catch { /* /offline has always taken any body */ }
    const now = nowS();
    await db.touchContact(env, pubkey, now);
    const read = () => (typeof b.name === 'string' && b.name
        ? db.getAllocation(env, b.name.toLowerCase())
        : db.getOwnAllocation(env, pubkey));
    return onFreshRow(read, async (a) => {
        if (!isOwnRow(a, pubkey)) return json({ status: 'none' });
        if (a.status === 'blocked') return json({ error: 'name blocked' }, 403);
        // An admin pause is the admin's to lift (resume, or the admin's own release). Released by its owner, it
        // would be gone, and the owner's next claim a take-back: live again with no resume.
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

// --- Admin (shared secret) ---
// Every action is logged in name_events. None of them frees a name except `release`.
const checkAdmin = (request, env) =>
    !!env.ADMIN_SECRET && timingSafeEqualStrings(request.headers.get('x-admin-secret'), env.ADMIN_SECRET);

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
async function adminResume(env, a, was, now) {
    const r = { ...a };
    if (a.tunnel_id && !(a.status === 'paused' && a.pause_reason === 'admin'))
        r.tunnel_id = (await deprovision(env, { tunnel_id: a.tunnel_id })).tunnel_id;
    let ids;
    try { ids = await ensure(env, r, a); } catch (e) { return e.raced ? adminMissed(env, a.name, NOTHING) : provisionFailed(e); }
    const made = { tunnel_id: ids.tunnel_id, dns_record_id: ids.dns_record_id };
    if (!(await db.updateIfUnchanged(env, a.name, a, made))) return adminMissed(env, a.name, ids);
    const g = await routeIfOnlyOwner(env, a, { ...r, ...made }, ids, now);
    if (g.missed) return adminMissed(env, a.name, ids);
    if (g.live) {
        await logEvent(env, a.name, 'resumed', `resumed by the admin (was ${was})${g.attest ? ': edge re-attest ok' : ': on a fresh tunnel'}`);
        return json({ status: 'live', name: a.name, changed: ids.changed, ...(g.attest ? { attest: g.attest } : {}) });
    }
    const reason = g.verdict === 'impostor' ? 'impostor' : 'unverified';
    const held = { status: 'paused', pause_reason: reason, paused_at: a.status === 'paused' ? a.paused_at : now, dns_record_id: g.dns_record_id };
    if (!(await db.updateIfUnchanged(env, a.name, a, held))) return adminMissed(env, a.name, ids);
    await logEvent(env, a.name, 'resume-refused', `resumed by the admin (was ${was}), but not routed: edge re-attest ${g.verdict} (${g.why}); paused/${reason} for ${key16(a.node_pubkey)}, whose heal re-attests`);
    return json({ status: 'paused', name: a.name, reason, attest: g.verdict, why: g.why });
}

// Approve: a pending claim goes live at once, as any new claim does (its tunnel is made now).
async function adminGoLive(env, a, event, detail, extra = {}) {
    let ids;
    try { ids = await ensure(env, a, a); } catch (e) { return e.raced ? adminMissed(env, a.name, NOTHING) : provisionFailed(e); }
    const live = { tunnel_id: ids.tunnel_id, dns_record_id: ids.dns_record_id, ...LIVE, ...extra };
    if (!(await db.updateIfUnchanged(env, a.name, a, live))) return adminMissed(env, a.name, ids);
    await logEvent(env, a.name, event, detail);
    return json({ status: 'live', name: a.name, changed: ids.changed });
}

// Pause, block and release write the row first, and only while it is as read: if it changed in between, the action
// is decided again on the row as it now is (onFreshRow).
async function handleAdmin(env, name, action) {
    return onFreshRow(() => db.getAllocation(env, name), (a) => (a ? adminAction(env, a, action, nowS()) : json({ error: 'unknown name' }, 404)));
}

async function adminAction(env, a, action, now) {
    const name = a.name;
    const was = `${a.status}${a.pause_reason ? `/${a.pause_reason}` : ''}`;
    switch (action) {
        case 'approve':
            if (a.status !== 'pending') return json({ error: 'not pending' }, 400);
            return adminGoLive(env, a, 'approved', 'approved by the admin', { decided_at: now, decided_by: 'admin' });
        case 'pause': {
            // Routing off, name and tunnel kept; its owner can neither heal nor release it — only `resume` (or `release`).
            if (a.status !== 'live' && a.status !== 'paused') return json({ error: `cannot pause a ${a.status} name` }, 400);
            const to = { status: 'paused', pause_reason: 'admin', paused_at: a.status === 'paused' ? a.paused_at : now };
            if (!(await stopRouting(env, a, to, { keepTunnel: true, byHostname: true }))) return null;
            await logEvent(env, name, 'paused', `paused by the admin (was ${was})`);
            return json({ status: 'paused', name, reason: 'admin' });
        }
        case 'resume':
            if (a.status !== 'paused' && a.status !== 'blocked') return json({ error: `cannot resume a ${a.status} name` }, 400);
            return adminResume(env, a, was, now);
        case 'block':
        case 'revoke': {
            // The kill switch. Routing and tunnel go; the name is held, never free — an impostor must not inherit a
            // name the admin killed (design §2.1). `revoke` is its old name. Blocking a blocked name again removes
            // whatever routing is still there, and stands against a resume in flight.
            if (a.status === 'blocked') {
                if (!(await stopRouting(env, a, null, { byHostname: true }))) return null;
                await logEvent(env, name, 'blocked', 'blocked again by the admin: any routing left removed');
                return json({ status: 'blocked', name });
            }
            if (!(await stopRouting(env, a, { status: 'blocked', pause_reason: 'admin', paused_at: now }, { byHostname: true }))) return null;
            await logEvent(env, name, 'blocked', `blocked by the admin (was ${a.status}); key ${key16(a.node_pubkey)}`);
            return json({ status: 'blocked', name });
        }
        case 'release':
            if (a.status === 'abandoned' || freedAtOnce(a)) return json({ status: 'released', name });
            if (!(await releaseRow(env, a, 'admin', now))) return null;
            return json({ status: 'released', name });
    }
    return json({ error: 'unknown action' }, 400);
}

// --- Switchboard (Invite resolution / trampoline) ---
// A paused community still exists (the app shows it unreachable, which is true), so its invites still resolve;
// a released, abandoned or blocked name's do not.
const routesInvites = (alloc) => !!alloc && (alloc.status === 'live' || alloc.status === 'paused');

async function resolveNodeHostname(env, code, queryN) {
    if (queryN) {
        const cleanN = queryN.trim().toLowerCase();
        if (cleanN) {
            return cleanN.includes('.') ? cleanN : `${cleanN}.${env.BASE_DOMAIN || 'beanpool.org'}`;
        }
    }
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
    const queryN = (url.searchParams.get('n') || '').replace(/[^a-z0-9.\-]/gi, '');

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
//                    or a signature that verifies under no key we can check (an unknown signing format). That is
//                    what a sleeping solar node, a format drift, or a bug on OUR side looks like — never evidence.
// Content that isn't an attest at all (a swapped origin) is unverifiable here too; what to do about it is a
// separate, slower decision (design D2). Such replies carry `swap: true` so the sweep log can count them.
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
    if (!(await verifyEd25519(signer, `${ATTEST_DOMAIN}\n${nonce}\n${j.timestamp}`, j.signature)))
        return { verdict: 'unverifiable', why: 'signature does not verify' };
    if (signer === String(a.node_pubkey).toLowerCase()) return { verdict: 'ok' };
    return { verdict: 'impostor', why: `valid signature by ${signer.slice(0, 16)}…` };
}

export async function attestOne(env, a) {
    return (await classify(env, a)).verdict;
}

// Is this sweep's picture of the world believable? (design §2.4) If not, the registrar assumes it is the one at
// fault and acts on no row.
//   - the canary (CANARY_NAME, one of our own nodes) must be live and 'ok'. Unset = no canary check.
//   - impostors must not exceed max(2, 10% of live): real ones are rare and independent; many at once is us.
//     Nor may every live name be one: max(2, …) can't be exceeded while live <= 2, and a small fleet (the live
//     set after 09-24) is where a key-comparison bug would otherwise pause every name in two sweeps.
//   - unverifiable must not exceed half of live: a registrar that can't see most of the world shouldn't trust
//     what it thinks it sees in the rest.
function judgeSweep(env, results) {
    const count = (v) => results.filter((r) => r.verdict === v).length;
    const s = {
        live: results.length, ok: count('ok'), unverifiable: count('unverifiable'), impostor: count('impostor'),
        content_swap: results.filter((r) => r.swap).length,   // counted only; never acted on here
    };
    const canary = env.CANARY_NAME ? results.find((r) => r.a.name === env.CANARY_NAME) : null;
    if (env.CANARY_NAME && canary?.verdict !== 'ok') s.action = 'suspended:canary';
    else if (s.impostor > Math.max(2, s.live * 0.1) || (s.live > 0 && s.impostor === s.live)) s.action = 'suspended:mass';
    else if (s.unverifiable > s.live / 2) s.action = 'suspended:unverifiable';
    else s.action = 'applied';
    return s;
}

// Phase 2 for one row. Re-reads it first, so a verdict is only ever applied to the allocation that was attested,
// not one the owner re-claimed or released while the sweep ran.
// 'unverifiable' is never evidence: it never counts and never pauses. It does end a run of impostor verdicts
// (attest_fails counts CONSECUTIVE ones), so a sighting can't pair with another one days of silence later.
async function applyVerdict(env, a, verdict, why, limit) {
    if (verdict === 'unverifiable' && !a.attest_fails) return;   // no run to end: no read, no write
    const cur = await db.getAllocation(env, a.name);
    if (!cur || cur.status !== 'live' || cur.node_pubkey !== a.node_pubkey || cur.requested_at !== a.requested_at) return;
    if (verdict === 'unverifiable') {
        if (cur.attest_fails) await db.updateAllocation(env, a.name, { attest_fails: 0 });
        return;
    }
    if (verdict === 'ok') {
        const now = nowS();
        await db.updateAllocation(env, a.name, { attest_fails: 0, last_attest_at: now, last_ok_at: now });
        return;
    }
    // 'impostor': the kill switch — it stops ROUTING, and the name stays its owner's (design §2.3). Tunnel and DNS
    // both go: a connector running on a leaked token dies with the tunnel, and the owner's heal comes back on a
    // fresh tunnel whose token only its signed request receives, so the impostor cannot ride the resume.
    const fails = (cur.attest_fails || 0) + 1;
    if (fails >= limit) {
        // Row first (stopRouting): an owner's heal that read it live meanwhile then misses its write, and undoes.
        const to = { status: 'paused', pause_reason: 'impostor', paused_at: nowS(), attest_fails: fails };
        if (!(await stopRouting(env, cur, to))) return;   // changed since the re-read: the next sweep looks again
        console.warn(`[ATTEST_PAUSE] ${a.name}: impostor ${fails}× (${why}) — routing off, name kept for its key`);
        await logEvent(env, a.name, 'paused', `impostor ${fails}× in a row (${why}): tunnel and DNS removed; name kept for ${key16(cur.node_pubkey)}, whose heal resumes it`);
    } else {
        await db.updateAllocation(env, a.name, { attest_fails: fails });
    }
}

// Two phases: classify every live name while writing nothing, judge the sweep as a whole, and only then act.
// A suspended sweep resets nothing and increments nothing. Returns the judgement (also logged).
export async function attestSweep(env) {
    const limit = parseInt(env.ATTEST_FAIL_LIMIT || '2', 10);   // consecutive IMPOSTOR verdicts before a pause
    const live = await db.listByStatus(env, 'live');
    const BATCH = 10;                                           // bounded concurrency — don't hit the cron's wall-clock/subrequest limits at scale
    const results = [];
    for (let i = 0; i < live.length; i += BATCH) {
        results.push(...await Promise.all(live.slice(i, i + BATCH).map(async (a) => ({ a, ...(await classify(env, a)) }))));
    }

    const s = judgeSweep(env, results);
    try { await db.insertSweepLog(env, s, nowS()); } catch (e) { console.error('[SWEEP_LOG]', e.message || e); }
    const line = `[ATTEST_SWEEP] ${s.action} live=${s.live} ok=${s.ok} unverifiable=${s.unverifiable} impostor=${s.impostor} content_swap=${s.content_swap}`;
    if (s.action !== 'applied') {
        const seen = results.filter((r) => r.verdict !== 'ok').slice(0, 50).map((r) => `${r.a.name}:${r.verdict}(${r.why})`);
        console.error(`${line} — acting on NO row; the registrar assumes it is at fault. ${seen.join(' ')}`);
        return s;
    }
    console.log(line);
    for (let i = 0; i < results.length; i += BATCH) {
        await Promise.all(results.slice(i, i + BATCH).map((r) => applyVerdict(env, r.a, r.verdict, r.why, limit)));
    }
    return s;
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const p = url.pathname;
        const method = request.method;
        try {
            if (method === 'GET' && p === '/api/registrar/health') return json({ status: 'ok' });
            if (method === 'GET' && p === '/api/registrar/available') return await handleAvailable(url, env);
            if (method === 'POST' && p === '/api/registrar/claim') return await handleClaim(request, env, await request.text());
            if (method === 'POST' && p === '/api/registrar/heal') return await handleHeal(request, env, await request.text());
            if (method === 'GET' && p === '/api/registrar/status') return await handleStatus(request, env);
            if (method === 'POST' && p === '/api/registrar/update') return await handleUpdate(request, env, await request.text());
            // `/offline` is release's old name; today's nodes still call it (keep it for at least one release).
            if (method === 'POST' && (p === '/api/registrar/release' || p === '/api/registrar/offline'))
                return await handleRelease(request, env, await request.text());

            if (method === 'GET' && p === '/api/local/admin/registrar/pending') {
                if (!checkAdmin(request, env)) return json({ error: 'unauthorized' }, 401);
                return json({ allocations: await db.listActive(env) });
            }
            if (method === 'GET' && p === '/api/local/admin/registrar/events') {
                if (!checkAdmin(request, env)) return json({ error: 'unauthorized' }, 401);
                const name = (url.searchParams.get('name') || '').toLowerCase();
                const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1), 1000);
                return json({ events: await db.listEvents(env, NAME_RE.test(name) ? name : null, limit) });
            }
            const m = p.match(/^\/api\/local\/admin\/registrar\/([a-z0-9-]{3,32})\/(approve|pause|resume|block|release|revoke)$/);
            if (m && method === 'POST') {
                if (!checkAdmin(request, env)) return json({ error: 'unauthorized' }, 401);
                return await handleAdmin(env, m[1], m[2]);
            }

            if (method === 'GET' && (p === '/admin' || p === '/admin/' || p === '/admin.html')) {
                return new Response(ADMIN_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
            }

            if (method === 'GET' && p.startsWith('/i/')) return await handleSwitchboard(url, env);

            return json({ error: 'not found' }, 404);
        } catch (e) {
            return json({ error: 'internal', detail: String(e.message || e) }, 500);
        }
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil(attestSweep(env));
    },
};
