import {createHash,randomBytes} from 'node:crypto';
import {readFileSync,existsSync,writeFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {verifySettlement} from './settlement.mjs';
import {loadSokosumiRuntime} from './sokosumi-runtime.mjs';
import {taskTarget,assertTaskTarget,verifyRuntimeTask} from './task-target.mjs';
const MINUTE=60*1000;
const MAX_TELL_TRIES=3;
const REFUND_ASKED=['Disputed','RefundRequested'];
const savedRefundAnswer=(taskId)=>{const path=`.local/${taskId}-refund-answer.json`;return existsSync(path)?JSON.parse(readFileSync(path,'utf8')).answer:null;};
export const USDM='16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';
export function taskHash(text){return createHash('sha256').update(text,'utf8').digest('hex')}
export function confirmedState(payment,expected){
 return (payment.CurrentTransaction?.status==='Confirmed'&&payment.CurrentTransaction?.newOnChainState===expected)||payment.TransactionHistory?.some(tx=>tx.status==='Confirmed'&&tx.newOnChainState===expected)||false;
}
// Running MPS dist/app-DCTS_JYs.js:249079 signs no forceLayer field.
// Source differs from the loaded build. An absent field is valid for that build.
export function purchasePayload(payment,nonce,registration){
 if(payment.sellerReturnAddress!==null||(payment.forceLayer!==undefined&&payment.forceLayer!==null))throw new Error('Core Task events cannot preserve non-null signed sellerReturnAddress or forceLayer');
 if(payment.PaymentSource?.network!=='Preprod'||payment.PaymentSource?.paymentSourceType!=='Web3CardanoV2')throw new Error('Payment source is not Preprod Web3CardanoV2');
 if(payment.SmartContractWallet?.id!==registration.walletId)throw new Error('Payment wallet differs from dedicated seller wallet');
 if(payment.RequestedFunds.length!==1||payment.RequestedFunds[0].unit!==USDM||payment.RequestedFunds[0].amount!=='1000000')throw new Error('Signed quote differs from 1 test USDM');
 return {blockchainIdentifier:payment.blockchainIdentifier,agentIdentifier:payment.agentIdentifier,
 sellerVkey:payment.SmartContractWallet.walletVkey,submitResultTime:payment.submitResultTime,
 payByTime:payment.payByTime,unlockTime:payment.unlockTime,externalDisputeUnlockTime:payment.externalDisputeUnlockTime,
 inputHash:payment.inputHash,identifierFromPurchaser:nonce,paymentSourceType:'Web3CardanoV2',
 supportedPaymentSourceIndex:registration.supportedPaymentSourceIndex,
 Amounts:payment.RequestedFunds.map(({amount,unit})=>({amount,unit})),
 PaymentSource:{network:'Preprod',smartContractAddress:payment.PaymentSource.smartContractAddress,policyId:payment.PaymentSource.policyId}};
}
export function isPaidReady(){
 if(!existsSync('docs/registration-state.json')||!existsSync('.local/mps-runtime.env'))return false;
 const r=JSON.parse(readFileSync('docs/registration-state.json','utf8'));
 return r.status==='RegistrationConfirmed'||r.registrationState==='RegistrationConfirmed'||r.registration?.state==='RegistrationConfirmed';
}
export async function createPaidAdapter({save,answer,core:providedCore,mps:providedMps,registration:providedRegistration,target=taskTarget(),reviewRefund=async()=>({decision:'person',reason:'No reviewer is set up'}),refundAnswer=savedRefundAnswer}){
 const registration=()=>providedRegistration??JSON.parse(readFileSync('docs/registration-state.json','utf8'));
 let core=providedCore;
 async function getCore(){
  if(!core){const {readRuntimeCredential,createCoworkerHttpClient}=await loadSokosumiRuntime();
   core=createCoworkerHttpClient({apiKey:readRuntimeCredential(target.coworkerId)});}
  return core;
 }
 async function mps(path,body){
  if(providedMps)return providedMps(path,body);
  const env=parseEnv(readFileSync('.local/mps-runtime.env','utf8'));
  const response=await fetch(`${process.env.MPS_URL}${path}`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),
   headers:{'Content-Type':'application/json',token:env.MPS_RUNTIME_TOKEN},body:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok||data.status!=='success')throw new Error(`MPS ${path} failed HTTP ${response.status}. Inspect saved state before retry.`);
  return data.data;
 }
 async function persist(task,state,paid){const next={...state,paid};await save(task.id,next);return next;}
 async function tellOwner(task,state,p){
  const tellTries=(p.tellTries??0)+1;
  const next={...p,tellTries};
  state=await persist(task,state,next);
  await (await verifyRuntimeTask(await getCore(),task.id,target)).post(`/v1/tasks/${encodeURIComponent(task.id)}/events`,{comment:`This job could not be finished (${p.failure}). No result was submitted, so the seller cannot collect this payment.`});
  return persist(task,state,{...next,ownerTold:true});
 }
 async function failJob(task,state,p,failure){
  const next={...p,stage:'job-failed',failure};
  return tellOwner(task,await persist(task,state,next),next);
 }
 async function sayToOwner(task,state,p,field,comment){
  const tries=p.refund[`${field}Tries`]??0;
  if(p.refund[field]||tries>=MAX_TELL_TRIES)return p;
  const counted={...p,refund:{...p.refund,[`${field}Tries`]:tries+1}};
  await persist(task,state,counted);
  await (await verifyRuntimeTask(await getCore(),task.id,target)).post(`/v1/tasks/${encodeURIComponent(task.id)}/events`,{comment});
  return {...counted,refund:{...counted.refund,[field]:true}};
 }
 // The owner asked for the fee back. Jev reads our records first, and whatever it does not agree to goes to a person.
 async function handleRefund(task,state,p){
  if(p.refund?.authorized)return state;
  let current=p;
  if(!current.refund){
   const {decision,reason}=await reviewRefund({taskId:task.id,paid:current});
   console.log(`Refund request on ${task.id}: ${decision}. ${reason}`);
   current={...current,refund:{decision,reason}};
   state=await persist(task,state,current);
  }
  const person=refundAnswer(task.id);
  if(current.refund.decision!=='refund'&&person!=='approve'){
   current=await sayToOwner(task,state,current,'personTold','We received your refund request. A person will review it.');
   if(person==='keep')current=await sayToOwner(task,state,current,'keepTold','Our records show this work was delivered and passed its checks, so we did not agree to the refund. The payment stays in escrow until the dispute time.');
   return persist(task,state,current);
  }
  if(current.observed?.NextAction?.requestedAction!=='WaitingForExternalAction')return state;
  state=await persist(task,state,{...current,refund:{...current.refund,authorizePending:true}});
  await mps('/api/v1/payment/authorize-refund',{network:'Preprod',blockchainIdentifier:current.payment.blockchainIdentifier});
  return persist(task,state,{...current,refund:{...current.refund,authorized:true}});
 }
 const isLate=(p)=>Date.now()>=Number(p.payment.submitResultTime);
 const lateFailure='the result deadline passed before the work was done';
 async function produceResult(task,state,p){
  if(isLate(p))return failJob(task,state,p,lateFailure);
  let result;
  try{result=await answer(state.input,`.local/${task.id}-session.json`,Number(p.payment.submitResultTime),task.id);}
  catch(error){if(error.isFinal)return failJob(task,state,p,error.message);throw error;}
  if(isLate(p))return failJob(task,state,p,lateFailure);
  if(typeof result!=='string'||!result.trim())throw new Error('Model did not return a result');
  writeFileSync(`.local/${task.id}.txt`,result,{mode:0o600});
  return persist(task,state,{...p,stage:'result-saved',result,resultHash:taskHash(result)});
 }
 return {async advance(task,state){
  assertTaskTarget(task,target);
  await verifyRuntimeTask(await getCore(),task.id,target);
  let p=state.paid??{};const r=registration();
  if(!p.stage){
   if(!state.input?.trim())throw new Error('Paid Task requires authoritative started input');
   const nonce=randomBytes(10).toString('hex');const now=Date.now();
   const body={network:'Preprod',agentIdentifier:r.agentIdentifier,paymentSourceType:'Web3CardanoV2',supportedPaymentSourceIndex:r.supportedPaymentSourceIndex,
    inputHash:taskHash(state.input),identifierFromPurchaser:nonce,RequestedFunds:[{amount:'1000000',unit:USDM}],
    payByTime:new Date(now+10*MINUTE).toISOString(),submitResultTime:new Date(now+45*MINUTE).toISOString(),unlockTime:new Date(now+61*MINUTE).toISOString(),externalDisputeUnlockTime:new Date(now+77*MINUTE).toISOString(),metadata:JSON.stringify({taskId:task.id})};
   if(!body.agentIdentifier||!Number.isInteger(body.supportedPaymentSourceIndex))throw new Error('Registration identifier and source index are required');
   state=await persist(task,state,{stage:'terms-pending',nonce,request:body});
   const payment=await mps('/api/v1/payment',body);
   return persist(task,state,{...state.paid,stage:'terms-saved',payment});
  }
  if(p.stage==='terms-saved'){
   const payload=purchasePayload(p.payment,p.nonce,r);
   if(Date.now()>=Number(p.payment.payByTime))throw new Error('Signed payment deadline expired');
   state=await persist(task,state,{...p,payload,stage:'purchase-pending'});
   const response=await (await verifyRuntimeTask(await getCore(),task.id,target)).post(`/v1/tasks/${encodeURIComponent(task.id)}/events`,{comment:'Payment requested: 1 test USDM.',masumiPayment:payload});
   return persist(task,state,{...p,stage:'awaiting-escrow',eventId:response.data.id});
  }
  if(['awaiting-escrow','awaiting-result','awaiting-withdrawal'].includes(p.stage)){
   const observed=await mps('/api/v1/payment/resolve-blockchain-identifier',{network:'Preprod',blockchainIdentifier:p.payment.blockchainIdentifier,includeHistory:'true'});
   p={...p,observed};state=await persist(task,state,p);
   if(observed.onChainState==='RefundWithdrawn')return persist(task,state,{...p,stage:'refunded'});
   if(REFUND_ASKED.includes(observed.onChainState))return handleRefund(task,state,p);
   if(p.stage==='awaiting-escrow'){
    if(observed.onChainState!=='FundsLocked'||!confirmedState(observed,'FundsLocked'))return state;
    if(isLate(p))return failJob(task,state,p,lateFailure);
    state=await persist(task,state,{...p,stage:'model-pending'});
    return produceResult(task,state,{...p,stage:'model-pending'});
   }
   if(p.stage==='awaiting-result'&&observed.resultHash===p.resultHash&&confirmedState(observed,'ResultSubmitted')&&observed.onChainState==='ResultSubmitted')return persist(task,state,{...p,stage:'complete-ready'});
   if(p.stage==='awaiting-withdrawal'&&['Withdrawn','DisputedWithdrawn'].includes(observed.onChainState)){const evidence=await verifySettlement({core:await verifyRuntimeTask(await getCore(),task.id,target),taskId:task.id,payment:observed,sellerAddress:registration().registration?.SmartContractWallet?.walletAddress,unit:USDM});return persist(task,state,{...p,stage:evidence.verified?'settled':'awaiting-withdrawal',settlement:evidence});}
   return state;
  }
  if(p.stage==='result-saved'){
   if(isLate(p))return failJob(task,state,p,lateFailure);
   state=await persist(task,state,{...p,stage:'submit-pending'});
   await mps('/api/v1/payment/submit-result',{network:'Preprod',blockchainIdentifier:p.payment.blockchainIdentifier,submitResultHash:p.resultHash});
   return persist(task,state,{...p,stage:'awaiting-result'});
  }
  if(p.stage==='complete-ready'){
   state=await persist(task,state,{...p,stage:'complete-pending'});
   const response=await (await verifyRuntimeTask(await getCore(),task.id,target)).post(`/v1/tasks/${encodeURIComponent(task.id)}/events`,{status:'COMPLETED',comment:p.result});
   return persist(task,{...state,phase:'completed'},{...p,stage:'awaiting-withdrawal',completionEventId:response.data.id});
  }
  if(p.stage==='job-failed')return p.ownerTold||(p.tellTries??0)>=MAX_TELL_TRIES?state:tellOwner(task,state,p);
  // An answer that can resume keeps its own record of what it already did, so calling it again costs nothing twice.
  if(p.stage==='model-pending'&&answer.canResume)return produceResult(task,state,p);
  if(p.stage.endsWith('-pending'))throw new Error(`Uncertain ${p.stage}. Inspect prior operation before recovery; automatic retry disabled.`);
  return state;
 }};
}
