/**
 * The web keyring's guards against a dishonest node in memory (the PR's fake node, made to lie): the cases the review of
 * #1816 found no test pinned (finding 5; its driver's KX1–KX5, ported as they are). Each fails when its guard is removed:
 * KX1 the record's membersDigest at a top-up (decision a), KX2 a removed member, KX3 a stale epoch, KX4 an edit under the
 * line's own epoch, KX5 a record whose maker is in no roster.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { groupKeyring, forgetGroupKeys, memoryGroupLockStore } from './group-chat-keys';
import { makeEpochRecord, openGroupTopUp, sealLine, openLine } from './group-chat-crypto';
import { sendSealedGroupLine, editSealedGroupLine } from './group-chat-lines';
import { fakeGroupNode, person } from './group-chat-fake-node.test-support';
import { wrapGroupKey, groupKeyCommit, groupMembersDigest, groupWrapsDigest, groupEpochCanonical, toEd25519Seed, type GroupEpochRecord } from '@beanpool/core';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, utf8ToBytes, randomBytes } from '@noble/hashes/utils.js';

/** What a dishonest node can write without core's make guard: a record by a key in no roster, wrapped to `recipients`. */
function nodeMadeRecord(groupId: string, epoch: number, makerPrivHex: string, makerPub: string, recipients: string[]): { record: GroupEpochRecord; key: Uint8Array } {
    const key = randomBytes(32);
    const wraps = recipients.map((r) => wrapGroupKey(key, { groupId, epoch, recipientPubHex: r, wrapperPubHex: makerPub }));
    const head = { groupId, epoch, reason: 'rotate' as const, subject: null, createdBy: makerPub, createdAt: new Date().toISOString(),
        keyCommit: groupKeyCommit(key), membersDigest: groupMembersDigest(recipients), wrapsDigest: groupWrapsDigest(wraps) };
    const seed = toEd25519Seed(hexToBytes(makerPrivHex));
    const sig = Buffer.from(ed25519.sign(sha256(utf8ToBytes(groupEpochCanonical(head))), seed)).toString('base64');
    return { record: { ...head, sig, wraps }, key };
}

const G = '7a1d2c3b-4a59-4e68-9d7c-8b9a0f1e2d3c';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => forgetGroupKeys());

