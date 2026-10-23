/**
 * The host: the only door from a tool to the app (scratch/tools/DESIGN-tool-template-fable.md §1.4). These are its
 * types, shared by the phone's and the web's hosts (T0.2, T0.3), and the one rule both use to narrow it: a tool is given
 * the base (owner, node, its document, navigation and back, the time) and exactly the functions its manifest's permissions grant.
 * An undeclared function is absent at runtime ({@link narrowHost}) and a type error at build ({@link ToolHost}).
 *
 * The draft shapes carry what the composers take today; a field a server slice adds (lendable, shop, availableFrom) is
 * dropped by the host until that slice lands. Pure: no I/O.
 */
import type { ToolId, ToolPermission } from './manifest.js';

/** A photo kept on the device for a tool (never inside the document, never on the node until listed): its ref. */
export interface ToolPhoto {
    ref: string;
    width: number;
    height: number;
}

/** The Offer composer's draft (the Offer sheet's own fields, no pin). Nothing is posted until the member taps Post. */
export interface ToolOfferDraft {
    title: string;
    description?: string;
    category?: string;
    credits?: number;
    priceType?: string;
    repeatable?: boolean;
    cashAlsoNeeded?: boolean;
    photos?: readonly string[];
    /** Server slices to come (S3, S1, G3): dropped by the host until each lands. */
    lendable?: boolean;
    replacementValue?: string;
    lendMaxDays?: number;
    shop?: boolean;
    availableFrom?: string;
}
export interface ToolNeedDraft {
    title: string;
    description?: string;
    category?: string;
}
export interface ToolEventDraft {
    title: string;
    description?: string;
    startsAt?: string;
}
/** One of the owner's deals on a post the tool listed: the owner is its seller or lender, never its buyer. */
export interface ToolDealSummary {
    postId: string;
    transactionId: string;
    /** The deal's own status: 'requested' (asked, nothing held), 'pending' (agreed, the thing out), 'completed', 'cancelled', 'rejected'. */
    status: string;
    /** When it last changed as the app knows it: a pending deal's hand-over, a completed one's end, else when it was asked. */
    updatedAt: string;
    /** A loan that is out: when it is due back (@beanpool/core lendBackAroundOf), when the app knows. A date, never a name. */
    backAround?: string;
}
/** One of the owner's own Offers the app holds (live, in a deal, or paused): what a tool may link a record of its to. */
export interface ToolOwnOffer {
    id: string;
    /** As the owner wrote it. */
    title: string;
    status: ToolPostStatus;
}
export interface ToolPriceHint {
    credits: number;
    priceType?: string;
}
export type ToolPostStatus = 'active' | 'pending' | 'paused' | 'gone';

/**
 * The code `posts.resume` rejects with when the Offer is in its owner's shop and the shop is closed for now (the node's
 * 409 `shop_paused`): the server answered, and nothing in that shop goes back up until its owner reopens it.
 */
export const TOOL_SHOP_CLOSED = 'shop_paused';

/** Whether a `posts` call was refused because the Offer's shop is closed for now ({@link TOOL_SHOP_CLOSED}). */
export function isShopClosedRefusal(e: unknown): boolean {
    return !!e && typeof e === 'object' && (e as { code?: unknown }).code === TOOL_SHOP_CLOSED;
}

/** What every tool is given, whatever it asked for. */
export interface ToolHostBase<D> {
    owner: { kind: 'member' | 'enterprise'; publicKey: string; name: string };
    node: { url: string | null; profile: string; features: Record<string, unknown> | null };
    /**
     * The one store (§1.6): set() writes the document whole and syncs it, and refuses one over maxBytes(): the most it may
     * take now (toolDocMaxBytes: the tool's own bound, never past what the community's server said it keeps). One no
     * bigger than the document it holds is taken even so, so a document already past the bound can be made smaller.
     */
    doc: { get(): D; set(next: D): Promise<void>; maxBytes(): number };
    /** Within the tool; back is the host's. */
    navigate(screen: string, params?: Record<string, string>): void;
    /** Back, as the header's ← goes: what a form does once it is saved (the screen it was opened from, else out of the tool). */
    back(): void;
    now(): number;
}

