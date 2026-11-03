/**
 * For a sheet whose fields live in a child component (ShopSheets' text field, ReportReasonBox): the sheet provides its
 * useScrollFieldIntoView helper, the field reads it and spreads `inputProps` on its TextInput. Outside such a sheet there
 * is no helper, and the field is exactly what it was. Kept apart from the hook so a field imports nothing native.
 */
import { createContext, useContext } from 'react';
import type { ScrollFieldIntoView } from './useScrollFieldIntoView';

export const ScrollFieldContext = createContext<ScrollFieldIntoView | null>(null);

export function useScrollFieldContext(): ScrollFieldIntoView | null {
    return useContext(ScrollFieldContext);
}
