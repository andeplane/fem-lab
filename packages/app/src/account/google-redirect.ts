/** Only this app's entry path crosses the sign-in boundary; never copy URL auth parameters. */
export const GOOGLE_RETURN_KEY='femlab.googleReturn';
interface GoogleReturn {path:string;started:boolean}
export interface GoogleRedirectEnvironment {
  storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>;
  origin:string;base:string;
  complete():Promise<boolean>;
  begin():Promise<void>;
  navigate(path:string):void;
}
export function googleEntry(origin:string,base:string):URL {
  const entry=new URL(base,origin);
  if(entry.origin!==origin||entry.search||entry.hash||!entry.pathname.endsWith('/')||entry.pathname.split('/').some(part=>part==='__'||part==='signin.html'))throw new Error('Invalid app entry.');
  return entry;
}
export function beginGoogleRedirect(storage:GoogleRedirectEnvironment['storage'],origin:string,base:string,navigate:(url:string)=>void):void {
  const entry=googleEntry(origin,base);
  storage.setItem(GOOGLE_RETURN_KEY,JSON.stringify({path:entry.pathname,started:false} satisfies GoogleReturn));
  navigate(new URL('signin.html',entry).href);
}
/** Firebase's iframe runs only in the non-isolated sign-in host, never the engine host. */
export async function finishGoogleRedirect(env:GoogleRedirectEnvironment):Promise<void> {
  const entry=googleEntry(env.origin,env.base);
  let flow:GoogleReturn|undefined;
  try {
    const value:unknown=JSON.parse(env.storage.getItem(GOOGLE_RETURN_KEY)??'null');
    if(value&&typeof value==='object'&&'path' in value&&value.path===entry.pathname&&'started' in value&&typeof value.started==='boolean')flow={path:entry.pathname,started:value.started};
  } catch { /* Missing or edited browser state cannot select a redirect target. */ }
  if(!flow){env.storage.removeItem(GOOGLE_RETURN_KEY);env.navigate(entry.pathname);return;}
  const signedIn=await env.complete();
  if(flow.started||signedIn){env.storage.removeItem(GOOGLE_RETURN_KEY);env.navigate(entry.pathname);return;}
  env.storage.setItem(GOOGLE_RETURN_KEY,JSON.stringify({...flow,started:true}));
  await env.begin();
}
