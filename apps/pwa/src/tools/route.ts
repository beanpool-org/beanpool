/**
 * Where the tools' covered page is (scratch/tools/DESIGN-tool-template-fable.md §1.3, slice T0.3): App's openTool state
 * `{ id, screen, key }` and navigateToTab's context for it. Kept apart from pages/ToolsPage.tsx so App reads it without
 * loading the page, which is its own chunk.
 */

/** What App holds while the page is open: the Tools screen (id null) or one tool at one of its screens. */
export interface OpenTool {
    id: string | null;
    screen: string;
    key: string | null;
}

/** navigateToTab's context, `<id>` or `<id>?screen=<name>&key=<record>`, as an OpenTool; nothing at all: the Tools screen. */
export function parseToolTarget(target?: string | null): OpenTool {
    if (!target) return { id: null, screen: 'main', key: null };
    const at = target.indexOf('?');
    const id = at < 0 ? target : target.slice(0, at);
    const q = new URLSearchParams(at < 0 ? '' : target.slice(at + 1));
    return { id: id || null, screen: q.get('screen') || 'main', key: q.get('key') || null };
}

/** The other way: a tool's screen as navigateToTab's context. */
export function toolTarget(id: string, screen = 'main', key: string | null = null): string {
    const q = new URLSearchParams();
    if (screen !== 'main') q.set('screen', screen);
    if (key) q.set('key', key);
    const s = q.toString();
    return s ? `${id}?${s}` : id;
}
