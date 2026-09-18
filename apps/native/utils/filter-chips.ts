/** One chip in a single-select filter row (components/FilterChipRow). */
export interface FilterChip<Id extends string = string> {
    id: Id;
    label: string;
    emoji?: string;
}
