/** lib/payment-request.ts: one id per confirmed payment, reused by every retry of it (the node pays it once). */
import { describe, it, expect } from 'vitest';
import { confirmPayment, sendConfirmedPayment } from './payment-request';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const noWait = { wait: async () => {} };

describe('one id per confirmed payment', () => {
    it('confirming a payment makes one id, a UUID, carried in its body with the fields as confirmed', () => {
        const p = confirmPayment({ amount: 12.5, debtId: 'd'.repeat(32) });
        expect(p.requestId).toMatch(UUID);
        expect(p.body).toEqual({ amount: 12.5, debtId: 'd'.repeat(32), requestId: p.requestId });
    });

    it('a second payment the member confirms, even for the same amount, is a new id', () => {
        const a = confirmPayment({ amount: 5 });
        const b = confirmPayment({ amount: 5 });
        expect(a.requestId).not.toBe(b.requestId);
    });

    it('the body cannot be changed after confirming: a retry sends what was confirmed', () => {
        const fields = { amount: 5 };
        const p = confirmPayment(fields);
        fields.amount = 6;
        expect(p.body.amount).toBe(5);
        expect(() => { (p.body as any).amount = 7; }).toThrow();
    });
});

describe('a retry reuses the id', () => {
    it('no answer, then an answer: two sends with the same id and body; the answer returned', async () => {
        const p = confirmPayment({ amount: 3 });
        const sent: unknown[] = [];
        const answers = [{ ok: false, status: 0 }, { ok: true, status: 200, value: { transactionId: 'tx-1', amount: 3 } }];
        const r = await sendConfirmedPayment(p, async (body) => { sent.push(body); return answers[sent.length - 1]; }, noWait);
        expect(r).toEqual(answers[1]);
        expect(sent).toEqual([p.body, p.body]);
        expect((sent[0] as any).requestId).toBe(p.requestId);
    });

    it('a thrown send (offline) is retried with the same id; the last throw is thrown', async () => {
        const p = confirmPayment({ amount: 3 });
        const ids: string[] = [];
        await expect(sendConfirmedPayment(p, async (body) => { ids.push(body.requestId); throw new Error('offline'); }, noWait)).rejects.toThrow('offline');
        expect(ids).toEqual([p.requestId, p.requestId, p.requestId]);
    });

    it('any answer from the node is final: a refusal is not sent again, nor a success without a status', async () => {
        const p = confirmPayment({ amount: 30 });
        let sends = 0;
        const refused = { ok: false, status: 409, message: 'You hold 5 Beans: you can pay the Commons only what you hold.' };
        expect(await sendConfirmedPayment(p, async () => { sends++; return refused; }, noWait)).toEqual(refused);
        expect(sends).toBe(1);
        const paid = { ok: true, value: { transactionId: 'tx-2', amount: 30 } };
        expect(await sendConfirmedPayment(p, async () => { sends++; return paid as { ok: boolean; status?: number }; }, noWait)).toEqual(paid);
        expect(sends).toBe(2);
    });

    it('no answer every time: `tries` sends, all with the one id, and the no-answer returned', async () => {
        const p = confirmPayment({ amount: 1 });
        const ids: string[] = [];
        const waits: number[] = [];
        const r = await sendConfirmedPayment(p, async (body) => { ids.push(body.requestId); return { ok: false, status: 0 }; },
            { tries: 4, wait: async (ms) => { waits.push(ms); } });
        expect(r).toEqual({ ok: false, status: 0 });
        expect(ids).toEqual(Array(4).fill(p.requestId));
        expect(waits).toEqual([1000, 2000, 3000]);
    });
});

describe('a browser without crypto.randomUUID (not a secure context)', () => {
    it('still makes a v4 UUID from its random bytes, a new one each time', () => {
        const own = crypto.randomUUID;
        Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
        try {
            const a = confirmPayment({ amount: 1 }), b = confirmPayment({ amount: 1 });
            expect(a.requestId).toMatch(UUID);
            expect(a.requestId).not.toBe(b.requestId);
        } finally {
            Object.defineProperty(crypto, 'randomUUID', { value: own, configurable: true });
        }
    });
});
