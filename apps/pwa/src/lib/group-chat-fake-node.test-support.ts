/**
 * Tests only: a group's key routes as a node answers them (engine/group-keys.ts, the honest shape), in memory, so the
 * web's keyring and send path can be driven without a server. `lie` lets a test answer one request as a dishonest node
 * would; `calls` records every request. The real node is driven by e2e/group-chat-check.mjs.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { toEd25519Pkcs8, verifyGroupEpochRecord, groupEpochCoversExactly, type GroupEpochRecord, type GroupServedWrap, type GroupTopUp } from '@beanpool/core';
import type { GroupKeysTransport } from './group-chat-keys';

export function person(pkcs8 = false): { publicKey: string; privateKey: string } {
    const seed = ed25519.utils.randomSecretKey();
    return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(pkcs8 ? toEd25519Pkcs8(seed) : seed) };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export interface FakeGroupNode {
    groupId: string;
    epochs: Map<number, GroupEpochRecord>;
    topUps: (GroupTopUp & { rejected?: boolean })[];
    /** The keys roster (active members of the group). */
    roster: string[];
    /** The members list the screen shows (GET …/members, active rows). */
    shown: string[];
    stale: boolean;
    fromEpoch: Map<string, number>;
    lines: { id: string; author: string; ciphertext: string; nonce: string; metadata: any }[];
    calls: { method: string; path: string; body?: any; as: string }[];
    /** Answer one request as a dishonest node would: return a Response to use it, undefined to answer honestly. */
    lie: ((method: string, path: string, me: string, body?: any) => Response | undefined) | null;
    as(me: string): GroupKeysTransport;
    current(): number | null;
}

export function fakeGroupNode(groupId: string, members: string[]): FakeGroupNode {
    const node: FakeGroupNode = {
        groupId, epochs: new Map(), topUps: [], roster: [...members].sort(), shown: [...members], stale: false,
        fromEpoch: new Map(members.map((m) => [m, 1])), lines: [], calls: [], lie: null,
        current() { return node.epochs.size ? Math.max(...node.epochs.keys()) : null; },
        as(me) {
            const go = async (method: string, path: string, body?: any): Promise<Response> => {
                node.calls.push({ method, path, body, as: me });
                const lied = node.lie?.(method, path, me, body);
                if (lied) return lied;
                return answer(method, path, me, body);
            };
            return { get: (p) => go('GET', p), post: (p, b) => go('POST', p, b) };
        },
    };
    const base = `/api/groups/${encodeURIComponent(groupId)}`;
    const served = (r: GroupEpochRecord) => {
        const { wraps: _w, groupId: _g, ...rest } = r;
        return { ...rest, stale: node.stale && r.epoch === node.current() };
    };
    const wrapsFor = (me: string, list: number[]): GroupServedWrap[] => list.flatMap((e): GroupServedWrap[] => {
        const r = node.epochs.get(e)!;
        const top = node.topUps.find((t) => t.epoch === e && t.recipient === me && !t.rejected);
        if (top) return [{ epoch: e, wrapper: top.wrapper, ephPub: top.ephPub, nonce: top.nonce, wrapped: top.wrapped, sig: top.sig }];
        const w = r.wraps?.find((x) => x.recipient === me);
        return w ? [{ epoch: e, wrapper: r.createdBy, ephPub: w.ephPub, nonce: w.nonce, wrapped: w.wrapped, sig: null }] : [];
    });
    async function answer(method: string, path: string, me: string, body?: any): Promise<Response> {
        const [p, q = ''] = path.split('?');
        const params = new URLSearchParams(q);
        if (!node.roster.includes(me) && p.startsWith(base)) return json(404, { error: 'Group not found' });
        if (method === 'GET' && p === `${base}/members`) return json(200, node.shown.map((m) => ({ memberPubkey: m, status: 'active', role: 'member' })));
        if (method === 'GET' && p === `${base}/keys`) {
            const from = node.fromEpoch.get(me) ?? null;
            let list = [...node.epochs.keys()].sort((a, b) => a - b).filter((e) => from !== null && e >= from);
            if (params.get('epochs')) { const want = new Set(params.get('epochs')!.split(',').map(Number)); list = list.filter((e) => want.has(e)); }
            else if (params.get('after')) list = list.filter((e) => e > Number(params.get('after')));
            return json(200, {
                current: node.current(), stale: node.current() === null ? true : node.stale, fromEpoch: from, roster: [...node.roster].sort(),
                epochs: list.map((e) => served(node.epochs.get(e)!)), myWraps: wrapsFor(me, list), more: false,
            });
        }
        if (method === 'POST' && p === `${base}/keys/epoch`) {
            const r = body.epoch as GroupEpochRecord;
            const cur = node.current();
            if (r.epoch !== (cur ?? 0) + 1) return json(409, { error: 'epoch moved', code: 'epoch_conflict', current: cur, roster: node.roster });
            try {
                verifyGroupEpochRecord(r, { groupId, epoch: r.epoch, activeMembers: node.roster });
                if (!groupEpochCoversExactly(r, node.roster)) throw new Error('roster');
            } catch {
                return json(409, { error: 'roster', code: 'epoch_conflict', current: cur, roster: node.roster });
            }
            node.epochs.set(r.epoch, r);
            node.stale = false;
            return json(201, { epoch: r.epoch });
        }
        if (method === 'GET' && p === `${base}/keys/missing`) {
            const missing: { pubkey: string; fromEpoch: number; epochs: number[] }[] = [];
            for (const pk of node.roster) {
                const from = node.fromEpoch.get(pk) ?? 1;
                const epochs = [...node.epochs.keys()].filter((e) => e >= from && wrapsFor(pk, [e]).length === 0);
                if (epochs.length) missing.push({ pubkey: pk, fromEpoch: from, epochs });
            }
            return json(200, { epoch: node.current(), missing });
        }
        const wrapsRoute = p.match(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/keys/(\\d+)/wraps$`));
        if (method === 'GET' && wrapsRoute) {
            const r = node.epochs.get(Number(wrapsRoute[1]));
            if (!r) return json(404, { error: 'no epoch' });
            return json(200, { wraps: [...(r.wraps ?? []).map((w) => ({ ...w, wrapper: r.createdBy, sig: null })), ...node.topUps.filter((t) => t.epoch === r.epoch)] });
        }
        if (method === 'POST' && p === `${base}/keys/wrap`) {
            if (!node.roster.includes(body.recipient)) return json(403, { error: 'Top-up refused: its recipient is not an active member.' });
            node.topUps.push({ ...body, wrapper: me });
            return json(201, { ok: true });
        }
        if (method === 'POST' && /\/keys\/\d+\/reject$/.test(p)) return json(200, { missing: true });
        if (method === 'POST' && p === `${base}/chat/message`) {
            const cur = node.current();
            if (body.metadata?.epoch !== cur || node.stale) return json(409, { error: 'epoch', code: node.stale ? 'epoch_stale' : 'epoch_not_current' });
            node.lines.push({ id: body.clientId, author: me, ciphertext: body.ciphertext, nonce: body.nonce, metadata: { ...body.metadata, sender: me } });
            return json(201, { success: true });
        }
        if (method === 'POST' && p === '/api/messages/edit') {
            const l = node.lines.find((x) => x.id === body.messageId);
            if (!l) return json(404, { error: 'Message not found' });
            Object.assign(l, { ciphertext: body.ciphertext, nonce: body.nonce });
            return json(200, { success: true });
        }
        return json(404, { error: `no route ${method} ${p}` });
    }
    return node;
}
