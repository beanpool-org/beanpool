# BeanPool Commons Pool & Solvency Protocol

This document provides transparent documentation on the design, economics, and necessity of the **Commons Pool** and **Transactional Fee** in the BeanPool mutual credit network.

---

## 1. The Mutual Credit Zero-Sum Invariant ($\sum B_i = 0$)

Unlike traditional economies, BeanPool has no central bank or token supply. It is a **mutual credit network** where credits (Beans) are created on-demand at the moment of exchange.

When Alice pays Bob $40\text{ Beans}$ for general labour:
* Alice's balance decreases by $40\text{ Beans}$ (she goes into debt).
* Bob's balance increases by $40\text{ Beans}$ (he gains credit).
* The network sum remains exactly zero: $(−40) + (+40) = 0$.

For the protocol to remain structurally sound, **the sum of all balances in the network must always equal exactly zero**:
$$\sum_{i} B_i = 0$$

---

## 2. The Inactive Account Burden (Bad Debt & Closed Accounts)

When members leave the community or become inactive, their accounts must eventually be pruned (closed) by node admins to keep the directory clean. This presents a severe protocol-economics challenge:

### The Default Payout (Negative Balances)
If an inactive member has a negative balance (e.g., $−120\text{ Beans}$) and their account is pruned, deleting them would leave the network unbalanced ($\sum B_i > 0$). This is "dead debt"—the member received value from the community but left without giving back.
* **The Solvency Rule**: To delete the account and maintain the zero-sum invariant, the community must pay off the debt. The **Commons Pool** executes an automated, offsetting transfer of $+120\text{ Beans}$ to the member's account to bring their balance to exactly `0` before they are marked pruned.

### The Surplus Reclaim (Positive Balances)
Conversely, if an inactive member has a positive balance (e.g., $+200\text{ Beans}$) and is pruned, deleting them would destroy credits, unbalancing the network in the other direction ($\sum B_i < 0$).
* **The Solvency Rule**: The community reclaims the surplus. An automated transfer of $-200\text{ Beans}$ moves the positive balance from the pruned account into the **Commons Pool**, returning the dormant value back to the community ledger.

---

## 3. The Circulation Paradox: Why Demurrage Alone Fails

Previously, the Commons Pool was funded solely via **Community Circulation (demurrage)**—the gradual decay of positive holdings. However, demurrage suffers from a design paradox in healthy local economies:

1. **Velocity of Money**: A healthy economy has high trade velocity, meaning members spend their earned credits quickly rather than hoarding them.
2. **The Green Zone**: Active members keep their balances in the lower brackets (e.g., under $200\text{ Beans}$, which is tax-free) to maintain reciprocity.
3. **The Revenue Gap**: If hoarding is low, demurrage tax revenue drops to nearly **zero**. Yet, defaults still happen when inactive users are pruned. This leaves the Commons Pool empty and unable to absorb bad debt write-offs, threatening the ledger's balance.

---

## 4. The 1.5% Transactional Fee Solution

To resolve the circulation paradox and protect the ledger, the protocol introduces a flat **1.5% Transactional Fee** on direct P2P transfers and completed marketplace trades.

* **Proportional Funding**: The fee funds the Commons Pool in direct proportion to economic activity. The more trading that occurs, the healthier the Commons Pool becomes.
* **Exempted Holds & Cancellations**: The fee is *only* applied on successful, completed economic exchanges. All escrow holds (deposits) and cancelled trades (refunds) are completely fee-exempt.
* **Calculation**:
  $$\text{Recipient Receives} = \text{Amount} \times (1 - 0.015)$$
  $$\text{Commons Pool Receives} = \text{Amount} \times 0.015$$

---

## 5. Recycling the Surplus to Community Projects

The Commons Pool is not a profit sink. Any surplus accumulated in the pool beyond what is required to cover bad debt write-offs is continuously returned to the community:

* **Crowdfunding Projects**: Members can propose community projects (e.g., tools for a community garden, shared workspace equipment) and request funding from the Commons Pool.
* **Governance Voting Rounds**: The community votes on which projects to fund, and the Commons Pool sweeps the approved budgets to the creators.

By combining demurrage, a transactional tax, and project-based disbursements, BeanPool creates a closed-loop economic system where value is generated locally, protected collectively, and recycled back into community-led initiatives.
