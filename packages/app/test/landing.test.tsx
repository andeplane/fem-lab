import {render} from 'preact';
import {act} from 'preact/test-utils';
import {afterEach,expect,it,vi} from 'vitest';
import {EMPTY_ACCOUNT} from '@femlab/registry';
import {landingPrompt} from '../src/landing-prompt';
import {initialState} from '../src/store';
import {Start} from '../src/ui/Overlays';

const state=()=>({...structuredClone(initialState),ready:true});
const storage=()=>{const values=new Map<string,string>();return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};};
function mount(s=state(),hosted=true,prompt=landingPrompt(storage)) {
  const dispatch=vi.fn(async(_command:Record<string,unknown>):Promise<void>=>{});
  act(()=>render(<Start s={s} dispatch={dispatch} hosted={hosted} promptStore={prompt}/>,document.body));
  return {dispatch,prompt,input:()=>document.querySelector<HTMLInputElement>('.ask-field')!,button:()=>document.querySelector<HTMLButtonElement>('.ask-send')!};
}
async function type(input:HTMLInputElement,text:string){await act(()=>{input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));});}
afterEach(()=>{act(()=>render(null,document.body));});

it.each(['click','Enter'])('anonymous hosted %s opens sign-in and retains an unsent request without invoking AI',async(action)=>{
  const store=storage(),prompt=landingPrompt(()=>store),ui=mount(state(),true,prompt);
  expect(ui.button().textContent).toContain('Sign in to continue');expect(ui.button().disabled).toBe(true);
  await type(ui.input(),'  a cantilever with a tip load  ');
  await act(()=>{if(action==='click')ui.button().click();else ui.input().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));});
  expect(ui.dispatch.mock.calls.map(([cmd])=>cmd)).toEqual([{cmd:'account.open'}]);
  expect(prompt.read()).toBe('  a cantilever with a tip load  ');expect(ui.input().value).toBe(prompt.read());
});
it('restores a same-tab sign-in draft without automatic submission and opens editable Assistant text on explicit review',async()=>{
  const store=storage(),prompt=landingPrompt(()=>store);prompt.save('saved before sign-in');
  const s=state();s.account={...EMPTY_ACCOUNT,uid:'owner',status:'active',disclosureAccepted:false};
  const ui=mount(s,true,prompt);expect(ui.input().value).toBe('saved before sign-in');expect(ui.dispatch).not.toHaveBeenCalled();
  expect(ui.button().textContent).toContain('Review in assistant');
  await act(async()=>{ui.button().click();await Promise.resolve();await Promise.resolve();});
  expect(ui.dispatch.mock.calls.map(([cmd])=>cmd)).toEqual([{cmd:'panel.toggle',panel:'assistant',open:true},{cmd:'chat.setDraft',text:'saved before sign-in'}]);
  expect(prompt.read()).toBe('');expect(ui.dispatch.mock.calls.some(([cmd])=>cmd['cmd']==='chat.send')).toBe(false);
});
it('preserves the development-key send path without applying hosted account requirements',async()=>{
  const ui=mount(state(),false);await type(ui.input(),'develop locally');
  await act(async()=>{ui.button().click();await Promise.resolve();});
  expect(ui.dispatch.mock.calls.map(([cmd])=>cmd)).toEqual([{cmd:'panel.toggle',panel:'assistant',open:true},{cmd:'chat.send',text:'develop locally'}]);
});
it('keeps a failed handoff recoverable, explains blocked storage, and offers engine-free docs while startup is unavailable',async()=>{
  const blocked=landingPrompt(()=>{throw new Error('blocked');});expect(blocked.read()).toBe('');expect(()=>blocked.clear()).not.toThrow();
  const ui=mount(state(),true,blocked);await type(ui.input(),'copy me');await act(()=>ui.button().click());
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Copy your request');expect(ui.input().value).toBe('copy me');
  const pending={...state(),ready:false};act(()=>render(<Start s={pending} dispatch={ui.dispatch} hosted promptStore={blocked}/>,document.body));
  expect(ui.button().disabled).toBe(true);expect(document.querySelector<HTMLAnchorElement>('nav[aria-label="Main navigation"] a')?.href).toMatch(/\/docs\/$/);
});
it('retains a saved draft if opening the assistant fails and keeps the local modeling CTA separate from AI',async()=>{
  const store=storage(),prompt=landingPrompt(()=>store);prompt.save('retry this');const s=state();s.account={...EMPTY_ACCOUNT,uid:'owner',status:'active'};
  const dispatch=vi.fn(async(command:Record<string,unknown>)=>{if(command['cmd']==='panel.toggle')throw new Error('inactive session');});
  act(()=>render(<Start s={s} dispatch={dispatch} hosted promptStore={prompt}/>,document.body));
  await act(async()=>{document.querySelector<HTMLButtonElement>('.ask-send')!.click();await Promise.resolve();});expect(document.querySelector<HTMLInputElement>('.ask-field')!.value).toBe('retry this');
  await act(()=>document.querySelector<HTMLButtonElement>('.landing-primary')!.click());expect(dispatch).toHaveBeenLastCalledWith({cmd:'project.new',name:'model'});
  expect(document.querySelector('.pitch')?.textContent).toContain('finite-element');
});

