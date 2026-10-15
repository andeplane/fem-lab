import {render} from 'preact';
import {act} from 'preact/test-utils';
import {expect,it,vi} from 'vitest';
import {AccountPanel} from '../src/ui/Account';
import {initialState} from '../src/store';
import {EMPTY_ACCOUNT,type AccountInfo,type AccountPlan} from '@femlab/registry';
it('offers optional email login while local model state stays untouched',()=>{
  const s={...structuredClone(initialState),panels:{account:true,'account.data':true},account:{...EMPTY_ACCOUNT,configured:true}};
  const container=document.createElement('div');document.body.append(container);
  act(()=>render(<AccountPanel s={s} dispatch={vi.fn(async()=>{})}/>,container));
  expect(container.textContent).toContain('Send sign-in link');expect(container.querySelector('[data-cmd="account.signIn"]')).toBeTruthy();expect(s.journal).toBeNull();act(()=>render(null,container));container.remove();
});
it('renders server balance and disables purchases when billing is unavailable',()=>{
  const s={...structuredClone(initialState),panels:{account:true,'account.data':true},account:{...EMPTY_ACCOUNT,configured:true,status:'active' as const,uid:'a',email:'a@example.com',profile:{id:'a',email:'a@example.com',createdAt:'2026-10-14T00:00:00Z',status:'active' as const,usage:{plan:'free' as const,totalCredits:200000,availableCredits:199946,reservedCredits:0,periodEndsAt:'2026-11-01T00:00:00Z',models:['gpt-5.4-mini'],maxOutput:4096,contextLimit:64000,tariffVersion:'v1'},billing:{available:false,status:null,cancelAtPeriodEnd:false,periodEndsAt:null,reviewRequired:false,scheduledPlan:null}}}};
  const container=document.createElement('div');document.body.append(container);
  act(()=>render(<AccountPanel s={s} dispatch={vi.fn(async()=>{})}/>,container));
  expect(container.textContent).toContain('199,946');
  expect(Array.from(container.querySelectorAll('.account-plan p'),p=>p.textContent)).toEqual(['10,000,000 AI credits / paid period','16,000,000 AI credits / paid period','50,000,000 AI credits / paid period']);
  for(const button of container.querySelectorAll<HTMLButtonElement>('[data-cmd="account.checkout"]'))expect(button.disabled).toBe(true);expect(container.querySelector<HTMLButtonElement>('[data-cmd="account.delete"]')?.disabled).toBe(true);act(()=>render(null,container));container.remove();
});
function signedIn(plan:AccountPlan='free',merchantMode:NonNullable<AccountInfo['billing']>['merchantMode']='managed'){
  const billing:NonNullable<AccountInfo['billing']>={available:true,canManage:false,merchantMode,status:'active',cancelAtPeriodEnd:false,periodEndsAt:null,reviewRequired:false,scheduledPlan:null};
  return {...structuredClone(initialState),panels:{account:true},account:{...EMPTY_ACCOUNT,configured:true,status:'active' as const,uid:'a',email:'a@example.com',profile:{id:'a',email:'a@example.com',createdAt:'2026-10-14T00:00:00Z',status:'active' as const,usage:{plan,totalCredits:200000,availableCredits:199946,reservedCredits:0,periodEndsAt:'2026-11-01T00:00:00Z',models:['gpt-5.4-mini'],maxOutput:4096,contextLimit:64000,tariffVersion:'v1'},billing}}};
}
it.each(['plus','free'] as const)('keeps owned management with %s allowance under financial review while sales are paused',plan=>{
  const s=signedIn(plan);Object.assign(s.account.profile.billing,{available:false,canManage:true,reviewRequired:true});
  if(plan==='free')Object.assign(s.account.profile.usage,{totalCredits:0,availableCredits:0});
  const dispatch=vi.fn(async()=>{}),container=document.createElement('div');document.body.append(container);
  act(()=>render(<AccountPanel s={s} dispatch={dispatch}/>,container));
  expect(container.textContent).toContain('New purchases and plan changes are currently unavailable.');
  for(const button of container.querySelectorAll<HTMLButtonElement>('[data-cmd="account.changePlan"],[data-cmd="account.checkout"]'))expect(button.disabled).toBe(true);
  const manage=container.querySelector<HTMLButtonElement>('[data-cmd="account.portal"]');expect(manage).not.toBeNull();expect(manage!.disabled).toBe(false);
  act(()=>manage!.click());expect(dispatch).toHaveBeenCalledWith({cmd:'account.portal'});
  act(()=>render(null,container));container.remove();
});
it.each([false,true])('does not offer management without an owned customer when sales availability is %s',available=>{
  const s=signedIn();s.account.profile.billing.available=available;
  const container=document.createElement('div');document.body.append(container);
  act(()=>render(<AccountPanel s={s} dispatch={vi.fn(async()=>{})}/>,container));
  expect(container.querySelector('[data-cmd="account.portal"]')).toBeNull();
  act(()=>render(null,container));container.remove();
});
it('requires a personal or business choice before a new managed purchase and passes the chosen use',()=>{
  const s=signedIn(),dispatch=vi.fn(async()=>{}),container=document.createElement('div');document.body.append(container);
  act(()=>render(<AccountPanel s={s} dispatch={dispatch}/>,container));
  const select=container.querySelector<HTMLSelectElement>('select')!;
  expect(select.labels?.[0]?.textContent).toContain('Subscription use');expect(select.value).toBe('');expect(container.textContent).toContain('This choice stays the same for this subscription.');
  const buttons=()=>container.querySelectorAll<HTMLButtonElement>('[data-cmd="account.checkout"]');
  expect(buttons()).toHaveLength(3);for(const button of buttons())expect(button.disabled).toBe(true);
  act(()=>buttons()[0]!.click());expect(dispatch).not.toHaveBeenCalled();
  for(const purchaseUse of ['personal','business']){
    act(()=>{select.value=purchaseUse;select.dispatchEvent(new Event('change',{bubbles:true}))});
    for(const button of buttons())expect(button.disabled).toBe(false);
    act(()=>buttons()[0]!.click());expect(dispatch).toHaveBeenLastCalledWith({cmd:'account.checkout',plan:'plus',purchaseUse});
  }
  s.account.profile.billing.available=false;act(()=>render(<AccountPanel s={s} dispatch={dispatch}/>,container));
  for(const button of buttons())expect(button.disabled).toBe(true);
  s.account.uid='b';s.account.profile.id='b';s.account.profile.billing.available=true;act(()=>render(<AccountPanel s={s} dispatch={dispatch}/>,container));
  expect(select.value).toBe('');for(const button of buttons())expect(button.disabled).toBe(true);
  act(()=>render(null,container));container.remove();
});
it('keeps legacy direct checkout available without presenting or sending purchase use',()=>{
  const s=signedIn('free','direct'),dispatch=vi.fn(async()=>{}),container=document.createElement('div');document.body.append(container);
  act(()=>render(<AccountPanel s={s} dispatch={dispatch}/>,container));
  expect(container.querySelector('select')).toBeNull();
  const buttons=container.querySelectorAll<HTMLButtonElement>('[data-cmd="account.checkout"]');expect(buttons).toHaveLength(3);
  for(const [index,plan] of ['plus','pro','studio'].entries()){
    expect(buttons[index]!.disabled).toBe(false);act(()=>buttons[index]!.click());
    expect(dispatch).toHaveBeenLastCalledWith({cmd:'account.checkout',plan});
  }
  act(()=>render(null,container));container.remove();
});
it('blocks new checkout with stale availability while the merchant mode is missing, pending or unknown',()=>{
  for(const merchantMode of [undefined,'pending','future-mode'] as const){
    const s=signedIn(),dispatch=vi.fn(async()=>{}),container=document.createElement('div');document.body.append(container);
    Object.assign(s.account.profile.billing,{merchantMode,available:true});
    act(()=>render(<AccountPanel s={s} dispatch={dispatch}/>,container));
    expect(container.querySelector('select')).toBeNull();
    const buttons=container.querySelectorAll<HTMLButtonElement>('[data-cmd="account.checkout"]');expect(buttons).toHaveLength(3);
    for(const button of buttons){expect(button.disabled).toBe(true);act(()=>button.click())}expect(dispatch).not.toHaveBeenCalled();
    act(()=>render(null,container));container.remove();
  }
});
it('keeps paid plan changes available without presenting or accepting a use override',()=>{
  const dispatch=vi.fn(async()=>{}),container=document.createElement('div');document.body.append(container);
  for(const merchantMode of ['managed','direct','pending',undefined,'future-mode'] as const){
    const s=signedIn('plus');Object.assign(s.account.profile.billing,{merchantMode,canManage:true});
    act(()=>render(<AccountPanel s={s} dispatch={dispatch}/>,container));
    expect(container.querySelector('select')).toBeNull();expect(container.querySelector('[data-cmd="account.checkout"]')).toBeNull();
    const buttons=container.querySelectorAll<HTMLButtonElement>('[data-cmd="account.changePlan"]');expect(buttons[0]?.disabled).toBe(true);expect(buttons[1]?.disabled).toBe(false);
    act(()=>buttons[1]!.click());expect(dispatch).toHaveBeenLastCalledWith({cmd:'account.changePlan',plan:'pro'});
    expect(container.querySelector<HTMLButtonElement>('[data-cmd="account.portal"]')?.disabled).toBe(false);
  }
  act(()=>render(null,container));container.remove();
});

