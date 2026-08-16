import synonymData from './data/synonyms.json';

export const SYNONYM_MAP: Record<string, string[]> = synonymData as unknown as Record<string, string[]>;

export default SYNONYM_MAP;