it('adopts an anonymous draft only for the first owner, clears on sign-out/switch and blocks a late handoff across identities',async()=>{
  const store=storage(),prompt=landingPrompt(()=>store);prompt.save('anonymous request');const s=state();
  const dispatch=vi.fn(async(_command:Record<string,unknown>):Promise<void>=>{});
  const show=async()=>{await act(()=>render(<Start s={s} dispatch={dispatch} hosted promptStore={prompt}/>,document.body));};
  await show();expect(document.querySelector<HTMLInputElement>('.ask-field')!.value).toBe('anonymous request');
  s.account={...EMPTY_ACCOUNT,uid:'A',status:'active'};await show();
  expect(document.querySelector<HTMLInputElement>('.ask-field')!.value).toBe('anonymous request');expect(prompt.read()).toBe('');expect(prompt.read('A')).toBe('anonymous request');
  s.account={...EMPTY_ACCOUNT};await show();expect(document.querySelector<HTMLInputElement>('.ask-field')!.value).toBe('');
  s.account={...EMPTY_ACCOUNT,uid:'A',status:'active'};await show();await type(document.querySelector<HTMLInputElement>('.ask-field')!,'private A draft');
  let finish!:()=>void;const waiting=new Promise<void>(resolve=>{finish=resolve;});dispatch.mockImplementationOnce(async()=>waiting);
  await act(()=>document.querySelector<HTMLButtonElement>('.ask-send')!.click());
  s.account={...EMPTY_ACCOUNT,uid:'B',status:'active'};await show();expect(document.querySelector<HTMLInputElement>('.ask-field')!.value).toBe('');
  s.account={...EMPTY_ACCOUNT,uid:'A',status:'active'};await show();
  await act(async()=>{finish();await waiting;});
  expect(dispatch.mock.calls.map(([command])=>command['cmd'])).toEqual(['panel.toggle']);
});

it('never restores an owner-bound request to a different or anonymous account, and ignores malformed stored input',()=>{
  const store=storage(),prompt=landingPrompt(()=>store);expect(prompt.bind('A')).toBe('');prompt.save('private after sign-in');
  expect(prompt.bind('A')).toBe('private after sign-in');expect(prompt.read()).toBe('');expect(prompt.read('A')).toBe('private after sign-in');
  expect(prompt.bind('B')).toBe('');expect(prompt.read('A')).toBe('');
  store.setItem('femlab.unsentLandingPrompt','bad JSON');expect(prompt.read()).toBe('');expect(prompt.bind('A')).toBe('');
  store.setItem('femlab.unsentLandingPrompt',JSON.stringify({text:7,owner:4}));expect(prompt.read()).toBe('');
});

it.each(['loading','error'] as const)('retains the owner of a %s account draft during reauthentication',async status=>{
  const store=storage(),prompt=landingPrompt(()=>store),s=state();s.account={...EMPTY_ACCOUNT,uid:'A',status};
  const ui=mount(s,true,prompt);await type(ui.input(),'private reauthentication request');await act(()=>ui.button().click());
  expect(prompt.read()).toBe('');expect(prompt.read('A')).toBe('private reauthentication request');
  s.account={...EMPTY_ACCOUNT,uid:'B',status:'active'};await act(()=>render(<Start s={s} dispatch={ui.dispatch} hosted promptStore={prompt}/>,document.body));
  expect(ui.input().value).toBe('');expect(prompt.read('B')).toBe('');expect(prompt.read('A')).toBe('');
});

it('preserves a draft through the header sign-in action and never restores a request the person cleared',async()=>{
  const store=storage(),prompt=landingPrompt(()=>store),ui=mount(state(),true,prompt);await type(ui.input(),'typed before header sign-in');
  await act(()=>document.querySelector<HTMLButtonElement>('nav[aria-label="Main navigation"] [data-cmd="account.open"]')!.click());
  expect(ui.dispatch).toHaveBeenCalledWith({cmd:'account.open'});expect(prompt.read()).toBe('typed before header sign-in');
  await type(ui.input(),'edited before return');expect(prompt.read()).toBe('edited before return');
  await type(ui.input(),'');expect(prompt.read()).toBe('');
});
