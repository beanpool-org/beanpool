/**
 * How a tool's line is drawn (ToolLine, manifest.ts): the Tools screen's row and the Home card's lines, in both apps. A
 * sentence goes through t(); a wordn() pair through tn() with its count, so "1 thing" and "5 things" read right and
 * every language gets the form it needs. In the device's language at the moment it is drawn; never at module level.
 */
import { t, tn } from '../words.js';
import type { ToolLine } from './manifest.js';

export function toolLineText(line: ToolLine): string {
    return typeof line.key === 'string' ? t(line.key, line.values) : tn(line.n ?? 0, line.key.one, line.key.other, line.values);
}
