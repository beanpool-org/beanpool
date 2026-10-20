/**
 * The web's host: the only door from a tool to the app (scratch/tools/DESIGN-tool-template-fable.md §1.4, slice T0.3).
 * The same interface as the phone's (apps/native/tools/host.ts, T0.2); core holds its types and the one rule that narrows
 * it (@beanpool/core tools/host.ts `narrowHost`): a tool is given the base (owner, node, its document, navigation, the
 * time) and exactly the functions its manifest's permissions grant. An undeclared function is absent, not undefined.
 *
 * What the web grants today: `offer-door` and `need-door`, the composer opened prefilled (App's openDraft into the
 * page that owns the composer; nothing is posted until the member taps Post). Every other grant is absent here until the
 * slice that builds it: photos and camera with the first tool that keeps a photo, `node-copy` with T0.4, `deals`,
 * `posts` and `pricing-guide` with the server slices; `reminders` grants nothing (the web schedules none).
 *
 * The document is the store's (tools/store.ts): read once on open through the manifest's `read()` (any stored value,
 * never a throw), written whole by `set()`, refused over its byte bound with {@link ToolDocTooBig} so the tool says why.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    TOOL_LIMITS, narrowHost, toolDocBytes,
    type ToolHost, type ToolHostBase, type ToolHostGrants, type ToolManifest, type ToolNeedDraft, type ToolOfferDraft, type ToolPermission,
} from '@beanpool/core';
import { MARKETPLACE_CATEGORIES_BY_ID } from '../lib/marketplace';
import { readToolRecord, removeToolRecord, writeToolRecord } from './store';

/** What App gives the host: who the owner is, the node, and its doors. */
export interface WebHostContext {
    owner: { kind: 'member' | 'enterprise'; publicKey: string; name: string };
    node: { url: string | null; profile: string; features: Record<string, unknown> | null };
    /** Into another screen of this tool (the covered page's openTool state). */
    navigate(screen: string, params?: Record<string, string>): void;
    /** The composer, opened prefilled; the member taps Post. */
    openComposer(draft: ComposerDraft): void;
    now?(): number;
}

/** A document over its byte bound: set() refuses it whole, and the tool shows its own sentence. Nothing is written. */
export class ToolDocTooBig extends Error {
    readonly bytes: number;
    readonly max: number;
    constructor(bytes: number, max: number) {
        super(`The document is ${bytes} bytes; at most ${max} are kept.`);
        this.name = 'ToolDocTooBig';
        this.bytes = bytes;
        this.max = max;
    }
}

/** A write the browser didn't keep (no IndexedDB, a full disk, signed out in another tab): the screen still holds it. */
export class ToolDocNotKept extends Error {
    constructor() {
        super('The document was not kept in this browser.');
        this.name = 'ToolDocNotKept';
    }
}

/** The most bytes a tool's document may be: its own bound, never past the node's. */
export const docMaxBytes = (m: ToolManifest<unknown>): number => Math.min(m.doc.maxBytes ?? TOOL_LIMITS.docBytes, TOOL_LIMITS.docBytes);

/** Any stored text as the tool's document: the manifest's read(), and its empty() for anything it can't read. */
export function readDoc<D>(m: ToolManifest<D>, body: string | null): D {
    let raw: unknown = null;
    if (body !== null) {
        try { raw = JSON.parse(body); } catch { raw = null; }
    }
    try {
        return m.doc.read(raw);
    } catch {
        // read() never throws by the template's rule (check.ts refuses one that does); a host never trusts that alone.
        return m.doc.empty();
    }
}

/** Whether a document is the tool's empty one: the frame shows the two doors over it. */
export function isEmptyDoc<D>(m: ToolManifest<D>, doc: D): boolean {
    try {
        return JSON.stringify(doc) === JSON.stringify(m.doc.empty());
    } catch {
        return false;
    }
}

export type ToolDocState<D> =
    | { status: 'loading' }
    | { status: 'ready'; doc: D; updatedAt: string | null };

/**
 * The tool's one document for `owner`, from the store: loading, then ready (its empty one when nothing is kept).
 * `set` writes it whole and refuses one over the bound; `remove` takes this browser's copy away and leaves the empty one.
 */
