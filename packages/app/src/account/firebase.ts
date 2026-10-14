import type {FirebaseOptions} from 'firebase/app';
import type {AuthPort} from './controller';
/** Lazy SDK import keeps optional login out of the engine/start-screen loading path. */
export function firebaseAuth(config:FirebaseOptions,location:Location,storage:Storage,clearLink:()=>void):AuthPort {
  let ready:Promise<{sdk:typeof import('firebase/auth');auth:import('firebase/auth').Auth}>|undefined;
  const load=()=>ready??=(async()=>{const [{initializeApp},sdk]=await Promise.all([import('firebase/app'),import('firebase/auth')]);const auth=sdk.getAuth(initializeApp(config));await sdk.setPersistence(auth,sdk.browserSessionPersistence);return{sdk,auth}})();
  const pending=()=>location.href.includes('oobCode=');
  const finish=async(email:string)=>{const {sdk,auth}=await load();await sdk.signInWithEmailLink(auth,email,location.href);storage.removeItem('femlab.signInEmail');clearLink()};
  return {
    async initialize(changed){const {sdk,auth}=await load();if(sdk.isSignInWithEmailLink(auth,location.href)){const email=storage.getItem('femlab.signInEmail');if(email)await finish(email)}await sdk.getRedirectResult(auth);await new Promise<void>((resolve,reject)=>sdk.onAuthStateChanged(auth,user=>{changed(user?{uid:user.uid,email:user.email}:null);resolve()},reject));return{emailLinkPending:sdk.isSignInWithEmailLink(auth,location.href)}},
    async signIn(method,email){const {sdk,auth}=await load();if(method==='google'){await sdk.signInWithRedirect(auth,new sdk.GoogleAuthProvider());return'redirect'}if(!email)throw new Error('Enter your email address.');if(pending()&&sdk.isSignInWithEmailLink(auth,location.href)){await finish(email);return'signed-in'}await sdk.sendSignInLinkToEmail(auth,email,{url:location.origin+location.pathname,handleCodeInApp:true});storage.setItem('femlab.signInEmail',email);return'sent'},
    async signOut(){const {sdk,auth}=await load();await sdk.signOut(auth)},
    async token(uid,force){const {auth}=await load();const user=auth.currentUser;if(!user||user.uid!==uid)throw new Error('Sign in again.');const token=await user.getIdToken(force);if(auth.currentUser?.uid!==uid)throw new Error('The account changed.');return token},
  };
}
