// @vitest-environment jsdom
/**
 * The card on its own at 320 dp with 130% text (slice C6; DESIGN-credit-list-fable.md test 14 and 22, with the amendments):
 * "What people who give credit see" read from `GET /api/credit/me` and drawn from core's creditMeCard. React Native's host
 * components are DOM with their styles (credit-rn-dom.ts), so what a screenshot needs is kept: wrapping, padding, scaled text.
 * The whole Ledger around it is credit-me-ledger-screen.test.ts. Nothing here contacts a node.
 *
 * With CREDIT_SHOTS_DIR set the same renders are written there as HTML for screenshots: Rob (no credit yet), Jane (−420 of
 * 1,300, confirmed, "An owner or admin can say more."), Sam after the gift (Balance 0, the two-sentence reason wrapped) and Val
 * (−437.13, Spending paused), in the Light, Classic and Dark colour sets. Without it they are not written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { creditMeCard, type CreditMeAnswer, type RiskReason } from '@beanpool/core';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const look = vi.hoisted(() => ({ set: 'light' as 'light' | 'dark' | 'night' }));
vi.mock('react-native', async () => (await import('./credit-rn-dom')).reactNativeDom());
vi.mock('expo-router', async () => {
    const { useEffect, useState } = await import('react');
    const again = new Set<() => void>();
    (globalThis as any).__shownAgain = () => again.forEach((f) => f());
    return {
        router: { push() {} },
        useFocusEffect: (cb: () => void) => {
            const [shown, setShown] = useState(0);
            useEffect(() => { const f = () => setShown((n) => n + 1); again.add(f); return () => { again.delete(f); }; }, []);
            useEffect(() => { cb(); }, [cb, shown]);
        },
    };
});
vi.mock('../../app/ThemeContext', async () => {
    const { COLOUR_SETS } = await import('../../constants/colors');
    const ctx = () => ({ theme: look.set === 'light' ? 'light' : 'dark', set: look.set, colors: COLOUR_SETS[look.set] });
    return { useTheme: ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx()) };
});

const world = vi.hoisted(() => ({
    reads: [] as { anchor: string; key: string }[],
    /** Each read waits on one of these, so a test decides when (and whether) the node answers. */
    pending: [] as { resolve: (r: { status: number; body: unknown }) => void }[],
    auto: null as null | { status: number; body: unknown },
}));
vi.mock('../node-post', () => ({
    signedGet: (anchor: string, p: string, identity: { publicKey: string }) => {
        if (p !== '/api/credit/me') return Promise.resolve(new Response('{}', { status: 404 }));
        world.reads.push({ anchor, key: identity.publicKey });
        const reply = (r: { status: number; body: unknown }) => new Response(JSON.stringify(r.body), { status: r.status });
        if (world.auto) return Promise.resolve(reply(world.auto));
        return new Promise<Response>((resolve) => { world.pending.push({ resolve: (r) => resolve(reply(r)) }); });
    },
    signedPost: () => new Promise(() => {}),
}));

import { CreditSeenByGivers } from '../../components/CreditSeenByGivers';
import { WINDOW } from './credit-rn-dom';

const IDENTITY = { publicKey: '9'.repeat(64), privateKey: 'x', callsign: 'Ana', createdAt: '2026-01-01T00:00:00.000Z' } as any;
const OTHER = { ...IDENTITY, publicKey: '8'.repeat(64) };
const giftReason: RiskReason = { code: 'over_half', level: 'medium', mark: 'giver', values: { owed: 90000, line: 100000, pct: 50, gift: 90000, giftDays: 30 } };
const answer = (o: Partial<CreditMeAnswer> & Record<string, unknown> = {}): CreditMeAnswer & Record<string, unknown> => ({
    memberPubkey: IDENTITY.publicKey, callsign: 'Ana', own: false, owed_c: 0, over_c: 0, paused: false,
    line_c: 0, usable_c: 0, liveOffers: 4, balance_c: 0, canGive: true, status: 'active',
    risk: { level: 'not_known', more: false, reasons: [{ code: 'new', level: 'not_known', mark: 'open', values: {} }] }, ...o,
});
const ROB = answer();
const JANE = answer({ line_c: 130000, usable_c: 130000, liveOffers: 1, balance_c: -42000, owed_c: 42000, risk: { level: 'low', more: true, reasons: [{ code: 'new', level: 'not_known', mark: 'open', values: {} }] } });
const SAM = answer({ line_c: 100000, usable_c: 100000, liveOffers: 0, balance_c: 0, risk: { level: 'high', more: true, reasons: [giftReason] } });
const VAL = answer({
    line_c: 80000, usable_c: 20000, liveOffers: 1, balance_c: -43713, owed_c: 43713,
    paused: true, risk: { level: 'medium', more: false, reasons: [{ code: 'over_half', level: 'medium', mark: 'giver', values: { owed: 43713, line: 80000, pct: 50 } }] },
});
const body = (me: unknown) => ({ status: 200, body: { told: 'x', me } });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    world.reads.length = 0; world.pending.length = 0; world.auto = null;
    look.set = 'light'; WINDOW.height = 569;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const mount = async (node: unknown) => { await act(async () => { root.render(node as any); }); for (let i = 0; i < 4; i++) await act(async () => {}); };
