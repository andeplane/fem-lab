import {useRef,useState} from 'preact/hooks';
import type {UiState} from '../store';
import {Cmd,type Dispatch} from './cmd';
import {useDialogFocus} from './Dialog';
const PLANS=[{id:'plus',name:'Plus',price:49,credits:4_000_000},{id:'pro',name:'Pro',price:149,credits:16_000_000},{id:'studio',name:'Studio',price:499,credits:50_000_000}] as const;
export function AccountPanel({s,dispatch}:{s:UiState;dispatch:Dispatch}) {
  const [email,setEmail]=useState(''),[confirmation,setConfirmation]=useState('');
  const ref=useRef<HTMLDivElement>(null),a=s.account;
  useDialogFocus(Boolean(s.panels['account']),ref);
  if(!s.panels['account'])return null;
  const usage=a.profile?.usage,billing=a.profile?.billing;
  return <div class="overlay wide"><div ref={ref} class="account-panel" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="account-title">
    <div class="account-heading"><div><span class="eyebrow">FEM LAB ACCOUNT</span><h2 id="account-title">{a.uid?'Your AI allowance':'Sign in for AI'}</h2></div><Cmd dispatch={dispatch} cmd="panel.toggle" args={{panel:'account',open:false}} class="tbutton" label="Close account">×</Cmd></div>
    <p>Model, mesh and solve without signing in. An account gives you a small free Assistant allowance, refreshed each calendar month.</p>
    {!a.configured?<p role="status">Hosted accounts are not configured in this build.</p>:!a.uid?<div class="account-login">
      <label>Email<input type="email" value={email} autoComplete="email" placeholder="you@example.com" onInput={e=>setEmail(e.currentTarget.value)} /></label>
      <Cmd dispatch={dispatch} cmd="account.signIn" args={{method:'email',email}} class="tbutton outline" disabled={!email.includes('@')}>{a.emailLinkPending?'Complete sign-in':'Send sign-in link'}</Cmd>
      {a.googleEnabled?<Cmd dispatch={dispatch} cmd="account.signIn" args={{method:'google'}} class="tbutton">Continue with Google</Cmd>:null}
      <small>A password is not required. Open the email link in this browser.</small>
    </div>:<>
      <div class="account-identity"><span>{a.email}</span><Cmd dispatch={dispatch} cmd="account.refresh" class="tbutton">Refresh</Cmd><Cmd dispatch={dispatch} cmd="account.signOut" class="tbutton">Sign out</Cmd></div>
      {usage?<div class="account-balance"><span class="eyebrow">{usage.plan.toUpperCase()} · AI CREDITS</span><strong>{usage.availableCredits.toLocaleString()}</strong><span>available of {usage.totalCredits.toLocaleString()} · {usage.reservedCredits.toLocaleString()} reserved</span><small>Current allowance ends {new Date(usage.periodEndsAt).toLocaleDateString()}. Credits do not roll over.</small></div>:<p>Loading your allowance…</p>}
      <p class="account-credit-note">Credits account for model cost: output and larger models use more credits. The service checks your remaining allowance before each request.</p>
      <div class="account-plans">{PLANS.map(p=><div key={p.id} class="account-plan"><h3>{p.name}</h3><strong>${p.price}<small> USD / month</small></strong><p>{p.credits.toLocaleString()} AI credits / paid period</p><Cmd dispatch={dispatch} cmd={usage&&usage.plan!=='free'?'account.changePlan':'account.checkout'} args={{plan:p.id}} class="tbutton outline" disabled={!billing?.available||usage?.plan===p.id||billing.reviewRequired}>{usage?.plan===p.id?'Current plan':usage&&usage.plan!=='free'?'Change next period':'Choose plan'}</Cmd></div>)}</div>
      {!billing?.available?<p role="status">Paid plans are not available yet. Your free AI allowance is available.</p>:<Cmd dispatch={dispatch} cmd="account.portal" class="tbutton">Manage subscription and payment</Cmd>}
      {billing?.scheduledPlan?<p>Plan change scheduled for {new Date(billing.scheduledPlan.effectiveAt).toLocaleDateString()}{billing.scheduledPlan.processing?' (processing)':''}.</p>:null}
      {billing?.cancelAtPeriodEnd?<p>Your subscription ends at the end of the current paid period.</p>:null}
      {billing?.reviewRequired?<p>Paid AI access is under billing review. Contact support before making another purchase.</p>:null}
      <details><summary>Account data and deletion</summary><p>Models and conversations stay in your browser. Account records include usage and payment references. Required financial records may be retained after deletion.</p><Cmd dispatch={dispatch} cmd="account.export" class="tbutton">Export account records</Cmd><label>Type DELETE to request account deletion<input value={confirmation} onInput={e=>setConfirmation(e.currentTarget.value)} autoComplete="off" /></label><Cmd dispatch={dispatch} cmd="account.delete" args={{confirm:'DELETE'}} disabled={confirmation!=='DELETE'} class="tbutton">Delete account and cancel renewal</Cmd></details>
    </>}
    {a.status==='loading'?<p role="status">Connecting to your account…</p>:null}{a.message?<p role="status">{a.message}</p>:null}{a.error?<p class="error" role="alert">{a.error}</p>:null}
  </div></div>;
}
