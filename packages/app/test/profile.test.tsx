import {render} from 'preact';
import {act} from 'preact/test-utils';
import {afterEach,expect,it,vi} from 'vitest';
import {EMPTY_ACCOUNT,PUBLIC_CREDIT_UNIT,type AccountState} from '@femlab/registry';
import {HomeAccount,ProfileControl,profileInitials} from '../src/ui/Profile';
import {Start} from '../src/ui/Overlays';
import {initialState,panelsReducer} from '../src/store';
import {handleGlobalKey} from '../src/ui/App';
import {Palette} from '../src/ui/Overlays';

function signed():AccountState{return {...EMPTY_ACCOUNT,configured:true,status:'active',uid:'A',email:'ada.lovelace@example.test',profile:{id:'A',email:'ada.lovelace@example.test',createdAt:'2026-10-01T00:00:00Z',status:'active',creditUnit:PUBLIC_CREDIT_UNIT,usage:{plan:'free',availableCredits:4999.9155,totalCredits:5000,reservedCredits:0,periodEndsAt:'2026-11-01T00:00:00Z',models:[],maxOutput:4096,contextLimit:64000,tariffVersion:'v1'},freeAllowance:{status:'claimed',credits:5000,periodStartsAt:'2026-10-01T00:00:00Z',periodEndsAt:'2026-11-01T00:00:00Z'}}};}
const dispatcher=()=>vi.fn(async(_command:Record<string,unknown>):Promise<unknown>=>undefined);
const button=(command:string)=>document.querySelector<HTMLButtonElement>(`[data-cmd="${command}"]`)!;
afterEach(()=>act(()=>render(null,document.body)));

