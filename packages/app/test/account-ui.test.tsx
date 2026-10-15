import {render} from 'preact';
import {act} from 'preact/test-utils';
import {expect,it,vi} from 'vitest';
import {AccountPanel} from '../src/ui/Account';
import {initialState} from '../src/store';
import {EMPTY_ACCOUNT,type AccountPlan} from '@femlab/registry';
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
  expect(container.textContent).toContain('199,946');for(const button of container.querySelectorAll<HTMLButtonElement>('[data-cmd="account.checkout"]'))expect(button.disabled).toBe(true);expect(container.querySelector<HTMLButtonElement>('[data-cmd="account.delete"]')?.disabled).toBe(true);act(()=>render(null,container));container.remove();
});
function signedIn(plan:AccountPlan='free'){
  return {...structuredClone(initialState),panels:{account:true},account:{...EMPTY_ACCOUNT,configured:true,status:'active' as const,uid:'a',email:'a@example.com',profile:{id:'a',email:'a@example.com',createdAt:'2026-10-14T00:00:00Z',status:'active' as const,usage:{plan,totalCredits:200000,availableCredits:199946,reservedCredits:0,periodEndsAt:'2026-11-01T00:00:00Z',models:['gpt-5.4-mini'],maxOutput:4096,contextLimit:64000,tariffVersion:'v1'},billing:{available:true,status:'active',cancelAtPeriodEnd:false,periodEndsAt:null,reviewRequired:false,scheduledPlan:null}}}};
}
it('requires a personal or business choice before a new purchase and passes the chosen use',()=>{
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
it('keeps paid plan changes available without presenting or accepting a use override',()=>{
  const dispatch=vi.fn(async()=>{}),container=document.createElement('div');document.body.append(container);
  act(()=>render(<AccountPanel s={signedIn('plus')} dispatch={dispatch}/>,container));
  expect(container.querySelector('select')).toBeNull();expect(container.querySelector('[data-cmd="account.checkout"]')).toBeNull();
  const buttons=container.querySelectorAll<HTMLButtonElement>('[data-cmd="account.changePlan"]');expect(buttons[0]?.disabled).toBe(true);expect(buttons[1]?.disabled).toBe(false);
  act(()=>buttons[1]!.click());expect(dispatch).toHaveBeenLastCalledWith({cmd:'account.changePlan',plan:'pro'});
  act(()=>render(null,container));container.remove();
});
