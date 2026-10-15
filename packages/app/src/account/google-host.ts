import type {FirebaseOptions} from 'firebase/app';
import type {GoogleRedirectEnvironment} from './google-redirect';

/** The non-isolated auth document alone owns Firebase's redirect resolver and helper iframe. */
export function googleAuthHost(config:FirebaseOptions|null,enabled:boolean,isolated:boolean):Pick<GoogleRedirectEnvironment,'complete'|'begin'> {
  let ready:Promise<{sdk:typeof import('firebase/auth');auth:import('firebase/auth').Auth}>|undefined;
  const load=()=>ready??=(async()=>{
    if(!config||!enabled||isolated)throw new Error('Sign-in host unavailable.');
    const [{initializeApp},sdk]=await Promise.all([import('firebase/app'),import('firebase/auth')]);
    const auth=sdk.initializeAuth(initializeApp(config),{persistence:sdk.browserSessionPersistence,popupRedirectResolver:sdk.browserPopupRedirectResolver});
    return {sdk,auth};
  })();
  return {
    async complete(){const {sdk,auth}=await load();return Boolean(await sdk.getRedirectResult(auth));},
    async begin(){const {sdk,auth}=await load();await sdk.signInWithRedirect(auth,new sdk.GoogleAuthProvider());},
  };
}
