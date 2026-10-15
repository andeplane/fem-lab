/** Public host/account state. Tokens, provider keys and payment customer IDs are never included. */
export type AccountPlan='free'|'plus'|'pro'|'studio';
/** Declared use of a subscription, fixed for its lifetime. */
export type PurchaseUse='personal'|'business';
export interface AccountInfo {
  id:string;email:string;createdAt:string;status:'active';billingAvailable?:boolean;
  usage?:{plan:AccountPlan;totalCredits:number;availableCredits:number;reservedCredits:number;periodEndsAt:string;models:string[];maxOutput:number;contextLimit:number;tariffVersion:string};
  billing?:{available:boolean;
    /** Owned customer management is independent of new sales and financial-review freezes. Absent on older hosts. */
    canManage?:boolean;
    merchantMode?:'pending'|'direct'|'managed';status:unknown;cancelAtPeriodEnd:boolean;periodEndsAt:string|null;reviewRequired:boolean;scheduledPlan:{plan:unknown;effectiveAt:string;processing:boolean}|null};
}
export interface AccountState {
  configured:boolean;status:'loading'|'anonymous'|'active'|'error';uid:string|null;email:string|null;
  profile:AccountInfo|null;message:string|null;error:string|null;emailLinkPending:boolean;disclosureAccepted:boolean;googleEnabled:boolean;
}
export interface AccountServices {
  signIn(method:'google'|'email',email?:string):Promise<void>;
  signOut():Promise<void>;
  refresh():Promise<void>;
  checkout(plan:Exclude<AccountPlan,'free'>,purchaseUse?:PurchaseUse):Promise<void>;
  portal():Promise<void>;
  changePlan(plan:Exclude<AccountPlan,'free'>):Promise<void>;
  exportData():Promise<void>;
  deleteAccount(confirm:'DELETE'):Promise<void>;
  acceptDisclosure():void;
  state():AccountState;
}
export const EMPTY_ACCOUNT:AccountState={configured:false,status:'anonymous',uid:null,email:null,profile:null,message:null,error:null,emailLinkPending:false,disclosureAccepted:false,googleEnabled:false};
