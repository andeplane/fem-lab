// Test-only authentication adapter. Production uses Firebase; no external account is created.
import {AccountController,type Identity,type AuthPort} from '../../src/account/controller';
let changed:(identity:Identity|null)=>void=()=>{},beforeLeave:()=>Promise<void>=async()=>{};
declare global{interface Window{cloudFixture:{identify(uid:string|null):void}}}
const auth:AuthPort={initialize:async listener=>{changed=listener;changed(null);return {emailLinkPending:false};},signIn:async()=>{changed({uid:'fixture-A',email:'fixture-A@example.invalid'});return 'signed-in';},signOut:async()=>changed(null),token:async uid=>uid};
export const accounts=new AccountController({auth,fetch:(...args)=>fetch(...args),origin:'/__cloud_fixture',googleEnabled:true,beforeLeave:()=>beforeLeave(),navigate:()=>{throw new Error('External navigation is forbidden in the cloud fixture.');}});
export function accountLeaveHook(hook:()=>Promise<void>):void{beforeLeave=hook;}
window.cloudFixture={identify:uid=>changed(uid?{uid,email:uid+'@example.invalid'}:null)};