const card = (anchorUrl = 'https://n.example', identity = IDENTITY, reread: unknown = 0) => createElement(CreditSeenByGivers, { anchorUrl, identity, reread });
const shown = () => host.querySelector('[data-testid="credit-seen-by-givers"]');
const answerNext = async (r: { status: number; body: unknown }) => { await act(async () => { world.pending.shift()!.resolve(r); }); for (let i = 0; i < 3; i++) await act(async () => {}); };

describe('what is drawn', () => {
  it('nothing until the node answers, then the card from core line for line (red when it draws before the answer or composes a line)', async () => {
    await mount(card());
    expect(world.reads).toEqual([{ anchor: 'https://n.example', key: IDENTITY.publicKey }]);
    expect(shown()).toBeNull();
    await answerNext(body(JANE));
    const c = creditMeCard(JANE);
    const lines = Array.from(shown()!.querySelectorAll('[data-testid]')).map((e) => e.textContent);
    expect(lines).toEqual([c.credit, c.liveOffers, c.balance, `${c.shape} ${c.word}`, c.reasons[0], c.reasons[1], c.told]);
    expect(shown()!.textContent!.startsWith(c.title)).toBe(true);
  });

  it('Rob: no credit yet, 4 live Offers in the sentence once and not again below it (red when the Offers line is drawn twice)', async () => {
    await mount(card());
    await answerNext(body(ROB));
    expect(shown()!.textContent).toContain('No credit yet · 4 live Offers');
    expect(shown()!.querySelector('[data-testid="credit-seen-offers"]')).toBeNull();
    expect(shown()!.textContent).toContain('Balance 0');
    expect(shown()!.textContent).toContain('○ Credit risk: not known yet');
  });

  it('Val: Spending paused is marked, the balance is read aloud as minus (red when the sign or the mark is lost)', async () => {
    await mount(card());
    await answerNext(body(VAL));
    expect(shown()!.querySelector('[data-testid="credit-seen-paused"]')!.textContent).toBe('! Spending paused');
    const bal = shown()!.querySelector('[data-testid="credit-seen-balance"]')!;
    expect(bal.textContent).toBe('Balance −437.13 · using 437.13 of 800');
    expect(bal.getAttribute('aria-label')).toBe('Balance minus 437.13 Beans, using 437.13 of 800');
  });

  it('the shape and the word are both there for every level, never colour alone (red when a level loses its glyph)', async () => {
    for (const [level, glyph] of [['not_known', '○'], ['low', '✓'], ['medium', '!'], ['high', '✕']] as const) {
      world.auto = body(answer({ risk: { level, more: false, reasons: [] } }));
      await act(async () => { root.render(card('https://n.example', IDENTITY, level) as any); });
      for (let i = 0; i < 3; i++) await act(async () => {});
      expect(shown()!.querySelector('[data-testid="credit-seen-risk"]')!.textContent, level).toMatch(new RegExp(`^\\${glyph} Credit risk: `));
    }
  });

  it('wraps at 320 dp with 130% text and is never cut with an ellipsis (red when a line gets a one-line cap)', async () => {
    world.auto = body(SAM);
    await mount(card());
    const html = shown()!.outerHTML;
    expect(html).not.toMatch(/text-overflow|line-clamp|ellipsis|-webkit-box/i);
    expect(shown()!.textContent).not.toContain('…');
    for (const t of Array.from(shown()!.querySelectorAll('[data-testid]'))) expect(t.getAttribute('data-lines'), t.getAttribute('data-testid') ?? '').toBeNull();
    // Every line asks for the font scale to be capped at 130%, not more (the layout is judged at 1.3).
    expect(Array.from(shown()!.querySelectorAll('div')).every((d) => d.style.fontSize === '' || parseFloat(d.style.fontSize) <= 20 * 1.3)).toBe(true);
  });
});