export function useToolDoc<D>(m: ToolManifest<D> | undefined, owner: string | null) {
    const [state, setState] = useState<ToolDocState<D>>({ status: 'loading' });
    const current = useRef<D | null>(null);
    const id = m?.id ?? null;
    useEffect(() => {
        if (!m || !owner) return;
        let cancelled = false;
        setState({ status: 'loading' });
        readToolRecord(owner, m.id).then((rec) => {
            if (cancelled) return;
            const doc = readDoc(m, rec?.body ?? null);
            current.current = doc;
            setState({ status: 'ready', doc, updatedAt: rec?.updatedAt ?? null });
        });
        return () => { cancelled = true; };
        // The manifest is one of the registry's constants: its id names it.
    }, [id, owner]);

    const set = useCallback(async (next: D): Promise<void> => {
        if (!m || !owner) throw new ToolDocNotKept();
        const max = docMaxBytes(m as ToolManifest<unknown>);
        const bytes = toolDocBytes(next);
        if (bytes > max) throw new ToolDocTooBig(bytes, max);
        const updatedAt = new Date().toISOString();
        current.current = next;
        setState({ status: 'ready', doc: next, updatedAt });
        const kept = await writeToolRecord(owner, m.id, { body: JSON.stringify(next), updatedAt, syncedAt: null });
        if (!kept) throw new ToolDocNotKept();
    }, [id, owner]);

    const remove = useCallback(async (): Promise<boolean> => {
        if (!m || !owner) return false;
        const gone = await removeToolRecord(owner, m.id);
        if (gone) {
            const empty = m.doc.empty();
            current.current = empty;
            setState({ status: 'ready', doc: empty, updatedAt: null });
        }
        return gone;
    }, [id, owner]);

    const get = useCallback((): D => current.current ?? (m ? m.doc.empty() : (null as D)), [m]);
    return { state, get, set, remove };
}

/** What the composer is opened with: an Offer or a Need, its fields held to the composer's own. */
export interface ComposerDraft {
    type: 'offer' | 'need';
    title: string;
    description: string;
    category: string | null;
    credits: number | null;
    priceType: 'fixed' | 'hourly' | 'daily' | 'weekly' | 'monthly' | null;
    repeatable: boolean;
    cashAlsoNeeded: boolean;
}

const PRICE_TYPES = new Set(['fixed', 'hourly', 'daily', 'weekly', 'monthly']);
/** The composer's own bounds: a title the node takes, a description the form's box holds. */
export const COMPOSER_TITLE_CHARS = 120;
export const COMPOSER_DESCRIPTION_CHARS = 2000;
const clip = (s: unknown, n: number) => (typeof s === 'string' ? [...s].slice(0, n).join('') : '');

/**
 * A tool's draft as the composer takes it. What the composer has no field for yet is dropped (lendable, replacementValue,
 * lendMaxDays, shop, availableFrom: their server slices are to come), and so are photos (a tool's photos are the host's,
 * granted with `photos`, which the web has not built). A category the Market doesn't know, a price that isn't a whole
 * number of Beans from 0 up, or a price type the composer doesn't offer is left for the member to choose.
 */
export function composerDraft(type: 'offer', draft: ToolOfferDraft): ComposerDraft;
export function composerDraft(type: 'need', draft: ToolNeedDraft): ComposerDraft;
export function composerDraft(type: 'offer' | 'need', draft: ToolOfferDraft | ToolNeedDraft): ComposerDraft {
    const d = (draft ?? {}) as Partial<ToolOfferDraft>;
    const category = typeof d.category === 'string' && MARKETPLACE_CATEGORIES_BY_ID.has(d.category) ? d.category : null;
    const offer = type === 'offer';
    const credits = offer && typeof d.credits === 'number' && Number.isSafeInteger(d.credits) && d.credits >= 0 ? d.credits : null;
    const priceType = offer && typeof d.priceType === 'string' && PRICE_TYPES.has(d.priceType) ? d.priceType as ComposerDraft['priceType'] : null;
    return {
        type,
        title: clip(d.title, COMPOSER_TITLE_CHARS),
        description: clip(d.description, COMPOSER_DESCRIPTION_CHARS),
        category,
        credits,
        priceType,
        repeatable: offer && d.repeatable === true,
        cashAlsoNeeded: offer && d.cashAlsoNeeded === true,
    };
}

/** Every grant the web host can give today; a permission that names one it can't is simply not granted. */
function webGrants(ctx: WebHostContext): Partial<ToolHostGrants> {
    return {
        offerDoor: (draft: ToolOfferDraft) => ctx.openComposer(composerDraft('offer', draft)),
        needDoor: (draft: ToolNeedDraft) => ctx.openComposer(composerDraft('need', draft)),
    };
}

/**
 * The host given to the tool `m`: the base and the grants its permissions name, through core's narrowHost, so a function
 * it never declared is absent ('deals' in host is false) and a type error in its screens.
 */
export function webHostFor<D, P extends ToolPermission>(
    m: ToolManifest<D> & { permissions: readonly P[] }, ctx: WebHostContext, doc: ToolHostBase<D>['doc'],
): ToolHost<D, P> {
    const full: ToolHostBase<D> & Partial<ToolHostGrants> = {
        owner: ctx.owner,
        node: ctx.node,
        doc,
        navigate: (screen, params) => ctx.navigate(screen, params),
        now: () => (ctx.now ? ctx.now() : Date.now()),
        ...webGrants(ctx),
    };
    return narrowHost(full, m.permissions);
}

/** The host for a screen, made once per tool, context and document handle. */
export function useWebHost<D>(m: ToolManifest<D> | undefined, ctx: WebHostContext, doc: ToolHostBase<D>['doc']): ToolHost<D, ToolPermission> | null {
    return useMemo(() => (m ? webHostFor(m, ctx, doc) : null), [m, ctx, doc]);
}