describe('a dishonest node: the keyring guards (review of #1816, KX1–KX5)', () => {
    it("KX1 (decision a, K10): a wraps answer that adds Eve, whom the node shows and lists as missing, gets her no top-up: the record's membersDigest refuses the set", async () => {
        const ana = person(true); const ben = person(); const eve = person();
        const node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
        await groupKeyring(node.as(ben.publicKey), ben, G, memoryGroupLockStore()).prepareToSeal();
        forgetGroupKeys();
        const rec = node.epochs.get(1)!;
        node.shown = [...node.shown, eve.publicKey];
        const topUps: any[] = [];
        node.lie = (method, path, _me, body) => {
            if (method === 'GET' && path === `/api/groups/${G}/keys/missing`) return json(200, { epoch: 1, missing: [{ pubkey: eve.publicKey, fromEpoch: 1, epochs: [1] }] });
            if (method === 'GET' && path === `/api/groups/${G}/keys/1/wraps`) {
                const real = rec.wraps!.map((w) => ({ ...w, wrapper: rec.createdBy, sig: null }));
                return json(200, { wraps: [...real, { ...real[0], recipient: eve.publicKey }] });
            }
            if (method === 'POST' && path === `/api/groups/${G}/keys/wrap`) { topUps.push(body); return json(201, { ok: true }); }
            return undefined;
        };
        const ring = groupKeyring(node.as(ana.publicKey), ana, G, memoryGroupLockStore());
        await ring.sync([1]);
        const sent = await ring.serveMissing();
        let eveReads: string | null = null;
        if (topUps[0]) {
            const key = openGroupTopUp(G, { ...topUps[0], wrapper: ana.publicKey }, eve.privateKey, rec.keyCommit);
            const id = crypto.randomUUID();
            const line = sealLine('Ben: only for Ana and me', { myEdPrivHex: ben.privateKey, groupKey: key, groupId: G, epoch: 1, messageId: id });
            eveReads = openLine(line, { groupId: G, epoch: 1, senderPubHex: ben.publicKey, messageId: id }, key).text;
        }
        expect(sent).toBe(0);
        expect(topUps).toHaveLength(0);
    });

    it("KX2 (K11): a member removed with no new epoch and nothing marked stale: the next line goes under a new epoch the removed member can't open", async () => {
        const ana = person(true); const ben = person(); const cat = person();
        const node = fakeGroupNode(G, [ana.publicKey, ben.publicKey, cat.publicKey]);
        const store = memoryGroupLockStore();
        await groupKeyring(node.as(ana.publicKey), ana, G, store).prepareToSeal();
        forgetGroupKeys();
        node.roster = [ana.publicKey, ben.publicKey].sort();
        node.shown = [ana.publicKey, ben.publicKey];
        const { epoch } = await groupKeyring(node.as(ana.publicKey), ana, G, store).prepareToSeal();
        const recipients = node.epochs.get(epoch)?.wraps?.map((w) => w.recipient) ?? [];
        expect(epoch).toBe(2);
        expect(recipients).not.toContain(cat.publicKey);
    });

    it('KX3 (K12): a stale epoch (a leave) is never sealed under, even when the node would take the line', async () => {
        const ana = person(true); const ben = person();
        const node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
        const store = memoryGroupLockStore();
        await groupKeyring(node.as(ana.publicKey), ana, G, store).prepareToSeal();
        forgetGroupKeys();
        node.stale = true;
        const { epoch } = await groupKeyring(node.as(ana.publicKey), ana, G, store).prepareToSeal();
        expect(epoch).toBe(2);
    });

    it("KX4 (L5): an edit after a newcomer's epoch stays under the line's own epoch: the newcomer holds no key for it", async () => {
        const ana = person(true); const ben = person(); const cat = person();
        const node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
        const store = memoryGroupLockStore();
        const clientId = crypto.randomUUID();
        await sendSealedGroupLine(node.as(ana.publicKey), ana, store, { groupId: G, text: 'before Cat', clientId });
        // Cat joins with no epoch (the web's own join): stale; Ben's next line rotates to epoch 2 for all three.
        node.roster = [ana.publicKey, ben.publicKey, cat.publicKey].sort();
        node.shown = [...node.shown, cat.publicKey];
        node.fromEpoch.set(cat.publicKey, 2);
        node.stale = true;
        forgetGroupKeys();
        await sendSealedGroupLine(node.as(ben.publicKey), ben, memoryGroupLockStore(), { groupId: G, text: 'welcome Cat', clientId: crypto.randomUUID() });
        forgetGroupKeys();
        const line = node.lines.find((l) => l.id === clientId)!;
        await editSealedGroupLine(node.as(ana.publicKey), ana, store, { groupId: G, messageId: clientId, metadata: line.metadata, text: 'before Cat (edited)' });
        const edit = node.calls.filter((c) => c.path === '/api/messages/edit').pop()!;
        expect(node.current()).toBe(2);
        expect(edit.body.metadata.epoch).toBe(1);
    });

    it("KX5 (K15): the node's own epoch, signed by a key in no roster and wrapped exactly to today's roster, is never sealed under: this browser rotates", async () => {
        const ana = person(true); const ben = person(); const puppet = person();
        const node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
        const store = memoryGroupLockStore();
        await groupKeyring(node.as(ana.publicKey), ana, G, store).prepareToSeal();
        forgetGroupKeys();
        // The node writes epoch 2 itself: a key it knows (K'), signed by its puppet, wrapped to exactly Ana and Ben.
        const { record, key: nodeKey } = nodeMadeRecord(G, 2, puppet.privateKey, puppet.publicKey, [ana.publicKey, ben.publicKey]);
        node.epochs.set(2, record);
        const { epoch, key } = await groupKeyring(node.as(ana.publicKey), ana, G, store).prepareToSeal();
        const nodeReads = Buffer.from(key).equals(Buffer.from(nodeKey));
        expect(nodeReads).toBe(false);
        expect(epoch).toBe(3);
    });
});
