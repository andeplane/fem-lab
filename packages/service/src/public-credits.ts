import {PUBLIC_CREDIT_UNIT,legacyCreditsToPublic,type PublicCreditUnit} from '@femlab/registry';
import type {AccountResponse} from './accounts';
import type {Receipt,RequestStatus} from './reservations';
import {PUBLIC_CREDIT_SCALE} from './credits';
import {ServiceFailure} from './errors';

/** Opt in at the HTTP boundary. Unversioned clients retain their original numeric contract. */
export function requestedCreditUnit(header:string|string[]|undefined):PublicCreditUnit|undefined {
  if(header===undefined)return undefined;
  if(header!==PUBLIC_CREDIT_UNIT)throw new ServiceFailure(422,'unsupported-credit-unit','Use usd-milli-v1 or omit the credit-unit header.','credit-unit');
  return header;
}
export function allowanceCredits<T extends {credits:number}>(value:T,unit?:PublicCreditUnit):T&{creditUnit?:PublicCreditUnit} {
  return unit?{...value,credits:legacyCreditsToPublic(value.credits),creditUnit:unit}:value;
}
/** Account usage is read from raw ledger subcredits using the negotiated unit. */
export function accountCredits(account:AccountResponse,unit?:PublicCreditUnit):AccountResponse&{creditUnit?:PublicCreditUnit} {
  return unit?{...account,creditUnit:unit,freeAllowance:account.freeAllowance?allowanceCredits(account.freeAllowance,unit):undefined}:account;
}
/** Read immutable raw charges, never multiply an already rounded legacy credit number. */
export function receiptCredits(receipt:Receipt,unit?:PublicCreditUnit):Receipt&{creditUnit?:PublicCreditUnit} {
  return unit?{...receipt,chargedCredits:Number(BigInt(receipt.chargedSubcredits))/Number(PUBLIC_CREDIT_SCALE),creditUnit:unit}:receipt;
}
export function requestCredits(request:RequestStatus,unit?:PublicCreditUnit):RequestStatus {
  return unit&&request.receipt?{...request,receipt:receiptCredits(request.receipt,unit)}:request;
}
