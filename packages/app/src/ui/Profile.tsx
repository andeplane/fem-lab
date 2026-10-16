import type {AccountState} from '@femlab/registry';
import {useEffect,useId,useRef} from 'preact/hooks';
import {formatAiCredits} from '../account/credits';
import {Cmd,type Dispatch} from './cmd';
import {useDialogFocus} from './Dialog';
import './profile.css';

export function profileInitials(email:string|null):string {
  const words=(email??'').split('@')[0]!.split(/[.\-_\s]+/).filter(Boolean);
  return words.length ? words.slice(0,2).map(word=>word[0]).join('').toUpperCase() : 'FL';
}

/** The same identity control follows a person from Home into the modeling workspace. */
export function ProfileControl({account,dispatch,open=false,disabled=false,compact=false,onAccount}: {
  account:AccountState;dispatch:Dispatch;open?:boolean;disabled?:boolean;compact?:boolean;onAccount?:()=>void;
}) {
  const id=useId(),menu=useRef<HTMLDivElement>(null),owner=useRef(account.uid);
  const identity=useRef({uid:account.uid});
  if(identity.current.uid!==account.uid)identity.current={uid:account.uid};
  const close=()=>dispatch({cmd:'panel.toggle',panel:'profile',open:false});
  useDialogFocus(open&&account.uid!==null,menu);
  useEffect(()=>{
    if(owner.current!==account.uid&&open)void close().catch(()=>undefined);
    owner.current=account.uid;
  },[account.uid,open]);
  useEffect(()=>{
    if(!open)return;
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();void close().catch(()=>undefined);}};
    document.addEventListener('keydown',escape);
    return()=>document.removeEventListener('keydown',escape);
  },[open]);
  const accountAction=()=>{if(onAccount)onAccount();else void dispatch({cmd:'account.open'}).catch(()=>undefined);};
  const action=(command:string)=>()=>{const actor=identity.current;void close().then(()=>{if(identity.current!==actor)return;return command==='account.open'?accountAction():dispatch({cmd:command});}).catch(()=>undefined);};
  if(!account.uid)return <Cmd dispatch={dispatch} cmd="account.open" class={compact?'tbutton account-button':'profile-sign-in'} disabled={disabled||account.status==='loading'} label={compact?'Sign in':'Sign in for AI'} onRun={accountAction}>
    <span class="account-button-label">{account.status==='loading'?'Restoring sign-in…':'Sign in'}</span><span class="account-button-icon" aria-hidden="true">↗</span>
  </Cmd>;
  const email=account.email??'Your account',usage=account.status==='active'?account.profile?.usage:undefined;
  return <>
    <Cmd dispatch={dispatch} cmd="panel.toggle" args={{panel:'profile',open:!open}} class={`profile-trigger${compact?' tbutton account-button profile-trigger-compact':''}`} disabled={disabled} label={`Open profile for ${email}`} title={email} expanded={open} controls={`profile-${id}`}>
      <span class="profile-avatar" aria-hidden="true">{profileInitials(account.email)}</span>
      <span class="profile-trigger-copy"><strong>{email}</strong><small>{usage?`${usage.plan.toUpperCase()} PLAN`:account.status==='error'?'Account needs attention':'Refreshing account…'}</small></span>
      <span class="profile-chevron" aria-hidden="true">⌄</span>
    </Cmd>
    {open?<div class="profile-scrim" onClick={()=>void close().catch(()=>undefined)}>
      <div ref={menu} class="profile-popover" id={`profile-${id}`} role="dialog" aria-modal="true" aria-label="Your profile" onClick={event=>event.stopPropagation()}>
        <div class="profile-popover-heading"><span class="profile-avatar" aria-hidden="true">{profileInitials(account.email)}</span><div><strong>{email}</strong><span>{account.status==='active'?'Signed in':account.status==='error'?'Account needs attention':'Refreshing your account'}</span></div></div>
        <div class="profile-popover-allowance"><span>{usage?`${usage.plan.toUpperCase()} PLAN`:'AI ALLOWANCE'}</span><strong>{usage?`${formatAiCredits(usage.availableCredits)} credits available`:'Balance unavailable until account refresh completes'}</strong></div>
        <Cmd dispatch={dispatch} cmd="account.open" class="profile-menu-action" onRun={action('account.open')}>Account &amp; AI settings <span aria-hidden="true">↗</span></Cmd>
        <Cmd dispatch={dispatch} cmd="account.refresh" class="profile-menu-action" disabled={account.status==='loading'} onRun={action('account.refresh')}>Refresh account</Cmd>
        <Cmd dispatch={dispatch} cmd="account.signOut" class="profile-menu-action profile-sign-out" onRun={action('account.signOut')}>Sign out</Cmd>
        <p>Local projects stay in this browser. Signing out keeps your saved projects.</p>
        <Cmd dispatch={dispatch} cmd="panel.toggle" args={{panel:'profile',open:false}} class="profile-close" label="Close profile">Close</Cmd>
      </div>
    </div>:null}
  </>;
}