it('uses actual identity initials rather than inventing a person or fetching a remote avatar',()=>{
  expect(profileInitials('ada.lovelace@example.test')).toBe('AL');expect(profileInitials('a@example.test')).toBe('A');expect(profileInitials(null)).toBe('FL');
  const dispatch=dispatcher(),account=signed();
  act(()=>render(<ProfileControl account={account} dispatch={dispatch}/>,document.body));
  expect(document.querySelector('.profile-trigger')?.textContent).toContain(account.email);
  expect(document.querySelector('img')).toBeNull();expect(document.querySelector('.profile-popover')).toBeNull();
  act(()=>button('panel.toggle').click());expect(dispatch).toHaveBeenCalledExactlyOnceWith({cmd:'panel.toggle',panel:'profile',open:true});
});
it('keeps guest login explicit and prevents duplicate login while restoring identity',()=>{
  const dispatch=dispatcher(),account={...EMPTY_ACCOUNT,status:'loading' as const};
  act(()=>render(<ProfileControl account={account} dispatch={dispatch} compact/>,document.body));
  expect(button('account.open').disabled).toBe(true);expect(button('account.open').textContent).toContain('Restoring sign-in');
  act(()=>render(<ProfileControl account={{...account,status:'anonymous'}} dispatch={dispatch} compact/>,document.body));
  act(()=>button('account.open').click());expect(dispatch).toHaveBeenCalledExactlyOnceWith({cmd:'account.open'});
});
it.each(['account.open','account.refresh','account.signOut'])('closes the profile before the explicit %s action',async command=>{
  const dispatch=dispatcher();act(()=>render(<ProfileControl account={signed()} dispatch={dispatch} open/>,document.body));
  expect(document.querySelector('.profile-popover-allowance')?.textContent).toContain('4,999.92 credits available');
  await act(async()=>{button(command).click();await Promise.resolve();});
  expect(dispatch.mock.calls.map(([value])=>value)).toEqual([{cmd:'panel.toggle',panel:'profile',open:false},{cmd:command}]);
});
it('preserves the landing handoff callback when opening account settings',async()=>{
  const dispatch=dispatcher(),onAccount=vi.fn();
  act(()=>render(<ProfileControl account={signed()} dispatch={dispatch} open onAccount={onAccount}/>,document.body));
  await act(async()=>{button('account.open').click();await Promise.resolve();});
  expect(onAccount).toHaveBeenCalledOnce();expect(dispatch).toHaveBeenCalledExactlyOnceWith({cmd:'panel.toggle',panel:'profile',open:false});
});
it('closes on Escape or outside click, and isolates clicks inside the dialog',()=>{
  const dispatch=dispatcher();act(()=>render(<ProfileControl account={signed()} dispatch={dispatch} open/>,document.body));
  act(()=>{document.querySelector('.profile-popover-heading')!.dispatchEvent(new MouseEvent('click',{bubbles:true}));});expect(dispatch).not.toHaveBeenCalled();
  act(()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'a',bubbles:true}));});expect(dispatch).not.toHaveBeenCalled();
  act(()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));});expect(dispatch).toHaveBeenCalledWith({cmd:'panel.toggle',panel:'profile',open:false});
  dispatch.mockClear();act(()=>{document.querySelector('.profile-scrim')!.dispatchEvent(new MouseEvent('click',{bubbles:true}));});expect(dispatch).toHaveBeenCalledExactlyOnceWith({cmd:'panel.toggle',panel:'profile',open:false});
});
it('never applies a late sign-out after account identity changes, including A to B to A',async()=>{
  const dispatch=dispatcher();let resolve!:()=>void;const pending=new Promise<void>(done=>{resolve=done;});
  const account=signed(),show=()=>act(()=>render(<ProfileControl account={account} dispatch={dispatch} open/>,document.body));show();
  dispatch.mockImplementationOnce(async()=>pending);act(()=>button('account.signOut').click());
  account.uid='B';account.email='other@example.test';show();expect(document.querySelector('.profile-popover')?.textContent).not.toContain('ada.lovelace');
  account.uid='A';show();await act(async()=>{resolve();await pending;});
  expect(dispatch.mock.calls.some(([value])=>value['cmd']==='account.signOut')).toBe(false);
});
it('does not dispatch a follow-up action if closing the profile fails',async()=>{
  const dispatch=vi.fn(async()=>{throw new Error('retired session');});
  act(()=>render(<ProfileControl account={signed()} dispatch={dispatch} open/>,document.body));
  await act(async()=>{button('account.signOut').click();await Promise.resolve();await Promise.resolve();});expect(dispatch).toHaveBeenCalledOnce();
});
it.each(['loading','error'] as const)('does not present a stale allowance as current during %s',status=>{
  const account=signed();account.status=status;const dispatch=dispatcher();
  act(()=>render(<><ProfileControl account={account} dispatch={dispatch} open/><HomeAccount account={account} dispatch={dispatch} onAccount={()=>{}}/></>,document.body));
  expect(document.querySelector('.home-credit-value')).toBeNull();expect(document.querySelector('meter')).toBeNull();expect(document.body.textContent).not.toContain('4,999.92');
  expect(document.querySelector('.home-account-pending')?.textContent).toContain(status==='error'?'Could not refresh':'Loading your AI allowance');
  expect(document.querySelector<HTMLButtonElement>('[data-cmd="account.refresh"]')!.disabled).toBe(status==='loading');
});
it('shows true zero without granting, and preserves exact accounting while clamping only meter bounds',()=>{
  const account=signed(),dispatch=dispatcher(),onAccount=vi.fn();Object.assign(account.profile!.usage!,{availableCredits:0,totalCredits:0,reservedCredits:0});
  account.profile!.freeAllowance!.status='review-required';
  act(()=>render(<HomeAccount account={account} dispatch={dispatch} onAccount={onAccount}/>,document.body));
  const meter=document.querySelector('meter')!;expect(meter.value).toBe(0);expect(meter.getAttribute('max')).toBe('100');expect(document.body.textContent).toContain('eligibility review');
  expect(dispatch).not.toHaveBeenCalled();act(()=>button('account.open').click());expect(onAccount).toHaveBeenCalledOnce();
  account.profile!.usage!.plan='plus';account.profile!.usage!.availableCredits=6000.0001;account.profile!.usage!.totalCredits=5000;
  act(()=>render(<HomeAccount account={account} dispatch={dispatch} onAccount={onAccount}/>,document.body));
  expect(document.querySelector('meter')!.getAttribute('value')).toBe('100');expect(account.profile!.usage!.availableCredits).toBe(6000.0001);expect(document.body.textContent).toContain('subscription includes');
});
it('keeps the prompt DOM and unsent text while home changes from guest to signed in',()=>{
  const dispatch=dispatcher(),s={...structuredClone(initialState),ready:true};
  const show=()=>act(()=>render(<Start s={s} dispatch={dispatch} hosted/>,document.body));show();
  const prompt=document.querySelector<HTMLInputElement>('.ask-field')!;
  act(()=>{prompt.value='check a beam';prompt.dispatchEvent(new Event('input',{bubbles:true}));});
  s.account=signed();show();expect(document.querySelector('.ask-field')).toBe(prompt);expect(prompt.value).toBe('check a beam');
  expect(document.querySelector('h1')?.textContent).toContain('Welcome back');expect(document.querySelector('.home-account-identity')?.textContent).toContain(s.account.email);
  expect(document.querySelector('.landing-primary')?.textContent).toContain('Start modeling');expect(dispatch).not.toHaveBeenCalled();
});
it('keeps account settings and the profile popover mutually exclusive without touching workspace panels',()=>{
  expect(panelsReducer({assistant:true,account:true},'profile',true)).toEqual({assistant:true,account:false,profile:true});
  expect(panelsReducer({assistant:true,profile:true},'account',true)).toEqual({assistant:true,account:true,profile:false});
  expect(panelsReducer({profile:true},'profile',false)).toEqual({profile:false});
});
it.each(['account','palette','examples','report','projects','export','tutorial','abaqus','abaqusReport','step','stepReport'])('keeps one modal focus owner when %s and profile open in either order',modal=>{
  expect(panelsReducer({assistant:true,'tree.geometry':true,profile:true},modal,true)).toEqual({assistant:true,'tree.geometry':true,profile:false,[modal]:true});
  expect(panelsReducer({assistant:true,'tree.geometry':true,[modal]:true},'profile',true)).toEqual({assistant:true,'tree.geometry':true,[modal]:false,profile:true});
});
it.each(['ctrlKey','metaKey'] as const)('hands modal focus from profile to the real command palette on %s+K',key=>{
  const s={...structuredClone(initialState),account:signed(),panels:{profile:true}};
  const dispatch=vi.fn(async(command:Record<string,unknown>)=>{s.panels=panelsReducer(s.panels,String(command['panel']),command['open'] as boolean|undefined) as typeof s.panels;});
  const show=()=>act(()=>render(<><ProfileControl account={s.account} dispatch={dispatch} open={s.panels.profile}/><Palette s={s} dispatch={dispatch} commands={[]}/></>,document.body));show();
  act(()=>handleGlobalKey(new KeyboardEvent('keydown',{key:'k',[key]:true,cancelable:true}),dispatch,1,s.panels));show();
  expect(s.panels).toMatchObject({profile:false,palette:true});expect(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).toHaveLength(1);
  expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Command palette');
});
it('blocks model shortcuts behind the profile, but keeps its Escape action callable',()=>{
  const dispatch=dispatcher();for(const options of [{key:'1',code:'Digit1',shiftKey:true},{key:'z',ctrlKey:true},{key:'z',metaKey:true,shiftKey:true},{key:'c',ctrlKey:true}])handleGlobalKey(new KeyboardEvent('keydown',options),dispatch,1,{profile:true});
  expect(dispatch).not.toHaveBeenCalled();handleGlobalKey(new KeyboardEvent('keydown',{key:'Escape'}),dispatch,1,{profile:true});expect(dispatch).toHaveBeenCalledExactlyOnceWith({cmd:'panel.toggle',panel:'profile',open:false});
});
