import {describe,expect,it} from 'vitest';
import {billingPrices,type PriceCatalog} from '../src/billing-prices';

function fixture():PriceCatalog {
  return {prices:{plus:'price_plus',pro:'price_pro',studio:'price_studio'},purchasePrices:{
    plus:{personal:'price_plus_personal',business:'price_plus_business'},
    pro:{personal:'price_pro_personal',business:'price_pro_business'},
    studio:{personal:'price_studio_personal',business:'price_studio_business'},
  }};
}

describe('server-owned billing price identities',()=>{
  it.each([
    ['price_plus','plus',null],['price_pro','pro',null],['price_studio','studio',null],
    ['price_plus_personal','plus','personal'],['price_plus_business','plus','business'],
    ['price_pro_personal','pro','personal'],['price_pro_business','pro','business'],
    ['price_studio_personal','studio','personal'],['price_studio_business','studio','business'],
  ] as const)('maps %s to its tier and purchase use', (price,plan,purchaseUse)=>{
    const catalog=billingPrices(fixture());
    expect(catalog.get(price)).toEqual({plan,purchaseUse});
    expect(catalog.select(plan,purchaseUse)).toBe(price);
  });

  it('leaves absent aliases and unknown identities unselected without changing legacy recovery',()=>{
    const config=fixture();delete config.purchasePrices!.plus!.business;
    const catalog=billingPrices(config);
    expect(catalog.get('price_unrecognized')).toBeUndefined();
    expect(catalog.select('plus','business')).toBeUndefined();
    expect(catalog.select('plus',null)).toBe('price_plus');
    expect(billingPrices({prices:config.prices}).get('price_pro')).toEqual({plan:'pro',purchaseUse:null});
  });

  it.each(['price_with/slash','https://example.com/price_other','other_price','price_'])('rejects invalid configured alias %s',price=>{
    const config=fixture();config.purchasePrices!.plus!.personal=price;
    expect(()=>billingPrices(config)).toThrow('valid and unambiguous');
  });

  it.each(['legacy alias','same tier uses','different tiers','legacy tiers'])('rejects a collision between %s',kind=>{
    const config=fixture();
    if(kind==='legacy alias')config.purchasePrices!.plus!.personal='price_plus';
    if(kind==='same tier uses')config.purchasePrices!.plus!.business='price_plus_personal';
    if(kind==='different tiers')config.purchasePrices!.studio!.business='price_pro_personal';
    if(kind==='legacy tiers')config.prices.studio='price_plus';
    expect(()=>billingPrices(config)).toThrow('valid and unambiguous');
  });
});
