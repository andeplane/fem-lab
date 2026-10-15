import type {PlanId} from './credits';

export type PaidPlan=Exclude<PlanId,'free'>;
export type PurchaseUse='personal'|'business';
export interface PriceCatalog {
  prices:Record<PaidPlan,string>;
  purchasePrices?:Partial<Record<PaidPlan,Partial<Record<PurchaseUse,string>>>>;
}
/** Price identities select entitlements and use; neither is accepted from a webhook hint. */
export function billingPrices(config:PriceCatalog) {
  const entries=new Map<string,{plan:PaidPlan;purchaseUse:PurchaseUse|null}>();
  for(const plan of ['plus','pro','studio'] as const) {
    const candidates:[string,PurchaseUse|null][]=[[config.prices[plan],null],
      ...(['personal','business'] as const).map(use=>[config.purchasePrices?.[plan]?.[use]??'',use] as [string,PurchaseUse])];
    for(const [price,purchaseUse] of candidates) {
      if(!price)continue;
      if(!/^price_[A-Za-z0-9_]+$/.test(price)||entries.has(price))throw new Error('Billing price identities must be valid and unambiguous.');
      entries.set(price,{plan,purchaseUse});
    }
  }
  return {
    get:(id:string)=>entries.get(id),
    select:(plan:PaidPlan,use:PurchaseUse|null)=>use?config.purchasePrices?.[plan]?.[use]:config.prices[plan],
  };
}
