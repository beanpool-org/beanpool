/**
 * The open /ws sockets, indexed by their member's key and that member's area (#1791 item 5), so a listing's push on a
 * node that syncs by area (state-engine.ts listingReach) visits the sockets of its parties and of the members whose
 * area is in a 1° cell within the radius of its place, and not every socket.
 *
 * Exact under every change, because it is told of each one where it happens rather than by its callers:
 * - a socket in or out: this is the set state-engine.ts keeps them in (add, delete, clear), whatever removes one;
 * - a socket's key (`_memberPubkey`) set at connect, by a join, a re-key or a prune, or by anything else: on a socket in
 *   the set the property is an accessor that refiles it;
 * - a member's area set, cleared, imported, moved by a re-key or cleared by a removal: member-area.ts tells the index of
 *   every change to its map (onMemberAreasChanged), the one the filter itself reads.
 * The cells hold keys, never a distance: the radius is read at each push, and the filter still measures each socket
 * it visits exactly as before. A key with no area is in no cell, and is visited only as a party.
 */
import { memberAreaFor, memberAreasReady, onMemberAreasChanged } from './engine/member-area.js';
import { EARTH_RADIUS_KM } from '@beanpool/engine';

const KEY = Symbol('memberPubkey');
// A degree and a hair more on each side of a reach: the cells' bounds are measured in floating point, the filter's
// distance too, and the filter decides. Looking at one cell more than needed costs a lookup; one fewer, a missed push.
const MARGIN_DEG = 0.01;

/** The 1° cell's longitude index of a longitude, 0..359; 180 and -180 are one meridian and one cell. */
function lngCell(lng: number): number {
    return ((Math.floor(lng) % 360) + 360) % 360;
}

/** The keys with an open socket and an area, by 1° band of latitude, then 1° cell of longitude. */
class AreaCells {
    private bands = new Map<number, Map<number, Set<string>>>();
    private filed = new Map<string, [number, number]>();

    file(key: string): void {
        const area = memberAreaFor(key);
        if (!area) return;
        const band = Math.floor(area.lat), cell = lngCell(area.lng);
        let cells = this.bands.get(band);
        if (!cells) this.bands.set(band, cells = new Map());
        let keys = cells.get(cell);
        if (!keys) cells.set(cell, keys = new Set());
        keys.add(key);
        this.filed.set(key, [band, cell]);
    }

    unfile(key: string): void {
        const at = this.filed.get(key);
        if (!at) return;
        this.filed.delete(key);
        const cells = this.bands.get(at[0]);
        const keys = cells?.get(at[1]);
        if (!cells || !keys) return;
        keys.delete(key);
        if (keys.size === 0) cells.delete(at[1]);
        if (cells.size === 0) this.bands.delete(at[0]);
    }

    /**
     * Every key filed in a cell that a circle of `radiusKm` around the point may touch: its latitudes, and the widest
     * longitudes of the cap (asin(sin d / cos φ)), or every longitude where the cap reaches a pole.
     */
    forEachWithin(lat: number, lng: number, radiusKm: number, visit: (key: string) => void): void {
        const d = radiusKm / EARTH_RADIUS_KM;
        const dDeg = d * 180 / Math.PI + MARGIN_DEG;
        const lo = lat - dDeg, hi = lat + dDeg;
        const ratio = Math.sin(Math.min(d, Math.PI / 2)) / Math.cos(lat * Math.PI / 180);
        const allLng = lo <= -90 || hi >= 90 || d >= Math.PI / 2 || !(ratio < 1);
        const dLng = allLng ? 180 : Math.asin(ratio) * 180 / Math.PI + MARGIN_DEG;
        const west = Math.floor(lng - dLng), east = Math.floor(lng + dLng);
        const every = allLng || east - west + 1 >= 360;
        for (let band = Math.floor(Math.max(lo, -90)); band <= Math.floor(Math.min(hi, 90)); band++) {
            const cells = this.bands.get(band);
            if (!cells) continue;
            if (every) {
                for (const keys of cells.values()) for (const key of keys) visit(key);
                continue;
            }
            for (let c = west; c <= east; c++) {
                const keys = cells.get(lngCell(c));
                if (keys) for (const key of keys) visit(key);
            }
        }
    }
}

/** The open sockets (state-engine.ts wsClients): a Set, which also keeps the index above. */
export class WsClients extends Set<any> {
    private byKey = new Map<string, Set<any>>();
    // Built at the first push by area, then kept; dropped (and built again at the next) when the areas load again whole.
    private cells: AreaCells | null = null;

    constructor() {
        super();
        onMemberAreasChanged(keys => {
            if (!this.cells) return;
            if (keys === null) { this.cells = null; return; }
            for (const key of keys) {
                if (!this.byKey.has(key)) continue;
                this.cells.unfile(key);
                this.cells.file(key);
            }
        });
    }

    override add(ws: any): this {
        if (super.has(ws)) return this;
        super.add(ws);
        const key = ws._memberPubkey;
        const refile = (socket: any, old: unknown, value: unknown) => {
            if (this.has(socket)) { this.unlink(socket, old); this.link(socket, value); }
        };
        Object.defineProperty(ws, '_memberPubkey', {
            configurable: true,
            enumerable: true,
            get() { return this[KEY]; },
            set(value: unknown) {
                const old = this[KEY];
                this[KEY] = value;
                if (old !== value) refile(this, old, value);
            },
        });
        ws[KEY] = key;
        this.link(ws, key);
        return this;
    }

    override delete(ws: any): boolean {
        if (!super.delete(ws)) return false;
        this.unlink(ws, ws[KEY]);
        return true;
    }

    override clear(): void {
        for (const ws of [...this]) this.delete(ws);
    }

    private link(ws: any, key: unknown): void {
        if (typeof key !== 'string' || !key) return;
        let sockets = this.byKey.get(key);
        if (!sockets) {
            this.byKey.set(key, sockets = new Set());
            this.cells?.file(key);
        }
        sockets.add(ws);
    }

    private unlink(ws: any, key: unknown): void {
        if (typeof key !== 'string') return;
        const sockets = this.byKey.get(key);
        if (!sockets || !sockets.delete(ws) || sockets.size > 0) return;
        this.byKey.delete(key);
        this.cells?.unfile(key);
    }

    /**
     * The sockets a listing's push may reach: those of its parties, and of each member whose area is in a cell within
     * `radiusKm` of its place (none for a listing with no place). Every one the filter would pass is among them.
     */
    reachable(parties: Iterable<string>, place: { lat: number; lng: number } | null, radiusKm: number): any[] {
        const out = new Set<any>();
        const take = (key: string) => {
            const sockets = this.byKey.get(key);
            if (sockets) for (const ws of sockets) out.add(ws);
        };
        for (const key of parties) take(key);
        if (place) {
            if (!this.cells) {
                memberAreasReady();
                const cells = new AreaCells();
                for (const key of this.byKey.keys()) cells.file(key);
                this.cells = cells;
            }
            this.cells.forEachWithin(place.lat, place.lng, radiusKm, take);
        }
        return [...out];
    }
}
