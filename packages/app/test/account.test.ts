import {expect,it,vi} from 'vitest';
import {AccountController,type AuthPort,type Identity} from '../src/account/controller';
const profile={id:'account-a',email:'a@example.com',createdAt:'2026-10-14T00:00:00Z',status:'active'};
function fixture(){let changed:(i:Identity|null)=>void=()=>{};const auth:AuthPort={initialize:vi.fn(async cb=>{changed=cb;cb(null);return{emailLinkPending:false}}),signIn:vi.fn(async()=> 'sent' as const),signOut:vi.fn(async()=>{changed(null)}),token:vi.fn(async uid=>'token-'+uid)};const fetch=vi.fn<typeof globalThis.fetch>(async()=>new Response(JSON.stringify(profile)));const navigate=vi.fn(),beforeLeave=vi.fn(async()=>{});const c=new AccountController({auth,fetch,origin:'https://api.example.com',googleEnabled:false,navigate,beforeLeave});return{c,auth,fetch,navigate,beforeLeave,changed:(i:Identity|null)=>changed(i)}}
it('supports anonymous modeling and email sign-in without exposing credentials',async()=>{const f=fixture();await f.c.initialize();expect(f.c.state).toMatchObject({status:'anonymous',profile:null});await f.c.services.signIn('email','a@example.com');expect(f.auth.signIn).toHaveBeenCalledWith('email','a@example.com');expect(f.c.state.message).toContain('inbox');await expect(f.c.services.signIn('google')).rejects.toThrow('not enabled');expect(JSON.stringify(f.c.state)).not.toContain('token-');const unsub=f.c.subscribe(vi.fn());unsub();const none=new AccountController(null);await none.initialize();await expect(none.services.signIn('email','a@example.com')).rejects.toThrow('not configured')});
it('rejects late account responses and clears disclosure on identity change',async()=>{const f=fixture();await f.c.initialize();let release!:(r:Response)=>void;f.fetch.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}));f.changed({uid:'a',email:'a@example.com'});await vi.waitFor(()=>expect(release).toBeTypeOf('function'));f.c.services.acceptDisclosure();f.changed(null);release(new Response(JSON.stringify(profile)));await new Promise(resolve=>setTimeout(resolve,0));expect(f.c.state).toMatchObject({uid:null,profile:null,disclosureAccepted:false});await expect(f.c.token('a')).rejects.toThrow('account changed')});
it('uses the current account token, retries only unauthorized reads, and saves before redirects',async()=>{const f=fixture();await f.c.initialize();f.changed({uid:'a',email:'a@example.com'});await vi.waitFor(()=>expect(f.c.state.status).toBe('active'));f.fetch.mockResolvedValueOnce(new Response('{}',{status:401})).mockResolvedValueOnce(new Response(JSON.stringify(profile)));await f.c.refresh();expect(f.auth.token).toHaveBeenCalledWith('a',true);f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({url:'https://checkout.stripe.com/session'})));await f.c.services.checkout('plus');expect(f.fetch).toHaveBeenLastCalledWith('https://api.example.com/v1/billing/checkout',expect.objectContaining({body:'{"plan":"plus"}',headers:expect.objectContaining({Authorization:'Bearer token-a'})}));expect(f.beforeLeave).toHaveBeenCalled();expect(f.navigate).toHaveBeenCalledWith('https://checkout.stripe.com/session');await f.c.services.signOut();expect(f.c.state.uid).toBeNull()});
it('surfaces service errors without replacing another account state',async()=>{const f=fixture();await f.c.initialize();f.changed({uid:'a',email:'a@example.com'});await vi.waitFor(()=>expect(f.c.state.status).toBe('active'));f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({cause:'Payments are not available.'}),{status:503}));await expect(f.c.services.portal()).rejects.toThrow('Payments are not available.');expect(f.c.state.error).toBe('Payments are not available.')});
it('sends the explicit subscription use only to new checkout',async()=>{
  const f=fixture();await f.c.initialize();f.changed({uid:'a',email:'a@example.com'});await vi.waitFor(()=>expect(f.c.state.status).toBe('active'));
  for(const purchaseUse of ['personal','business'] as const){
    f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({url:'https://checkout.stripe.com/session'})));
    await f.c.services.checkout('pro',purchaseUse);
    expect(f.fetch).toHaveBeenLastCalledWith('https://api.example.com/v1/billing/checkout',expect.objectContaining({body:JSON.stringify({plan:'pro',purchaseUse})}));
  }
  f.fetch.mockResolvedValueOnce(new Response('{}'));
  await f.c.services.changePlan('studio');
  expect(f.fetch).toHaveBeenCalledWith('https://api.example.com/v1/billing/plan',expect.objectContaining({body:'{"plan":"studio"}'}));
});
it('posts an empty free-claim body with the authenticated token and refreshes authoritative eligibility',async()=>{
  const f=fixture();await f.c.initialize();f.changed({uid:'a',email:'a@example.com'});await vi.waitFor(()=>expect(f.c.state.status).toBe('active'));
  const updated={...profile,freeAllowance:{status:'claimed',credits:6666666,periodStartsAt:'2026-10-01T00:00:00Z',periodEndsAt:'2026-11-01T00:00:00Z'}};
  f.fetch.mockClear();f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({status:'claimed'}))).mockResolvedValueOnce(new Response(JSON.stringify(updated)));
  await f.c.services.claimFreeAllowance();
  expect(f.fetch).toHaveBeenNthCalledWith(1,'https://api.example.com/v1/account/free-allowance',expect.objectContaining({method:'POST',body:'{}',headers:expect.objectContaining({Authorization:'Bearer token-a'})}));
  expect(f.fetch).toHaveBeenNthCalledWith(2,'https://api.example.com/v1/account',expect.objectContaining({method:'GET'}));
  expect(f.c.state.profile?.freeAllowance?.status).toBe('claimed');expect(f.c.state.message).toBe('Free allowance claim complete.');expect(f.navigate).not.toHaveBeenCalled();
});
it('surfaces denied free eligibility without a refresh or local credit grant',async()=>{
  const f=fixture();await f.c.initialize();f.changed({uid:'a',email:'a@example.com'});await vi.waitFor(()=>expect(f.c.state.status).toBe('active'));
  f.fetch.mockClear();f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({code:'eligibility-required',cause:'Eligibility review is required.'}),{status:403}));
  await expect(f.c.services.claimFreeAllowance()).rejects.toThrow('Eligibility review is required.');
  expect(f.fetch).toHaveBeenCalledTimes(1);expect(f.c.state.profile).toEqual(profile);expect(f.c.state.error).toBe('Eligibility review is required.');
});
it('does not refresh or announce a free claim after the signed-in identity changes',async()=>{
  const f=fixture();await f.c.initialize();f.changed({uid:'a',email:'a@example.com'});await vi.waitFor(()=>expect(f.c.state.status).toBe('active'));
  let release!:(response:Response)=>void;f.fetch.mockClear();f.fetch.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}));
  const claim=f.c.services.claimFreeAllowance();await vi.waitFor(()=>expect(release).toBeTypeOf('function'));f.changed(null);release(new Response(JSON.stringify({status:'claimed'})));
  await expect(claim).rejects.toThrow('account changed');expect(f.c.state).toMatchObject({uid:null,profile:null,message:null});expect(f.fetch).toHaveBeenCalledTimes(1);
});
