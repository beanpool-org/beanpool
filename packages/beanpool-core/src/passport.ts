export interface Badge {
    type: string;
    level: number;
    issuedAt: Date | string; // Support string for easy JSON parsing later
}

export interface ContributionEvent {
    id: string;
    timestamp: Date | string;
    signature: string;
    payload: any;
}

export interface Passport {
    id: string; // decentralized identifier (DID)
    standing: number; // starts at 10
    badges: Badge[];
    contributions: ContributionEvent[];
}

export class PassportManager {
    private passport: Passport;
    private readonly MAX_STANDING = 100;
    private readonly BASE_STANDING = 10;

    constructor(id: string, initialData?: Partial<Passport>) {
        this.passport = {
            id,
            standing: this.BASE_STANDING,
            badges: [],
            contributions: [],
            ...initialData,
        };

        // Recalculate standing to ensure it matches badges if initialized with them
        if (initialData?.badges?.length) {
            this.calculateStanding();
        }
    }

    /**
     * The Genesis Protocol: Initializes a completely new node
     */
    initializeNewNode(): void {
        this.passport.badges = [{
            type: 'Civic',
            level: 1, // 'Genesis Badge'
            issuedAt: new Date().toISOString()
        }];

        // We explicitly set the standing to 10 as per rules, 
        // to enable immediate 'Claim' functionality for basic needs.
        this.passport.standing = 10;
        this.passport.contributions = [];
    }

    /**
     * Loads a complete passport state from storage
     */
    loadState(state: Passport): void {
        this.passport = state;
    }

    /**
     * Returns the current passport state
     */
    getPassport(): Passport {
        return { ...this.passport };
    }

    /**
     * Increases standing based on badges but caps it to prevent infinite accumulation
     */
    calculateStanding(): number {
        let calculatedStanding = this.BASE_STANDING;

        // A simple standing calculation logic based on badge levels length
        // Each badge level gives 2 points
        for (const badge of this.passport.badges) {
            calculatedStanding += badge.level * 2;
        }

        // Cap the standing at MAX_STANDING (e.g., 100)
        this.passport.standing = Math.min(calculatedStanding, this.MAX_STANDING);

        return this.passport.standing;
    }

    /**
     * Takes a signed event and updates the history
     */
    addContribution(event: ContributionEvent): void {
        // Basic validation could happen here

        // Optional: Add logic to award badges based on contributions automatically here
        // or just maintain history.
        this.passport.contributions.push(event);
    }

    /**
     * Method to explicitly add a badge and recalculate standing
     */
    addBadge(badge: Badge): void {
        this.passport.badges.push(badge);
        this.calculateStanding();
    }
}
