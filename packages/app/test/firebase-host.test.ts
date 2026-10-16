import {beforeEach,expect,it,vi} from 'vitest';
import {firebaseAuth} from '../src/account/firebase';
import {GOOGLE_RETURN_KEY} from '../src/account/google-redirect';
const mocks=vi.hoisted(()=>({
  app:{name:'fixture'},auth:{currentUser:null},session:{type:'SESSION'},initializeAuth:vi.fn(),getAuth:vi.fn(),getRedirectResult:vi.fn(),signInWithRedirect:vi.fn(),sendSignInLinkToEmail:vi.fn(),signInWithEmailLink:vi.fn(),
}));
vi.mock('firebase/app',()=>({initializeApp:()=>mocks.app}));
vi.mock('firebase/auth',()=>({
  initializeAuth:mocks.initializeAuth,getAuth:mocks.getAuth,getRedirectResult:mocks.getRedirectResult,signInWithRedirect:mocks.signInWithRedirect,
  browserSessionPersistence:mocks.session,
  isSignInWithEmailLink:(_auth:unknown,url:string)=>url.includes('oobCode='),
  onAuthStateChanged:(_auth:unknown,changed:(user:null)=>void)=>{changed(null);return()=>{};},
  sendSignInLinkToEmail:mocks.sendSignInLinkToEmail,signInWithEmailLink:mocks.signInWithEmailLink,
}));
beforeEach(()=>{vi.clearAllMocks();sessionStorage.clear();mocks.initializeAuth.mockReturnValue(mocks.auth);mocks.getAuth.mockImplementation(()=>{throw new Error('Default redirect resolver must not initialize in the engine host');});});
function fixture(href='https://femlab.app/?code=not-to-be-saved#access_token=not-to-be-saved'){
  const url=new URL(href),assign=vi.fn(),clear=vi.fn();
  const location={href,origin:url.origin,pathname:url.pathname,assign} as unknown as Location;
  return {auth:firebaseAuth({apiKey:'fixture',projectId:'fixture',authDomain:'femlab.app'},location,sessionStorage,clear),assign,clear};
}
it('initializes only session identity in the engine host, even with an old pending redirect',async()=>{
  sessionStorage.setItem('firebase:pendingRedirect:fixture:[DEFAULT]','true');const f=fixture(),changed=vi.fn();
  await f.auth.initialize(changed);
  expect(changed).toHaveBeenCalledWith(null);expect(mocks.initializeAuth).toHaveBeenCalledWith(mocks.app,{persistence:mocks.session});
  expect(mocks.getAuth).not.toHaveBeenCalled();expect(mocks.getRedirectResult).not.toHaveBeenCalled();
});
it('moves an explicit Google action to the sign-in host without copying URL credentials or calling its resolver',async()=>{
  const f=fixture();expect(await f.auth.signIn('google')).toBe('redirect');
  expect(f.assign).toHaveBeenCalledWith('https://femlab.app/signin.html');
  expect(JSON.parse(sessionStorage.getItem(GOOGLE_RETURN_KEY)!)).toEqual({path:'/',started:false});
  expect(mocks.initializeAuth).not.toHaveBeenCalled();expect(mocks.signInWithRedirect).not.toHaveBeenCalled();
});
it('keeps email-link sign-in and completion on the engine host',async()=>{
  const f=fixture('https://femlab.app/');await f.auth.signIn('email','a@example.com');
  expect(mocks.sendSignInLinkToEmail).toHaveBeenCalledWith(mocks.auth,'a@example.com',{url:'https://femlab.app/',handleCodeInApp:true});
  const returning=fixture('https://femlab.app/?oobCode=fixture');await returning.auth.initialize(vi.fn());
  expect(mocks.signInWithEmailLink).toHaveBeenCalledWith(mocks.auth,'a@example.com','https://femlab.app/?oobCode=fixture');expect(returning.clear).toHaveBeenCalled();expect(sessionStorage.getItem('femlab.signInEmail')).toBeNull();
  expect(mocks.getRedirectResult).not.toHaveBeenCalled();
});