/** What a permission grants, one host function each. */
export interface ToolHostGrants {
    photos: { pick(): Promise<ToolPhoto | null>; remove(ref: string): Promise<void>; uri(ref: string): string };
    camera: { take(): Promise<ToolPhoto | null> };
    place: () => Promise<{ lat: number; lng: number; source: 'community' | 'area' | 'device' } | null>;
    offerDoor: (draft: ToolOfferDraft) => void;
    needDoor: (draft: ToolNeedDraft) => void;
    eventDoor: (draft: ToolEventDraft) => void;
    deals: () => Promise<ToolDealSummary[]>;
    pricingGuide: (category: string, words: string) => Promise<ToolPriceHint | null>;
    /**
     * The owner's own Offers only: pause and resume one, ask its status ('gone' for one that isn't the owner's), and list
     * them (`mine`), so a tool can link a record to the Offer the member posted from its draft (the composer posts it;
     * nothing tells the tool its id). The status is the community's server's, asked each time. A pause is the owner's own
     * and is taken for one live or already paused: a shop closed for now pauses its Offers, and the owner's pause makes
     * one theirs, so the shop's reopen leaves it down. A resume of one whose shop is closed for now rejects with
     * {@link TOOL_SHOP_CLOSED}.
     */
    posts: { pause(id: string): Promise<void>; resume(id: string): Promise<void>; status(id: string): Promise<ToolPostStatus>; mine(): Promise<ToolOwnOffer[]> };
    /** Read-only here: the toggle is the host's Settings row. */
    nodeCopy: { on: boolean };
}

/**
 * Which host function each permission grants. `reminders` grants none: the host schedules what the manifest's due()
 * says, and the tool calls nothing.
 */
export const TOOL_PERMISSION_GRANTS = {
    photos: 'photos',
    camera: 'camera',
    place: 'place',
    reminders: null,
    'offer-door': 'offerDoor',
    'need-door': 'needDoor',
    'event-door': 'eventDoor',
    deals: 'deals',
    'pricing-guide': 'pricingGuide',
    posts: 'posts',
    'node-copy': 'nodeCopy',
} as const satisfies Record<ToolPermission, keyof ToolHostGrants | null>;

type Granted<P extends ToolPermission> = Exclude<(typeof TOOL_PERMISSION_GRANTS)[P], null>;

/** The host a tool with permissions `P` is given: the base and its grants, nothing else. */
export type ToolHost<D, P extends ToolPermission = never> = ToolHostBase<D> & Pick<ToolHostGrants, Granted<P>>;

const BASE_KEYS: readonly (keyof ToolHostBase<unknown>)[] = ['owner', 'node', 'doc', 'navigate', 'back', 'now'];

/**
 * The host given to a tool: from the app's whole host, the base and only what `permissions` grant. Every other key is
 * absent (not undefined-valued: absent), so `'deals' in host` is false for a tool that never asked.
 */
export function narrowHost<D, P extends ToolPermission>(
    full: ToolHostBase<D> & Partial<ToolHostGrants>, permissions: readonly P[],
): ToolHost<D, P> {
    const out: Record<string, unknown> = {};
    for (const key of BASE_KEYS) out[key] = full[key];
    for (const p of permissions) {
        const key = TOOL_PERMISSION_GRANTS[p];
        if (key !== null && full[key] !== undefined) out[key] = full[key];
    }
    return out as ToolHost<D, P>;
}

/** What a tool's screen is drawn with: its host and the route's params (`key`, a record id, and any the tool set). */
export interface ToolScreenProps<D, P extends ToolPermission = never> {
    host: ToolHost<D, P>;
    params: Readonly<Record<string, string>>;
}
/** Props every tool's screen accepts, whatever its document and permissions: what an app's registry types screens by. */
export type AnyToolScreenProps = ToolScreenProps<never, ToolPermission>;

/**
 * One app's half of a tool (apps/native/tools/<id>/index.ts, apps/pwa/src/tools/<id>/index.ts), `C` the app's
 * component type. `screens` is a thunk: on the phone a require() inside it is bundled but evaluated on first open
 * (Metro's inlineRequires is off), so a tool's module scope costs app start nothing.
 */
export interface ToolApp<C> {
    id: ToolId;
    /** One component per name in the manifest's `screens`. */
    screens(): Readonly<Record<string, C>>;
    /** Draws the Home card's lines (the manifest works them out). Only for a tool with a `homeCard`. */
    homeBody?(): C;
}
