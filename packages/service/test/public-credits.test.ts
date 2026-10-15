import {expect,it} from 'vitest';
import {PUBLIC_CREDIT_UNIT} from '@femlab/registry';
import {balanceCredits} from '../src/credits';
import {accountCredits,allowanceCredits,receiptCredits,requestedCreditUnit,requestCredits} from '../src/public-credits';
import type {Receipt,RequestStatus} from '../src/reservations';

const receipt:Receipt={requestId:'r',outcome:'confirmed',usage:{input:112,cacheRead:0,output:0},chargedCredits:112,chargedSubcredits:'3360',tariffVersion:'2026-10-14.v1'};
it('requires explicit supported negotiation and leaves legacy responses untouched',()=>{
  expect(requestedCreditUnit(undefined)).toBeUndefined();
  expect(requestedCreditUnit(PUBLIC_CREDIT_UNIT)).toBe(PUBLIC_CREDIT_UNIT);
  for(const header of ['', 'usd-milli-v2','legacy','usd-milli-v1,usd-milli-v1',[PUBLIC_CREDIT_UNIT]])expect(()=>requestedCreditUnit(header)).toThrow('credit-unit');
  expect(receiptCredits(receipt)).toBe(receipt);
  const allowance={credits:6666666};expect(allowanceCredits(allowance)).toBe(allowance);
});
it('converts exact stored subcredits, preserving tiny debits and fractional holds',()=>{
  expect(balanceCredits(199999980n,PUBLIC_CREDIT_UNIT)).toBe(4999.9995);
  expect(balanceCredits(199996620n,PUBLIC_CREDIT_UNIT)).toBe(4999.9155);
  expect(balanceCredits(1n,PUBLIC_CREDIT_UNIT)).toBe(0.000025);
  expect(balanceCredits(29n)).toBe(0);expect(balanceCredits(30n)).toBe(1);
  expect(receiptCredits({...receipt,chargedCredits:999},PUBLIC_CREDIT_UNIT)).toEqual({...receipt,chargedCredits:0.084,creditUnit:PUBLIC_CREDIT_UNIT});
  expect(receiptCredits({...receipt,chargedSubcredits:'1'},PUBLIC_CREDIT_UNIT).chargedCredits).toBe(0.000025);
  expect(allowanceCredits({credits:6666666},PUBLIC_CREDIT_UNIT)).toEqual({credits:4999.9995,creditUnit:PUBLIC_CREDIT_UNIT});
});
it('marks account and replay receipts without rewriting immutable tariff or raw charge fields',()=>{
  const account={id:'id',email:'owned@example.com',status:'active' as const,createdAt:'2026-10-15T00:00:00.000Z'};
  expect(accountCredits(account)).toBe(account);
  expect(accountCredits(account,PUBLIC_CREDIT_UNIT)).toEqual({...account,creditUnit:PUBLIC_CREDIT_UNIT});
  const request:RequestStatus={id:'r',state:'settled',model:'gpt-5.4-mini',plan:'free',maxOutput:128,replay:true,receipt};
  expect(requestCredits(request)).toBe(request);
  expect(requestCredits(request,PUBLIC_CREDIT_UNIT).receipt).toEqual({...receipt,chargedCredits:0.084,creditUnit:PUBLIC_CREDIT_UNIT});
  const pending={...request,receipt:null};expect(requestCredits(pending,PUBLIC_CREDIT_UNIT)).toBe(pending);
  expect(receipt.chargedCredits).toBe(112);
});
