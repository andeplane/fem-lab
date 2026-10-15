import {finishGoogleRedirect,googleEntry} from './google-redirect';
import {googleAuthHost} from './google-host';
import './signin.css';

const entry=googleEntry(location.origin,import.meta.env.BASE_URL);
document.querySelector<HTMLAnchorElement>('#return-to-app')!.href=entry.pathname;
void finishGoogleRedirect({storage:sessionStorage,origin:location.origin,base:import.meta.env.BASE_URL,
  ...googleAuthHost(__FIREBASE_CONFIG__,__GOOGLE_SIGN_IN__,crossOriginIsolated),
  navigate:path=>location.replace(path),
}).catch(()=>{document.querySelector('#signin-status')!.textContent='Sign-in could not complete. Return to FEM Lab and try again.';});
