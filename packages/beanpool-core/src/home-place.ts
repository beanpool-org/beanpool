/**
 * Where Home's cards stand on a wide screen, and where a carried card lands (DESIGN-home-layout-fable.md §3.1, slice L1;
 * DESIGN-home-arrange-in-place-fable.md §2.3, slice A2). Pure, for both apps: the web packs its grid with `packHome`, and
 * a card held in Arrange goes to the place `placeLifted` picks, on the phone's one column as on the web's three.
 */

export const HOME_PACK_ROW_HEIGHT = 4;
export const HOME_PACK_ROW_GAP = 16;

export interface PackableCard {
    id: string;
    height: number;
    fullRow?: boolean;
}

export interface PackedCard {
    id: string;
    col: number;
    rowStart: number;
    rowSpan: number;
    fullRow?: boolean;
}

/**
 * At two or more columns, each card is placed under the column whose stack is shortest at that moment,
 * in the saved order. Full-row cards wait until every column is free and span them all.
 * At one column (or invalid counts), no placement is returned: one column gives no placement.
 */
export function packHome(cards: readonly PackableCard[], cols: number): PackedCard[] {
    if (!Number.isFinite(cols) || cols <= 1 || cards.length === 0) return [];
    const columnCount = Math.floor(cols);
    const bottoms = new Array(columnCount).fill(1);
    const result: PackedCard[] = [];

    for (const card of cards) {
        const h = Math.max(0, card.height || 0);
        const span = Math.ceil((h + HOME_PACK_ROW_GAP) / HOME_PACK_ROW_HEIGHT);

        if (card.fullRow) {
            const rowStart = Math.max(...bottoms);
            result.push({
                id: card.id,
                col: 1,
                rowStart,
                rowSpan: span,
                fullRow: true,
            });
            bottoms.fill(rowStart + span);
        } else {
            let minIdx = 0;
            let minVal = bottoms[0];
            for (let c = 1; c < columnCount; c++) {
                if (bottoms[c] < minVal) {
                    minVal = bottoms[c];
                    minIdx = c;
                }
            }
            const col = minIdx + 1;
            const rowStart = bottoms[minIdx];
            result.push({
                id: card.id,
                col,
                rowStart,
                rowSpan: span,
            });
            bottoms[minIdx] += span;
        }
    }
    return result;
}

/**
 * `items` with the card `id` brought to place `to` among the cards named in `movable` (their ids, in `items`' order),
 * every other item keeping its slot: a drag's live preview and its drop. Arrange moves among the cards Home draws that
 * stand on the member's list, which is a narrower set than the types that can move.
 */
export function reorderIds<T extends { id: string }>(items: readonly T[], movable: readonly string[], id: string, to: number): T[] {
    const slots = items.flatMap((c, i) => (movable.includes(c.id) ? [i] : []));
    const order = slots.map(i => items[i]);
    const from = order.findIndex(c => c.id === id);
    const out = [...items];
    if (from < 0) return out;
    order.splice(to, 0, ...order.splice(from, 1));
    slots.forEach((slot, k) => { out[slot] = order[k]; });
    return out;
}

/** One thing in Home's grid, for `placeLifted`: a card (movable or not), a note, the strip, the tile. */
export interface PlaceItem extends PackableCard {
    movable?: boolean;
}

export interface PlaceBox { x: number; y: number; width: number; height: number }

/**
 * Each item's box in px, from the first column's left edge and the grid's top. One column is a plain stack: each item
 * under the last, `gap` between them. Two or more are `packHome`'s cells: `colWidth` wide, `gap` between columns, and
 * 4 px row tracks from the top (the grid has no row gap when packed; the space under a card is in its span).
 */
export function placedBoxes(items: readonly PackableCard[], cols: number, colWidth: number, gap: number): Map<string, PlaceBox> {
    const boxes = new Map<string, PlaceBox>();
    if (!(cols > 1)) {
        let y = 0;
        for (const it of items) {
            const height = Math.max(0, it.height || 0);
            boxes.set(it.id, { x: 0, y, width: colWidth, height });
            y += height + gap;
        }
        return boxes;
    }
    const n = Math.floor(cols);
    const heights = new Map(items.map(it => [it.id, Math.max(0, it.height || 0)]));
    for (const p of packHome(items, n)) {
        boxes.set(p.id, {
            x: p.fullRow ? 0 : (p.col - 1) * (colWidth + gap),
            y: (p.rowStart - 1) * HOME_PACK_ROW_HEIGHT,
            width: p.fullRow ? n * colWidth + (n - 1) * gap : colWidth,
            height: heights.get(p.id) ?? 0,
        });
    }
    return boxes;
}

/** How far a point is from a box: 0 inside it or on its edge, else the straight line to its nearest edge. */
function distance(p: { x: number; y: number }, b: PlaceBox): number {
    const dx = p.x < b.x ? b.x - p.x : p.x > b.x + b.width ? p.x - (b.x + b.width) : 0;
    const dy = p.y < b.y ? b.y - p.y : p.y > b.y + b.height ? p.y - (b.y + b.height) : 0;
    return Math.hypot(dx, dy);
}

/**
 * Where a card held in Arrange lands (design §2.3): the place among the movable cards whose layout puts the card nearest
 * the pointer, 0 when the pointer is inside it. `items` are the grid's things in the live order, the lifted card among
 * them; `point` is from the first column's left edge and the grid's top. A tie goes to the place nearest `current`, then
 * the smaller one. The answer depends on the pointer and the heights alone, never on the last answer, so a still pointer
 * can't make it flip back and forth. Returns `current` for a card that isn't movable.
 *
 * One column (every phone): the card goes where you point, and what was under your finger moves down. Two or three: as
 * near as the balanced columns allow; the preview (the card laid out at that place) shows it before you let go.
 */
export function placeLifted(
    items: readonly PlaceItem[], liftedId: string, point: { x: number; y: number }, cols: number, colWidth: number, gap: number, current: number,
): number {
    const movable = items.filter(it => it.movable).map(it => it.id);
    if (!movable.includes(liftedId)) return current;
    let best = current;
    let bestD = Infinity;
    for (let to = 0; to < movable.length; to++) {
        const box = placedBoxes(reorderIds(items, movable, liftedId, to), cols, colWidth, gap).get(liftedId);
        if (!box) continue;
        const d = distance(point, box);
        const nearer = d < bestD - 1e-6;
        const tie = !nearer && Math.abs(d - bestD) <= 1e-6;
        if (nearer || (tie && (Math.abs(to - current) < Math.abs(best - current) || (Math.abs(to - current) === Math.abs(best - current) && to < best)))) {
            best = to;
            bestD = d;
        }
    }
    return best;
}