it.each([
  {mode:'direct',available:true},
  {mode:'direct',available:false},
  {mode:'managed',available:true},
  {mode:'managed',available:false},
  {mode:'pending',available:false},
  {mode:undefined,available:true},
  {mode:undefined,available:false},
] as const)('uses explicit merchant mode $mode with billing available=$available',({mode,available})=>{
  const s={...structuredClone(initialState),panels:{account:true},account:{...EMPTY_ACCOUNT,configured:true,status:'active' as const,uid:'a',email:'a@example.com',profile:{id:'a',email:'a@example.com',createdAt:'2026-10-14T00:00:00Z',status:'active' as const,billing:{available,status:null,cancelAtPeriodEnd:false,periodEndsAt:null,reviewRequired:false,scheduledPlan:null,...(mode?{merchantMode:mode}:{})}}}};
  const container=document.createElement('div');document.body.append(container);
  act(()=>render(<AccountPanel s={s} dispatch={vi.fn(async()=>{})}/>,container));
  expect(container.textContent).toContain('Hafreager kode & koblinger sells and provides FEM Lab subscriptions.');
  expect(container.textContent?.includes('Stripe Managed Payments handles the transaction as merchant of record.')).toBe(mode==='managed');
  expect(container.textContent).toContain('Checkout shows payment terms, applicable tax and total.');
  expect(container.textContent).not.toContain('Stripe is the seller');
  expect(container.textContent).toContain('USD list prices exclude applicable tax');
  for(const button of container.querySelectorAll<HTMLButtonElement>('[data-cmd="account.checkout"]'))expect(button.disabled).toBe(!available||mode!=='direct');
  if(!available)expect(container.textContent).toContain('New purchases and plan changes are currently unavailable.');
  act(()=>render(null,container));container.remove();
});
it.each([
  {status:'review-required',enabled:false,text:'requires an eligibility review'},
  {status:'eligible',enabled:true,text:'Eligibility approved'},
  {status:'claimed',enabled:false,text:'has already been claimed'},
  {status:'revoked',enabled:false,text:'eligibility has been revoked'},
  {status:'paid',enabled:false,text:'not added to paid credits'},
  {status:'unavailable',enabled:false,text:'temporarily unavailable'},
  {status:undefined,enabled:false,text:'temporarily unavailable'},
  {status:'future-status',enabled:false,text:'temporarily unavailable'},
] as const)('requires authoritative free status $status before a claim',({status,enabled,text})=>{
  const s=signedIn(),dispatch=vi.fn(async()=>{}),container=document.createElement('div');document.body.append(container);
  Object.assign(s.account.profile.usage,{totalCredits:0,availableCredits:0});
  if(status)Object.assign(s.account.profile,{freeAllowance:{status,credits:6666666,periodStartsAt:'2026-10-01T00:00:00Z',periodEndsAt:'2026-11-01T00:00:00Z'}});
  act(()=>render(<AccountPanel s={s} dispatch={dispatch}/>,container));
  const panel=container.querySelector('section[aria-label="Free monthly AI allowance"]')!;
  expect(panel.textContent).toContain(text);expect(container.textContent).toContain('Signing up starts with zero credits.');
  if(status)expect(panel.textContent).toContain('6,666,666 weighted AI credits');
  expect(dispatch).not.toHaveBeenCalled();
  const button=panel.querySelector<HTMLButtonElement>('[data-cmd="account.claimFreeAllowance"]')!;
  expect(button.disabled).toBe(!enabled);act(()=>button.click());
  if(enabled)expect(dispatch).toHaveBeenCalledExactlyOnceWith({cmd:'account.claimFreeAllowance'});else expect(dispatch).not.toHaveBeenCalled();
  expect(s.journal).toBeNull();act(()=>render(null,container));container.remove();
});
it('denies a stale eligible free claim while paid credits, account loading or billing review are active',()=>{
  for(const blocker of ['loading','paid','review']){
    const paid=blocker==='paid';
    const s=signedIn(paid?'plus':'free'),dispatch=vi.fn(async()=>{}),container=document.createElement('div');document.body.append(container);
    Object.assign(s.account.profile,{freeAllowance:{status:'eligible',credits:6666666,periodStartsAt:'2026-10-01T00:00:00Z',periodEndsAt:'2026-11-01T00:00:00Z'}});
    if(blocker==='loading')Object.assign(s.account,{status:'loading'});
    if(blocker==='review')s.account.profile.billing.reviewRequired=true;
    act(()=>render(<AccountPanel s={s} dispatch={dispatch}/>,container));
    const button=container.querySelector<HTMLButtonElement>('[data-cmd="account.claimFreeAllowance"]')!;
    expect(button.disabled).toBe(true);act(()=>button.click());expect(dispatch).not.toHaveBeenCalled();
    if(paid)expect(container.textContent).toContain('Free monthly credits are not added to paid credits.');
    act(()=>render(null,container));container.remove();
  }
});
