import {PUBLIC_CREDIT_UNIT,legacyCreditsToPublic,type AccountInfo} from '@femlab/registry';

/** Normalize a wire value exactly once; display rounding never changes stored usage. */
export function normalizeAiCredits(value:number,unit:unknown):number {
  if(unit!==undefined&&unit!==PUBLIC_CREDIT_UNIT)throw new Error('Unsupported AI credit unit. Refresh your account before retrying.');
  if(!Number.isFinite(value)||value<0)throw new Error('Invalid AI credit amount. Refresh your account before retrying.');
  return unit===PUBLIC_CREDIT_UNIT?value:legacyCreditsToPublic(value);
}

/** Legacy hosts omit the marker; every in-memory balance uses the current public unit. */
export function normalizeAccountCredits(profile:AccountInfo):AccountInfo {
  if(profile.creditUnit!==undefined&&profile.creditUnit!==PUBLIC_CREDIT_UNIT)throw new Error('Unsupported AI credit unit. Refresh your account before retrying.');
  if(!profile.usage&&!profile.freeAllowance)return profile;
  const amount=(value:number)=>normalizeAiCredits(value,profile.creditUnit);
  return {...profile,creditUnit:PUBLIC_CREDIT_UNIT,
    ...(profile.usage?{usage:{...profile.usage,totalCredits:amount(profile.usage.totalCredits),availableCredits:amount(profile.usage.availableCredits),reservedCredits:amount(profile.usage.reservedCredits)}}:{}),
    ...(profile.freeAllowance?{freeAllowance:{...profile.freeAllowance,credits:amount(profile.freeAllowance.credits)}}:{}),
  };
}

/** Keep exact server accounting values; round only the text shown to a person. */
export function formatAiCredits(value:number):string {
  return value.toLocaleString(undefined,{maximumFractionDigits:2});
}