describe('when it reads again', () => {
  it('a changed balance reads the node again; the card on screen stays until the new answer lands (red when it flickers away or reads twice for one change)', async () => {
    await mount(card('https://n.example', IDENTITY, -42000));
    await answerNext(body(JANE));
    expect(shown()!.textContent).toContain('Balance −420');
    await mount(card('https://n.example', IDENTITY, -50000));
    expect(world.reads).toHaveLength(2);
    expect(shown()!.textContent).toContain('Balance −420'); // still the old one, not blank
    await answerNext(body(answer({ ...JANE, balance_c: -50000 })));
    expect(shown()!.textContent).toContain('Balance −500');
    expect(shown()!.textContent).not.toContain('Balance −420');
    expect(world.reads).toHaveLength(2);
  });

  it('the screen shown again reads again, its first showing does not read twice (red when the focus effect doubles the first read)', async () => {
    world.auto = body(JANE);
    await mount(card());
    expect(world.reads).toHaveLength(1);
    await act(async () => { (globalThis as any).__shownAgain(); });
    for (let i = 0; i < 3; i++) await act(async () => {});
    expect(world.reads).toHaveLength(2);
  });

  it('a re-read the node refuses takes the card away rather than leaving a stale balance on screen (red when a refusal leaves the old figure)', async () => {
    await mount(card('https://n.example', IDENTITY, 1));
    await answerNext(body(JANE));
    expect(shown()).not.toBeNull();
    await mount(card('https://n.example', IDENTITY, 2));
    await answerNext({ status: 404, body: { error: 'Beans are off here.', code: 'beans_off' } });
    expect(shown()).toBeNull();
  });

  it('another member\'s card is never drawn for this one, and a late answer for the member before is dropped (red when the answer outlives its member)', async () => {
    await mount(card('https://n.example', IDENTITY));
    await mount(card('https://n.example', OTHER)); // the account changed before the first answer
    expect(world.reads.map((r) => r.key)).toEqual([IDENTITY.publicKey, OTHER.publicKey]);
    await answerNext(body(JANE)); // the first member's late answer
    expect(shown()).toBeNull();
    await answerNext(body(ROB));
    expect(shown()!.textContent).toContain('No credit yet · 4 live Offers');
  });
});

// ── Screenshots (only with CREDIT_SHOTS_DIR) ──────────────────────────────────────────────────────────────────────────
const SHOTS = process.env.CREDIT_SHOTS_DIR;
describe.skipIf(!SHOTS)('screenshots: 320 dp, 130% text, Light, Classic and Dark', () => {
  for (const set of ['light', 'dark', 'night'] as const) {
    it(`${set}: Rob, Jane, Sam after the gift, Val`, async () => {
      const { COLOUR_SETS } = await import('../../constants/colors');
      const c = (COLOUR_SETS as any)[set];
      for (const [name, me] of [['rob', ROB], ['jane', JANE], ['sam-gift', SAM], ['val-paused', VAL]] as const) {
        look.set = set;
        world.auto = body(me);
        await act(async () => { root.unmount(); });
        root = createRoot(host);
        await mount(card());
        fs.mkdirSync(SHOTS!, { recursive: true });
        // The Ledger's own page colour behind the card, so the card is judged where it sits.
        const html = `<!doctype html><meta charset="utf-8"><title>${name}</title><style>html,body{margin:0;background:#888}*{font-family:Roboto,"Helvetica Neue",Arial,sans-serif}
.frame{position:relative;width:320px;box-sizing:border-box;padding:16px;background:${c.surface.page};color:${c.text.body}}</style><div class="frame">${host.innerHTML}</div>`;
        fs.writeFileSync(path.join(SHOTS!, `${name}-${set}.html`), html);
      }
    });
  }
});
