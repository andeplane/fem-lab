import {useEffect,useRef,useState} from 'preact/hooks';
import type {PurchaseUse} from '@femlab/registry';
import type {UiState} from '../store';
import {Cmd,type Dispatch} from './cmd';
import {useDialogFocus} from './Dialog';
const PLANS=[{id:'plus',name:'Plus',price:49,credits:4_000_000},{id:'pro',name:'Pro',price:149,credits:16_000_000},{id:'studio',name:'Studio',price:499,credits:50_000_000}] as const;
export function AccountPanel({s,dispatch}:{s:UiState;dispatch:Dispatch}) {
  const [email,setEmail]=useState(''),[confirmation,setConfirmation]=useState('');
  const ref=useRef<HTMLDivElement>(null),a=s.account;
  const usage=a.profile?.usage,billing=a.profile?.billing,hasPaidPlan=Boolean(usage&&usage.plan!=='free');
  const [purchaseUse,setPurchaseUse]=useState<PurchaseUse|''>('');
  useEffect(()=>setPurchaseUse(''),[a.uid,hasPaidPlan]);
  useDialogFocus(Boolean(s.panels['account']),ref);
  if(!s.panels['account'])return null;
  return <div class="overlay wide"><div ref={ref} class="account-panel" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="account-title">
    <div class="account-heading"><div><span class="eyebrow">FEM LAB ACCOUNT</span><h2 id="account-title">{a.uid?'Your AI allowance':'Sign in for AI'}</h2></div><Cmd dispatch={dispatch} cmd="panel.toggle" args={{panel:'account',open:false}} class="tbutton" label="Close account">×</Cmd></div>
    <p>Model, mesh and solve without signing in. Free Assistant previews are invitation-only during launch. Approved preview credits do not reset automatically.</p>
    {!a.configured?<p role="status">Hosted accounts are not configured in this build.</p>:!a.uid?<div class="account-login">
      <label>Email<input type="email" value={email} autoComplete="email" placeholder="you@example.com" onInput={e=>setEmail(e.currentTarget.value)} /></label>
      <Cmd dispatch={dispatch} cmd="account.signIn" args={{method:'email',email}} class="tbutton outline" disabled={!email.includes('@')}>{a.emailLinkPending?'Complete sign-in':'Send sign-in link'}</Cmd>
      {a.googleEnabled?<Cmd dispatch={dispatch} cmd="account.signIn" args={{method:'google'}} class="tbutton">Continue with Google</Cmd>:null}
      <small>A password is not required. Open the email link in this browser.</small>
    </div>:<>
      <div class="account-identity"><span>{a.email}</span><Cmd dispatch={dispatch} cmd="account.refresh" class="tbutton">Refresh</Cmd><Cmd dispatch={dispatch} cmd="account.signOut" class="tbutton">Sign out</Cmd></div>
      {usage?<div class="account-balance"><span class="eyebrow">{usage.plan.toUpperCase()} · AI CREDITS</span><strong>{usage.availableCredits.toLocaleString()}</strong><span>available of {usage.totalCredits.toLocaleString()} · {usage.reservedCredits.toLocaleString()} reserved</span>{usage.totalCredits>0?<small>Current allowance ends {new Date(usage.periodEndsAt).toLocaleDateString()}. Credits do not roll over.</small>:null}</div>:<p>Loading your allowance…</p>}
      <p class="account-credit-note">Credits account for model cost: output and larger models use more credits. The service checks your remaining allowance before each request.</p>
      {!hasPaidPlan?<div class="account-purchase-use"><label>Subscription use<select value={purchaseUse} onChange={e=>setPurchaseUse(e.currentTarget.value as PurchaseUse|'')} aria-describedby="purchase-use-note"><option value="">Choose personal or business use</option><option value="personal">Personal use</option><option value="business">Business use</option></select></label><small id="purchase-use-note">Choose how you will use your subscription. This choice stays the same for this subscription.</small></div>:null}
      <div class="account-plans">{PLANS.map(p=><div key={p.id} class="account-plan"><h3>{p.name}</h3><strong>${p.price}<small> USD / month</small></strong><p>{p.credits.toLocaleString()} AI credits / paid period</p><Cmd dispatch={dispatch} cmd={hasPaidPlan?'account.changePlan':'account.checkout'} args={hasPaidPlan?{plan:p.id}:{plan:p.id,purchaseUse}} class="tbutton outline" disabled={!billing?.available||usage?.plan===p.id||billing.reviewRequired||(!hasPaidPlan&&!purchaseUse)}>{usage?.plan===p.id?'Current plan':hasPaidPlan?'Change next period':'Choose plan'}</Cmd></div>)}</div>
      {!billing?.available?<p role="status">New purchases and plan changes are currently unavailable.</p>:null}
      {billing?.canManage?<Cmd dispatch={dispatch} cmd="account.portal" class="tbutton">Manage subscription and payment</Cmd>:null}
      {usage?.plan==='free'&&usage.totalCredits===0?<p role="status">A free AI preview requires an invitation. Contact <a href="mailto:andershaf@gmail.com">FEM Lab support</a> to request one.</p>:null}
      {billing?.scheduledPlan?<p>Plan change scheduled for {new Date(billing.scheduledPlan.effectiveAt).toLocaleDateString()}{billing.scheduledPlan.processing?' (processing)':''}.</p>:null}
      {billing?.cancelAtPeriodEnd?<p>Your subscription ends at the end of the current paid period.</p>:null}
      {billing?.reviewRequired?<p>Paid AI access is under billing review. Contact support before making another purchase.</p>:null}
      <Cmd dispatch={dispatch} cmd="panel.toggle" args={{panel:'account.data'}} class="tbutton" expanded={Boolean(s.panels['account.data'])}>Account data and deletion</Cmd>{s.panels['account.data']?<div class="account-data"><p>Models and conversations stay in your browser. Account records include usage and payment references. Required financial records may be retained after deletion.</p><Cmd dispatch={dispatch} cmd="account.export" class="tbutton">Export account records</Cmd><label>Type DELETE to request account deletion<input value={confirmation} onInput={e=>setConfirmation(e.currentTarget.value)} autoComplete="off" /></label><Cmd dispatch={dispatch} cmd="account.delete" args={{confirm:'DELETE'}} disabled={confirmation!=='DELETE'} class="tbutton">Delete account and cancel renewal</Cmd></div>:null}
    </>}
    {a.status==='loading'?<p role="status">Connecting to your account…</p>:null}{a.message?<p role="status">{a.message}</p>:null}{a.error?<p class="error" role="alert">{a.error}</p>:null}
    <nav class="account-policies" aria-label="Account policies"><a href={`${import.meta.env.BASE_URL}terms.html`} target="_blank" rel="noreferrer">Terms of service</a><a href={`${import.meta.env.BASE_URL}privacy.html`} target="_blank" rel="noreferrer">Privacy notice</a><a href="mailto:andershaf@gmail.com">Contact support</a></nav>
  </div></div>;
}
