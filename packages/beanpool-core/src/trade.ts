import { PassportManager } from './passport.js';
import { RouterManager } from './router.js';
import { LedgerManager } from './ledger.js';

export class TradeManager {
    private passportManager: PassportManager;
    private routerManager: RouterManager;
    private ledgerManager: LedgerManager;

    constructor(
        passportManager: PassportManager,
        routerManager: RouterManager,
        ledgerManager: LedgerManager
    ) {
        this.passportManager = passportManager;
        this.routerManager = routerManager;
        this.ledgerManager = ledgerManager;
    }

    /**
     * Confirms a trade between two nodes for a specific ResourcePin.
     * Validates required badges, executes the mutual credit transfer, 
     * updates standing scores, and cleans up the routing mesh.
     */
    confirmTrade(pinId: string, providerId: string, requesterId: string, amount: number): boolean {
        const pins = this.routerManager.getPins();
        const targetPin = pins.find(p => p.id === pinId);

        if (!targetPin) {
            console.error(`Trade failed: Pin ${pinId} not found in local router.`);
            return false;
        }

        // 1. Validation: Check if the provider has the required badge (if any)
        if (targetPin.requiredBadge) {
            const providerPassport = this.passportManager.getPassport();

            const hasRequiredBadge = providerPassport.badges.some(
                b => b.type === targetPin.requiredBadge
            );

            if (!hasRequiredBadge) {
                console.error(`Trade failed: Provider lacks required badge: ${targetPin.requiredBadge}`);
                return false;
            }
        }

        // 2. The Reward: Execute mutual credit transfer
        const transferSuccess = this.ledgerManager.transfer(requesterId, providerId, amount);

        if (!transferSuccess) {
            console.error(`Trade failed: Insufficient mutual credit for requester ${requesterId}.`);
            return false;
        }

        // 3. The Reward: Increase Standing Score via Contributions
        const timestamp = new Date().toISOString();

        // Add contribution for Requester
        this.passportManager.addContribution({
            id: `trade-req-${Date.now()}`,
            timestamp,
            signature: '0xmock_sig_req',
            payload: { action: 'trade_completed', role: 'requester', pinId }
        });

        // Note: In an actual P2P system, the provider would record their own contribution on their node.
        this.passportManager.addContribution({
            id: `trade-prov-${Date.now()}`,
            timestamp,
            signature: '0xmock_sig_prov',
            payload: { action: 'trade_completed', role: 'provider', pinId }
        });

        // 4. Cleanup: Mark as completed/delete to stop mesh broadcasting
        this.routerManager.removePin(pinId);

        console.log(`Trade ${pinId} confirmed fully between ${requesterId} and ${providerId} for ${amount} credits.`);
        return true;
    }
}
