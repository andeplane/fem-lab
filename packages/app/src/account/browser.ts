import {AccountController} from './controller';
import {firebaseAuth} from './firebase';
let beforeLeave:()=>Promise<void>=async()=>{};
export function accountLeaveHook(hook:()=>Promise<void>):void{beforeLeave=hook}
export const accounts=new AccountController(__FIREBASE_CONFIG__&&__AI_API_ORIGIN__?{
  auth:firebaseAuth(__FIREBASE_CONFIG__,location,sessionStorage,()=>history.replaceState(null,'',location.pathname+location.hash)),
  fetch:(...args)=>fetch(...args),origin:__AI_API_ORIGIN__,googleEnabled:__GOOGLE_SIGN_IN__,
  beforeLeave:()=>beforeLeave(),navigate:url=>location.assign(url),
}:null);
