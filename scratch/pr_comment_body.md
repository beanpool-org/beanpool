### Additional Architectural Review Findings

Here are additional findings from the domain specialists:

#### 1. UX & Accessibility ([apps/server/src/federation-bridge.ts](file:///Users/marty/projects/beanpool/apps/server/src/federation-bridge.ts#L402))
**Risk:** User-facing error message `${round2(extended)} of ${cap}` lacks currency/unit context ("beans"), which can leave users confused about what numbers like `(15 of 50)` represent.

**Suggested Fix:**
```ts
message: `This community has reached the credit limit set for them (${round2(extended)} beans of ${cap} beans). They can buy from us — which is what brings the balance back — but we can't extend more until it does.`
```

#### 2. UX & Accessibility ([apps/server/src/federation-bridge.ts](file:///Users/marty/projects/beanpool/apps/server/src/federation-bridge.ts#L470))
**Risk:** Prepending raw emoji `🌐` directly to display strings causes screen readers to read "Globe showing Americas, Byron Bay" or "Globe showing Americas, Another community" verbatim.

**Suggested Fix:**
```ts
if (callsign) return callsign;
return 'Another community';
```

#### 3. UX & Accessibility ([apps/server/src/federation-settlement-exchange.ts](file:///Users/marty/projects/beanpool/apps/server/src/federation-settlement-exchange.ts#L1255))
**Risk:** Raw settlement UUID/hash keys (e.g. `settle_9a8b7c6d...`) are concatenated directly into user-facing transaction memos.

**Suggested Fix:**
```ts
const shortKey = key.length > 8 ? key.slice(-8) : key;
mustTransfer(bridge, row.buyerPubkey, row.amount, `${reversalMemo(reason)} (#${shortKey})`);
```

#### 4. UX & Accessibility ([apps/server/src/federation-settlement-exchange.ts](file:///Users/marty/projects/beanpool/apps/server/src/federation-settlement-exchange.ts#L1758))
**Risk:** Unresolved cross-community settlements lack explicit UX status indicators in transaction history views.

**Suggested Fix:**
```ts
const whatIsStuck = row.direction === 'outbound'
    ? 'Payment pending operator reconciliation'
    : 'Received settlement awaiting credit limit adjustment';
```

#### 5. UX & Accessibility ([apps/server/src/state-engine.ts](file:///Users/marty/projects/beanpool/apps/server/src/state-engine.ts#L2263))
**Risk:** Exposing full 64-character public key hashes in user-facing transaction memos creates visual clutter.

**Suggested Fix:**
```ts
const maskedKey = `${publicKey.slice(0, 6)}...${publicKey.slice(-4)}`;
transfer('COMMONS_POOL', publicKey, D, `Settle bad debt for pruned user: ${maskedKey}`, 'direct', true);
```

#### 6. Consequences & Impact ([apps/server/src/federation-settlement-exchange.ts](file:///Users/marty/projects/beanpool/apps/server/src/federation-settlement-exchange.ts#L1415))
**Risk:** When handling cross-node purchase requests (`handlePurchaseRequest`), missing `buyerHomeNode` causes `registerVisitor` to set `home_node_url = NULL`, mistaking remote buyers for local members on subsequent attempts and permanently refusing settlements with `buyer_is_local`.

**Suggested Fix:**
```typescript
try {
    const homeNodeUrl = input.buyerHomeNode || `peer://${input.peerId}`;
    registerVisitor(input.buyerPublicKey, input.buyerCallsign, homeNodeUrl);
} catch (e: any) {
    console.warn('[Federation] Visitor record for cross-node buyer failed:', e?.message || e);
}
```
