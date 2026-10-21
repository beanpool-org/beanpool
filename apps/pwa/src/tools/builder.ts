/**
 * The web's host builder: constructs the host given to a tool's screens (DESIGN-tool-template-fable.md §1.4, slice T0.3).
 *
 * Kept in this file, which the eslint fence refuses a tool (eslint.config.mjs), so a tool cannot build an un-narrowed
 * host or bypass its manifest's declared permissions. Tools import only types from tools/host.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    TOOL_LIMITS, narrowHost, toolDocBytes,
    type ToolHost, type ToolHostBase, type ToolHostGrants, type ToolManifest, type ToolNeedDraft, type ToolOfferDraft, type ToolPermission,
} from '@beanpool/core';
import { MARKETPLACE_CATEGORIES_BY_ID } from '../lib/marketplace';
import { keepToolDoc, readToolRecord, removeToolRecord } from './store';

/** What App gives the host: who the owner is, the node, and its doors. */
export interface WebHostContext {
    owner: { kind: 'member' | 'enterprise'; publicKey: string; name: string };
    node: { url: string | null; profile: string; features: Record<string, unknown> | null };
    /** Into another screen of this tool (the covered page's openTool state). */
    navigate(screen: string, params?: Record<string, string>): void;
    /** The composer, opened prefilled; the member taps Post. */
    openComposer(draft: ComposerDraft): void;
    now?(): number;
    /** Whether the private copy on the node is on for this tool here (its setting, on a server that keeps copies). */
    nodeCopy?: boolean;
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
 * `set` writes it whole (its last sync with the node kept, tools/store.ts keepToolDoc) and refuses one over the bound,
 * then `afterWrite` (the node copy's sync); `reload` reads it again (after the node's copy was taken); `remove` takes this
 * browser's copy away and leaves the empty one.
 */
export function useToolDoc<D>(m: ToolManifest<D> | undefined, owner: string | null, afterWrite?: () => void) {
    const [state, setState] = useState<ToolDocState<D>>({ status: 'loading' });
    const current = useRef<D | null>(null);
    // Which read is the current one: a read for another tool or owner, or after the page closed, is dropped.
    const generation = useRef(0);
    const id = m?.id ?? null;
    const load = useCallback(async (): Promise<void> => {
        if (!m || !owner) return;
        const g = generation.current;
        const rec = await readToolRecord(owner, m.id);
        if (g !== generation.current) return;
        const doc = readDoc(m, rec?.body ?? null);
        current.current = doc;
        setState({ status: 'ready', doc, updatedAt: rec?.updatedAt ?? null });
    }, [id, owner, m]);
    useEffect(() => {
        if (!m || !owner) return;
        generation.current++;
        setState({ status: 'loading' });
        void load();
        return () => { generation.current++; };
    }, [id, owner]);

    const set = useCallback(async (next: D): Promise<void> => {
        if (!m || !owner) throw new ToolDocNotKept();
        const max = docMaxBytes(m as ToolManifest<unknown>);
        const bytes = toolDocBytes(next);
        if (bytes > max) throw new ToolDocTooBig(bytes, max);
        const updatedAt = new Date().toISOString();
        current.current = next;
        setState({ status: 'ready', doc: next, updatedAt });
        const kept = await keepToolDoc(owner, m.id, JSON.stringify(next), updatedAt);
        if (!kept) throw new ToolDocNotKept();
        afterWrite?.();
    }, [id, owner, m, afterWrite]);

    const remove = useCallback(async (): Promise<boolean> => {
        if (!m || !owner) return false;
        const gone = await removeToolRecord(owner, m.id);
        if (gone) {
            const empty = m.doc.empty();
            current.current = empty;
            setState({ status: 'ready', doc: empty, updatedAt: null });
        }
        return gone;
    }, [id, owner, m]);

    const get = useCallback((): D => current.current ?? (m ? m.doc.empty() : (null as D)), [m]);
    return { state, get, set, remove, reload: load };
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
export const COMPOSER_TITLE_CHARS = 120;
export const COMPOSER_DESCRIPTION_CHARS = 2000;
const clip = (s: unknown, n: number) => (typeof s === 'string' ? [...s].slice(0, n).join('') : '');

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

function webGrants(ctx: WebHostContext): Partial<ToolHostGrants> {
    return {
        offerDoor: (draft: ToolOfferDraft) => ctx.openComposer(composerDraft('offer', draft)),
        needDoor: (draft: ToolNeedDraft) => ctx.openComposer(composerDraft('need', draft)),
        nodeCopy: { on: ctx.nodeCopy ?? false },
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
