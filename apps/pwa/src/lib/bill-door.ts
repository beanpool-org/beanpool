/**
 * The Market's door to one bill (`onNavigate('marketplace', billDoor(id))`): Your deals → Bills with that bill's sheet
 * (components/Bills.tsx; DESIGN-getting-paid-fable §4.3). Every way in uses it: a bell row ({ to: 'bill' }), a notice or a
 * push (`screen: 'bill'`).
 */
export const BILL_DOOR = 'bill:';
export const billDoor = (billId: string): string => `${BILL_DOOR}${billId}`;