const ELIGIBILITY:Record<string,string>={
  'review-required':'Free AI access needs an eligibility review.',eligible:'Your monthly free allowance is ready to claim in account settings.',
  claimed:'This month’s free allowance has been claimed.',revoked:'Free AI access needs a support review.',
  paid:'Your subscription includes its own AI allowance.',unavailable:'Free allowance status is temporarily unavailable.',
};

/** Only server-published amounts are shown; restoring/error states never invent a balance. */
export function HomeAccount({account,dispatch,onAccount,disabled=false}:{account:AccountState;dispatch:Dispatch;onAccount:()=>void;disabled?:boolean}) {
  const usage=account.status==='active'?account.profile?.usage:undefined;
  const free=account.profile?.freeAllowance;
  return <aside class="home-account" aria-label="Your account overview">
    <div class="home-account-heading"><span class="landing-eyebrow">YOUR FEM LAB ACCOUNT</span><span class="home-plan">{usage?usage.plan:account.status==='error'?'Needs refresh':'Refreshing'}</span></div>
    <div class="home-account-identity"><span class="profile-avatar" aria-hidden="true">{profileInitials(account.email)}</span><div><strong>{account.email??'Your account'}</strong><span>Signed in · local workspace</span></div></div>
    {usage?<>
      <p class="home-credit-label">AI credits available</p><div class="home-credit-value">{formatAiCredits(usage.availableCredits)}<span> / {formatAiCredits(usage.totalCredits)}</span></div>
      <meter aria-label="Available AI credits" aria-valuetext={`${formatAiCredits(usage.availableCredits)} available of ${formatAiCredits(usage.totalCredits)} AI credits`} min={0} max={100} value={usage.totalCredits>0?Math.min(100,Math.max(0,usage.availableCredits/usage.totalCredits*100)):0}/>
      <p class="home-credit-meta">{formatAiCredits(usage.reservedCredits)} reserved{usage.totalCredits>0?` · Ends ${new Date(usage.periodEndsAt).toLocaleDateString(undefined,{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'})} UTC`:''}</p>
      <p class="home-eligibility">{usage.plan!=='free'?ELIGIBILITY['paid']:ELIGIBILITY[free?.status??'unavailable']??ELIGIBILITY['unavailable']}</p>
    </>:<div class="home-account-pending" role="status"><strong>{account.status==='error'?'Could not refresh your account':'Loading your AI allowance…'}</strong><p>{account.status==='error'?'Open account settings to retry. Local modeling is ready without an AI allowance.':'Your identity is restored. Your balance will appear after the account request completes.'}</p></div>}
    <Cmd dispatch={dispatch} cmd="account.open" class="home-account-manage" disabled={disabled} onRun={onAccount}>Manage account &amp; AI <span aria-hidden="true">→</span></Cmd>
    <p class="home-local-note">Model, mesh and solve locally for free. AI use is optional.</p>
  </aside>;
}
