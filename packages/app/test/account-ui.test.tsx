import {render} from 'preact';
import {act} from 'preact/test-utils';
import {expect,it,vi} from 'vitest';
import {AccountPanel} from '../src/ui/Account';
import {initialState} from '../src/store';
import {EMPTY_ACCOUNT} from '@femlab/registry';
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
