import {EMPTY_ACCOUNT,type AccountInfo,type AccountPlan,type AccountServices,type AccountState} from '@femlab/registry';
export interface Identity {uid:string;email:string|null}
export interface AuthPort {
  initialize(changed:(identity:Identity|null)=>void):Promise<{emailLinkPending:boolean}>;
  signIn(method:'google'|'email',email?:string):Promise<'sent'|'signed-in'|'redirect'>;
  signOut():Promise<void>;
  token(uid:string,force:boolean):Promise<string>;
}
export interface AccountEnvironment {auth:AuthPort;fetch:typeof fetch;origin:string;googleEnabled:boolean;beforeLeave():Promise<void>;navigate(url:string):void}
/** Identity epochs prevent a previous login's response from reaching the current account. */
export class AccountController {
  private value:AccountState;
  private epoch=0;
  private listeners=new Set<(state:AccountState)=>void>();
  readonly services:AccountServices;
  constructor(private env:AccountEnvironment|null) {
    this.value={...EMPTY_ACCOUNT,configured:env!==null,status:env?'loading':'anonymous',googleEnabled:env?.googleEnabled??false};
    this.services={state:()=>this.state,signIn:(m,e)=>this.signIn(m,e),signOut:()=>this.signOut(),refresh:()=>this.refresh(),checkout:(p,purchaseUse)=>this.redirect('/v1/billing/checkout',{plan:p,...(purchaseUse===undefined?{}:{purchaseUse})}),portal:()=>this.redirect('/v1/billing/portal',{}),changePlan:p=>this.changePlan(p),exportData:()=>this.exportData(),deleteAccount:c=>this.deleteAccount(c),acceptDisclosure:()=>this.set({disclosureAccepted:true})};
  }
  get version():number{return this.epoch}
  get state():AccountState{return this.value}
  subscribe(listener:(state:AccountState)=>void):()=>void{this.listeners.add(listener);listener(this.state);return()=>{this.listeners.delete(listener)}}
  private set(patch:Partial<AccountState>):void{this.value={...this.value,...patch};for(const fn of this.listeners)fn(this.value)}
  async initialize():Promise<void>{if(!this.env)return;try{const result=await this.env.auth.initialize(identity=>this.identityChanged(identity));this.set({emailLinkPending:result.emailLinkPending});}catch{this.set({status:'error',error:'Sign-in could not start. Refresh the page to try again.'})}}
  private identityChanged(identity:Identity|null):void {
    this.epoch++;
    this.set({uid:identity?.uid??null,email:identity?.email??null,profile:null,status:identity?'loading':'anonymous',error:null,message:null,disclosureAccepted:false});
    if(identity)void this.refresh().catch(()=>undefined);
  }
  async token(uid:string,force=false):Promise<string>{if(!this.env||this.state.uid!==uid)throw new Error('The account changed. Sign in and start a new message.');const epoch=this.epoch;const token=await this.env.auth.token(uid,force);if(epoch!==this.epoch)throw new Error('The account changed.');return token}
  async request<T>(path:string,body?:unknown):Promise<T>{
    if(!this.env||!this.state.uid)throw new Error('Sign in to use hosted AI.');
    const epoch=this.epoch,uid=this.state.uid;
    const send=async(force:boolean)=>this.env!.fetch(this.env!.origin+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${await this.token(uid,force)}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    let response=await send(false);if(response.status===401)response=await send(true);
    if(epoch!==this.epoch)throw new Error('The account changed.');
    const result=await response.json() as T&{cause?:string;error?:{cause?:string}};
    if(epoch!==this.epoch)throw new Error('The account changed.');
    if(!response.ok)throw new Error(result.cause??result.error?.cause??'The account request failed. Try again later.');return result;
  }
  async refresh():Promise<void>{const epoch=this.epoch;try{const profile=await this.request<AccountInfo>('/v1/account');if(epoch===this.epoch)this.set({profile,status:'active',error:null})}catch(error){if(epoch===this.epoch)this.set({status:this.state.uid?'error':'anonymous',error:error instanceof Error?error.message:'Account unavailable.'});throw error}}
  private async action(run:()=>Promise<void>):Promise<void>{const epoch=this.epoch;this.set({error:null,message:null});try{await run()}catch(error){if(epoch===this.epoch)this.set({error:error instanceof Error?error.message:'Please try again.'});throw error}}
  private async signIn(method:'google'|'email',email?:string):Promise<void>{await this.action(async()=>{if(!this.env)throw new Error('Hosted accounts are not configured in this build.');if(method==='google'&&!this.env.googleEnabled)throw new Error('Google sign-in is not enabled. Use an email link.');if(method==='google')await this.env.beforeLeave();const result=await this.env.auth.signIn(method,email);if(result==='sent')this.set({message:'Check your inbox for a sign-in link. Open it in this browser tab.'});else this.set({emailLinkPending:false})})}
  private async signOut():Promise<void>{await this.action(async()=>{await this.env?.auth.signOut();this.identityChanged(null)})}
  private async redirect(path:string,body:unknown):Promise<void>{await this.action(async()=>{const uid=this.state.uid;const {url}=await this.request<{url:string}>(path,body);await this.env!.beforeLeave();if(this.state.uid!==uid)throw new Error('The account changed.');this.env!.navigate(url)})}
  private async changePlan(plan:Exclude<AccountPlan,'free'>):Promise<void>{await this.action(async()=>{await this.request('/v1/billing/plan',{plan});await this.refresh();this.set({message:'Plan change saved for the next paid period.'})})}
  private async exportData():Promise<void>{await this.action(async()=>{const result=await this.request<{url?:string;status:string}>('/v1/account/export',{});if(result.url){const uid=this.state.uid;await this.env!.beforeLeave();if(this.state.uid!==uid)throw new Error('The account changed.');this.env!.navigate(result.url)}else this.set({message:'Your private export is being prepared. Select Export again shortly.'})})}
  private async deleteAccount(confirm:'DELETE'):Promise<void>{await this.action(async()=>{await this.request('/v1/account/delete',{confirm});await this.env?.auth.signOut();this.identityChanged(null);this.set({message:'Account deletion requested. Local models remain in this browser.'})})}
}
