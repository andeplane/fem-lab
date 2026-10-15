/** Public AI budget unit: one credit represents USD 0.001 of supplier usage. */
export const PUBLIC_CREDIT_UNIT = 'usd-milli-v1' as const;
export type PublicCreditUnit = typeof PUBLIC_CREDIT_UNIT;
/** Advertised allowances. Existing grants retain their original, exact purchasing power. */
export const PUBLIC_PLAN_CREDITS = {free:5000,plus:7500,pro:12000,studio:37500} as const;
/** Compatibility for hosts predating credit-unit negotiation. Never round each request. */
export function legacyCreditsToPublic(credits:number):number {return credits*3/4000;}
