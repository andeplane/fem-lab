import {beforeEach,expect,it,vi} from 'vitest';
import {googleAuthHost} from '../src/account/google-host';
const mocks=vi.hoisted(()=>({app:{name:'fixture'},auth:{currentUser:null},session:{type:'SESSION'},resolver:{type:'REDIRECT'},provider:{},initializeAuth:vi.fn(),getRedirectResult:vi.fn(),signInWithRedirect:vi.fn()}));
vi.mock('firebase/app',()=>({initializeApp:()=>mocks.app}));
vi.mock('firebase/auth',()=>({initializeAuth:mocks.initializeAuth,browserSessionPersistence:mocks.session,browserPopupRedirectResolver:mocks.resolver,getRedirectResult:mocks.getRedirectResult,signInWithRedirect:mocks.signInWithRedirect,GoogleAuthProvider:class {constructor(){return mocks.provider;}}}));
beforeEach(()=>{vi.clearAllMocks();mocks.initializeAuth.mockReturnValue(mocks.auth);mocks.getRedirectResult.mockResolvedValue(null);});
const config={apiKey:'fixture',projectId:'fixture',authDomain:'femlab.app'};
it('completes a canceled return and begins the explicit redirect through one session-persistent resolver',async()=>{
  const host=googleAuthHost(config,true,false);
  expect(await host.complete()).toBe(false);await host.begin();
  expect(mocks.initializeAuth).toHaveBeenCalledExactlyOnceWith(mocks.app,{persistence:mocks.session,popupRedirectResolver:mocks.resolver});
  expect(mocks.getRedirectResult).toHaveBeenCalledExactlyOnceWith(mocks.auth);expect(mocks.signInWithRedirect).toHaveBeenCalledExactlyOnceWith(mocks.auth,mocks.provider);
});
it('reports a completed credential to the return coordinator',async()=>{
  mocks.getRedirectResult.mockResolvedValue({user:{uid:'fixture'}});expect(await googleAuthHost(config,true,false).complete()).toBe(true);
});
it.each([{config:null,enabled:true,isolated:false},{config,enabled:false,isolated:false},{config,enabled:true,isolated:true}])('refuses unavailable or isolated sign-in hosts %s',async env=>{
  const host=googleAuthHost(env.config,env.enabled,env.isolated);await expect(host.complete()).rejects.toThrow('Sign-in host unavailable');await expect(host.begin()).rejects.toThrow('Sign-in host unavailable');expect(mocks.initializeAuth).not.toHaveBeenCalled();
});
it('propagates Firebase errors without creating a second initialization or swallowing failed completion',async()=>{
  mocks.getRedirectResult.mockRejectedValue(new Error('network failure'));const host=googleAuthHost(config,true,false);await expect(host.complete()).rejects.toThrow('network failure');await expect(host.complete()).rejects.toThrow('network failure');expect(mocks.initializeAuth).toHaveBeenCalledOnce();
});
