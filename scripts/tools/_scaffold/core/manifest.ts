/**
 * The tool's manifest (docs/tools-template.md step 2): what the Tools screen, the shelves, Home and the size check read.
 * Pure: words through word(), one emoji, the permissions it uses and no more. Written by scripts/tools/new-tool.mjs from
 * scripts/tools/_scaffold: replace every word('…') below with the tool's own.
 */
import { word } from '../../words.js';
import type { ToolScreenProps } from '../host.js';
import type { ToolManifest, ToolPermission } from '../manifest.js';
import { SCAFFOLD_DOC_VERSION, emptyScaffoldDoc, readScaffoldDoc, type ScaffoldDoc } from './doc.js';

/**
 * What the tool asks of the app, each in words in its PR ("what leaves the phone"). Empty: it keeps its document and
 * nothing else. Add one only for a host function a screen calls (manifest.ts TOOL_PERMISSIONS).
 */
export const SCAFFOLD_PERMISSIONS = [] as const satisfies readonly ToolPermission[];
export type ScaffoldPermission = (typeof SCAFFOLD_PERMISSIONS)[number];
/** What each of its screens is drawn with: the host, narrowed to its permissions. */
export type ScaffoldScreenProps = ToolScreenProps<ScaffoldDoc, ScaffoldPermission>;

export const SCAFFOLD: ToolManifest<ScaffoldDoc> = {
    id: 'scaffold',
    name: word('New tool'),
    line: word('One line on what this tool keeps for you.'),
    icon: '🧩',
    shelf: 'stock',
    shopKinds: 'all',
    owner: 'member',
    permissions: SCAFFOLD_PERMISSIONS,
    doc: { version: SCAFFOLD_DOC_VERSION, empty: emptyScaffoldDoc, read: readScaffoldDoc },
    screens: ['main'],
    row: (doc) => (doc.items.length > 0 ? { key: word('Kept here: {count}'), values: { count: doc.items.length } } : null),
    examples: [word('A first example'), word('A second example'), word('A third example')],
    // Only for a tool with something to say on Home; delete it otherwise. The card is offered once from inside the tool.
    homeCard: {
        line: word('What your new tool keeps, at a glance.'),
        lines: (doc) => {
            const last = doc.items[doc.items.length - 1];
            return last ? [{ key: word('Latest: {name}'), values: { name: last.name }, screen: 'main' }] : [];
        },
    },
    // reminders: { list: [{ id, name: word('…'), defaultOn }], due(doc, now) } with 'reminders' in the permissions.
};
