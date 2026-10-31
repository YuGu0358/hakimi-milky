import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,rmSync} from 'node:fs';
import {taskHash,purchasePayload,createPaidAdapter,confirmedState,USDM,sampleOf,fullTextHeldBack} from './paid-task.mjs';
const registration={walletId:'seller-wallet',agentIdentifier:'a'.repeat(80),supportedPaymentSourceIndex:0};
const target={coworkerId:'coworker',organizationId:null};
const task={id:'task',coworkerId:'coworker',organizationId:null};
const core={get:async()=>({data:task})};
const payment={sellerReturnAddress:null,forceLayer:null,PaymentSource:{network:'Preprod',paymentSourceType:'Web3CardanoV2',smartContractAddress:'addr_test1contract',policyId:'a'.repeat(56)},SmartContractWallet:{id:'seller-wallet',walletVkey:'b'.repeat(56)},RequestedFunds:[{amount:'1000000',unit:USDM}],agentIdentifier:registration.agentIdentifier,blockchainIdentifier:'signed',inputHash:taskHash('abc'),payByTime:String(Date.now()+100000),submitResultTime:String(Date.now()+200000),unlockTime:'9999999999999',externalDisputeUnlockTime:'9999999999999'};
test('Task compatibility hashes exact UTF-8 bytes without JSON escapes or nonce',()=>{
 assert.equal(taskHash('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
 assert.notEqual(taskHash('a\nb'),taskHash('a\\nb'));
});
test('signed fields preserved and unsupported signed override rejected',()=>{
 const payload=purchasePayload(payment,'01020304050607',registration);
 assert.equal(payload.blockchainIdentifier,payment.blockchainIdentifier);
 assert.equal(payload.unlockTime,payment.unlockTime);
 assert.throws(()=>purchasePayload({...payment,forceLayer:'L1'},'nonce',registration),/cannot preserve/);
 assert.throws(()=>purchasePayload({...payment,sellerReturnAddress:'addr_test1seller'},'nonce',registration),/cannot preserve/);
 assert.throws(()=>purchasePayload({...payment,SmartContractWallet:{id:'other'}},'nonce',registration),/differs/);
});
test('uncertain purchase never reposted',async()=>{
 let posts=0;const adapter=await createPaidAdapter({target,registration,save:async()=>{},answer:async()=>{throw Error('unexpected model')},core:{...core,post:async()=>{posts++;throw Error('timeout')}}});
 await assert.rejects(()=>adapter.advance(task,{input:'abc',paid:{stage:'purchase-pending'}}),/automatic retry disabled/);
 assert.equal(posts,0);
});
test('unconfirmed escrow does not invoke model',async()=>{
 let sends=0;const adapter=await createPaidAdapter({target,core,registration,save:async()=>{},answer:async()=>{sends++;},mps:async()=>({...payment,onChainState:'FundsLocked',CurrentTransaction:{status:'Pending'}})});
 const state=await adapter.advance(task,{input:'abc',paid:{stage:'awaiting-escrow',payment}});
 assert.equal(sends,0);assert.equal(state.paid.stage,'awaiting-escrow');
});
test('expired deadline prevents model after confirmed read and tells the owner',async()=>{
 let sends=0;const expired={...payment,submitResultTime:'1'};const posts=[];
 const adapter=await createPaidAdapter({target,core:{...core,post:async(_,body)=>{posts.push(body);return {data:{id:'event'}}}},registration,save:async()=>{},answer:async()=>{sends++;},mps:async()=>({...expired,onChainState:'FundsLocked',CurrentTransaction:{status:'Confirmed',newOnChainState:'FundsLocked'}})});
 const state=await adapter.advance(task,{input:'abc',paid:{stage:'awaiting-escrow',payment:expired}});
 assert.equal(state.paid.stage,'job-failed');assert.equal(sends,0);assert.equal(posts.length,1);
});

const resumable=(fn)=>Object.assign(fn,{canResume:true});
const finalError=(message)=>Object.assign(new Error(message),{isFinal:true});
const running={...payment,submitResultTime:String(Date.now()+60000)};
const coreCounting=()=>{const posts=[];return {posts,core:{...core,post:async(_,body)=>{posts.push(body);return {data:{id:'event'}}}}}};
test('a resumable answer is called again after a crash in model-pending',async(t)=>{
 mkdirSync('.local',{recursive:true});
 t.after(()=>rmSync('.local/task.txt',{force:true}));
 let sends=0;const adapter=await createPaidAdapter({target,core,registration,save:async()=>{},answer:resumable(async(_,__,deadline,taskId)=>{sends++;assert.equal(taskId,'task');assert.equal(deadline,Number(running.submitResultTime));return 'done'})});
 const state=await adapter.advance(task,{input:'abc',paid:{stage:'model-pending',payment:running}});
 assert.equal(sends,1);assert.equal(state.paid.stage,'result-saved');assert.equal(state.paid.resultHash,taskHash('done'));
});
test('an answer that cannot resume stays uncertain in model-pending',async()=>{
 let sends=0;const adapter=await createPaidAdapter({target,core,registration,save:async()=>{},answer:async()=>{sends++;return 'done'}});
 await assert.rejects(()=>adapter.advance(task,{input:'abc',paid:{stage:'model-pending',payment:running}}),/automatic retry disabled/);
 assert.equal(sends,0);
});
test('a final failure submits nothing, tells the owner once and stops',async()=>{
 const {core,posts}=coreCounting();let sends=0;
 const adapter=await createPaidAdapter({target,core,registration,save:async()=>{},answer:resumable(async()=>{sends++;throw finalError('nobody could do it.')}),mps:async()=>{throw Error('unexpected payment call')}});
 const state=await adapter.advance(task,{input:'abc',paid:{stage:'model-pending',payment:running}});
 assert.equal(state.paid.stage,'job-failed');assert.equal(state.paid.resultHash,undefined);
 assert.equal(posts.length,1);assert.match(posts[0].comment,/nobody could do it/);assert.equal(posts[0].status,undefined);
 const again=await adapter.advance(task,state);
 assert.equal(again,state);assert.equal(sends,1);assert.equal(posts.length,1);
});
test('a failed job whose message did not get through tries again',async()=>{
 const {core,posts}=coreCounting();
 const adapter=await createPaidAdapter({target,core,registration,save:async()=>{},answer:resumable(async()=>{throw Error('unexpected')})});
 const state=await adapter.advance(task,{input:'abc',paid:{stage:'job-failed',failure:'gone.',payment:running}});
 assert.equal(posts.length,1);assert.equal(state.paid.ownerTold,true);
});
test('a trouble that may pass leaves the task where it can be tried again',async()=>{
 const adapter=await createPaidAdapter({target,core,registration,save:async()=>{},answer:resumable(async()=>{throw Error('service is down')})});
 const state={input:'abc',paid:{stage:'model-pending',payment:running}};
 await assert.rejects(()=>adapter.advance(task,state),/service is down/);
 assert.equal(state.paid.stage,'model-pending');
});
test('a resumed job past its deadline fails for good without calling the answer',async()=>{
 const {core,posts}=coreCounting();let sends=0;
 const adapter=await createPaidAdapter({target,core,registration,save:async()=>{},answer:resumable(async()=>{sends++;return 'late'})});
 const state=await adapter.advance(task,{input:'abc',paid:{stage:'model-pending',payment:{...payment,submitResultTime:'1'}}});
 assert.equal(state.paid.stage,'job-failed');assert.equal(sends,0);assert.equal(posts.length,1);
});
test('an answer that comes back after the deadline is not submitted',async()=>{
 const {core,posts}=coreCounting();
 const soon={...payment,submitResultTime:String(Date.now()+20)};
 const adapter=await createPaidAdapter({target,core,registration,save:async()=>{},answer:resumable(async()=>{await new Promise(resolve=>setTimeout(resolve,40));return 'late'}),mps:async()=>{throw Error('unexpected payment call')}});
 const state=await adapter.advance(task,{input:'abc',paid:{stage:'model-pending',payment:soon}});
 assert.equal(state.paid.stage,'job-failed');assert.equal(state.paid.result,undefined);assert.equal(posts.length,1);
});
test('a saved result past its deadline is not submitted',async()=>{
 const {core,posts}=coreCounting();let submits=0;
 const adapter=await createPaidAdapter({target,core,registration,save:async()=>{},answer:resumable(async()=>'unused'),mps:async()=>{submits++;return {}}});
 const state=await adapter.advance(task,{input:'abc',paid:{stage:'result-saved',result:'late',resultHash:taskHash('late'),payment:{...payment,submitResultTime:'1'}}});
 assert.equal(state.paid.stage,'job-failed');assert.equal(submits,0);assert.equal(posts.length,1);
});
test('a message that keeps failing is tried a few times, then left alone',async()=>{
 let posts=0;const saved=[];
 const failing={...core,post:async()=>{posts++;throw Error('HTTP 400')}};
 const adapter=await createPaidAdapter({target,core:failing,registration,save:async(_,s)=>{saved.push(s)},answer:resumable(async()=>{throw Error('unexpected')})});
 let state={input:'abc',paid:{stage:'job-failed',failure:'gone',payment:running}};
 for(let round=0;round<6;round++){
  await adapter.advance(task,state).catch(()=>{});
  state=saved.at(-1)??state;
 }
 assert.equal(posts,3);
});
test('confirmed history proves lock when CurrentTransaction is absent',()=>{
 assert.equal(confirmedState({CurrentTransaction:null,TransactionHistory:[{status:'Confirmed',newOnChainState:'FundsLocked'}]},'FundsLocked'),true);
 assert.equal(confirmedState({CurrentTransaction:null,TransactionHistory:[{status:'Confirmed',newOnChainState:'ResultSubmitted'}]},'FundsLocked'),false);
});
test('successful quote survives later payload rejection',async()=>{
 let saved; const adapter=await createPaidAdapter({target,core,registration,save:async(_,s)=>{saved=s},answer:async()=>{},mps:async()=>({...payment,forceLayer:'L1'})});
 const state=await adapter.advance(task,{input:'abc'});
 assert.equal(saved.paid.payment.blockchainIdentifier,'signed');
 assert.equal(state.paid.stage,'terms-saved');
 await assert.rejects(()=>adapter.advance(task,state),/cannot preserve/);
});

test('running MPS legacy response without unsigned forceLayer is supported',()=>{const older={...payment};delete older.forceLayer;assert.equal(purchasePayload(older,'nonce',registration).blockchainIdentifier,'signed');});

test('unrelated confirmed transaction cannot prove escrow',()=>{assert.equal(confirmedState({CurrentTransaction:{status:'Confirmed',newOnChainState:'Withdrawn'}},'FundsLocked'),false)});

test('paid execution rejects another Workspace or Coworker before any saved state or payment write',async()=>{
 let writes=0;
 const target={coworkerId:'event-coworker',organizationId:'event-organization'};
 const adapter=await createPaidAdapter({target,registration,save:async()=>{writes++;},answer:async()=>{},mps:async()=>{writes++;return payment;}});
 for(const task of [
  {id:'task',coworkerId:'event-coworker',organizationId:null},
  {id:'task',coworkerId:'event-coworker',organizationId:'other-organization'},
  {id:'task',coworkerId:'other-coworker',organizationId:'event-organization'},
 ])await assert.rejects(adapter.advance(task,{input:'abc'}),/configured Coworker and Workspace/);
 assert.equal(writes,0);
});

const asked=(state='Disputed',requestedAction='WaitingForExternalAction')=>({...payment,onChainState:state,NextAction:{requestedAction}});
function refundWorld({observed=asked(),decision='person',answerOfPerson=null}){
 const calls=[];const{core,posts}=coreCounting();let reviews=0;
 const mps=async(path,body)=>{calls.push({path,body});return path.includes('resolve')?observed:{};};
 const made=createPaidAdapter({target,core,registration,save:async()=>{},answer:async()=>{throw Error('unexpected model')},mps,refundAnswer:()=>answerOfPerson,reviewRefund:async()=>{reviews+=1;return{decision,reason:'because'};}});
 return{made,posts,authorized:()=>calls.filter(({path})=>path.endsWith('authorize-refund')).length,reviews:()=>reviews};
}
const delivered={input:'abc',phase:'completed',paid:{stage:'awaiting-withdrawal',payment,resultHash:'h'}};
test('Jev agrees to a refund: the front desk authorizes it once and tells nobody to wait',async()=>{
 const w=refundWorld({decision:'refund'});const adapter=await w.made;
 const state=await adapter.advance(task,delivered);
 assert.equal(w.authorized(),1);assert.equal(state.paid.refund.authorized,true);assert.equal(w.posts.length,0);
 await adapter.advance(task,state);
 assert.equal(w.authorized(),1);assert.equal(w.reviews(),1);
});
test('Jev does not agree: nothing is authorized and the owner hears a person will review it, once',async()=>{
 const w=refundWorld({});const adapter=await w.made;
 const state=await adapter.advance(task,delivered);
 assert.equal(w.authorized(),0);assert.equal(w.posts.length,1);assert.match(w.posts[0].comment,/person will review/);
 await adapter.advance(task,state);
 assert.equal(w.posts.length,1);assert.equal(w.reviews(),1);
});
test('a person approves what Jev did not: the refund is authorized',async()=>{
 const w=refundWorld({answerOfPerson:'approve'});const adapter=await w.made;
 const state=await adapter.advance(task,delivered);
 assert.equal(w.authorized(),1);assert.equal(state.paid.refund.authorized,true);
});
test('a person keeps the payment: nothing is authorized and the owner is told why',async()=>{
 const w=refundWorld({answerOfPerson:'keep'});const adapter=await w.made;
 await adapter.advance(task,delivered);
 assert.equal(w.authorized(),0);assert.equal(w.posts.length,2);assert.match(w.posts[1].comment,/did not agree/);
});
test('another transaction in flight: the authorization waits for the next look',async()=>{
 const w=refundWorld({decision:'refund',observed:asked('Disputed','WithdrawInitiated')});const adapter=await w.made;
 await adapter.advance(task,delivered);
 assert.equal(w.authorized(),0);
});
test('a request before the result is treated the same way',async()=>{
 const w=refundWorld({decision:'refund',observed:asked('RefundRequested')});const adapter=await w.made;
 const state=await adapter.advance(task,{input:'abc',paid:{stage:'awaiting-escrow',payment}});
 assert.equal(w.authorized(),1);assert.equal(state.paid.refund.authorized,true);
});
test('money back ends the task watching it',async()=>{
 const w=refundWorld({observed:asked('RefundWithdrawn')});const adapter=await w.made;
 const state=await adapter.advance(task,delivered);
 assert.equal(state.paid.stage,'refunded');assert.equal(w.reviews(),0);
 assert.equal(await adapter.advance(task,state),state);
});

const FULL_TEXT='full text of the work. '.repeat(100);
const stagedPaid={stage:'complete-ready',staged:true,payment,result:FULL_TEXT,resultHash:taskHash(FULL_TEXT)};
const settledPayment={onChainState:'Withdrawn',blockchainIdentifier:payment.blockchainIdentifier,CurrentTransaction:{status:'Confirmed',newOnChainState:'Withdrawn',txHash:'tx'}};
const sellerRegistration={...registration,registration:{SmartContractWallet:{walletAddress:'addr_seller'}}};
function settledWorld(t,{settled=true,post}={}){
 const posts=[];
 const world={...core,get:async(path)=>path.endsWith('/receipt')?{data:{settled,txHash:'tx',blockchainIdentifier:payment.blockchainIdentifier}}:{data:task},post:post??(async(_,body)=>{posts.push(body);return {data:{id:'event'}}})};
 t.mock.method(globalThis,'fetch',async()=>({ok:true,json:async()=>({inputs:[],outputs:[{address:'addr_seller',amount:[{unit:USDM,quantity:'1000000'}]}]})}));
 return {posts,made:createPaidAdapter({target,core:world,registration:sellerRegistration,save:async()=>{},answer:async()=>{throw Error('unexpected model')},mps:async()=>settledPayment})};
}
test('a sample is a small part of the work and never the whole of a short result',()=>{
 assert.ok(FULL_TEXT.startsWith(sampleOf(FULL_TEXT)));
 assert.ok(sampleOf(FULL_TEXT).length<=400);
 assert.equal(sampleOf('short answer').length,2);
 assert.equal(sampleOf('好'.repeat(100)),'好'.repeat(20));
});
test('staged delivery completes the task with a sample and the hash, not the full text',async()=>{
 const {core,posts}=coreCounting();
 const adapter=await createPaidAdapter({target,core,registration,save:async()=>{},answer:async()=>{throw Error('unexpected model')},mps:async()=>{throw Error('unexpected payment call')}});
 const state=await adapter.advance(task,{input:'abc',paid:stagedPaid});
 assert.equal(posts.length,1);assert.equal(posts[0].status,'COMPLETED');
 assert.ok(!posts[0].comment.includes(FULL_TEXT));
 assert.ok(posts[0].comment.includes(sampleOf(FULL_TEXT)));
 assert.ok(posts[0].comment.includes(stagedPaid.resultHash));
 assert.equal(state.paid.stage,'awaiting-withdrawal');assert.equal(state.phase,'completed');
});
test('without staged delivery the full text goes out as before',async()=>{
 const {core,posts}=coreCounting();
 const adapter=await createPaidAdapter({target,core,registration,save:async()=>{},answer:async()=>{throw Error('unexpected model')}});
 await adapter.advance(task,{input:'abc',paid:{...stagedPaid,staged:undefined}});
 assert.equal(posts[0].comment,FULL_TEXT);
});
test('the full text goes out once, unchanged, after the seller is verifiably paid',async(t)=>{
 const w=settledWorld(t);const adapter=await w.made;
 let state=await adapter.advance(task,{input:'abc',phase:'completed',paid:{...stagedPaid,stage:'awaiting-withdrawal'}});
 assert.equal(state.paid.stage,'release-ready');assert.equal(w.posts.length,0);
 state=await adapter.advance(task,state);
 assert.equal(state.paid.stage,'settled');assert.equal(w.posts.length,1);
 assert.equal(w.posts[0].comment,FULL_TEXT);assert.equal(taskHash(w.posts[0].comment),stagedPaid.resultHash);
 assert.equal(await adapter.advance(task,state),state);assert.equal(w.posts.length,1);
});
test('an unverified settlement keeps the full text back',async(t)=>{
 const w=settledWorld(t,{settled:false});const adapter=await w.made;
 const state=await adapter.advance(task,{input:'abc',phase:'completed',paid:{...stagedPaid,stage:'awaiting-withdrawal'}});
 assert.equal(state.paid.stage,'awaiting-withdrawal');assert.equal(w.posts.length,0);
});
test('a failed release post stays ready to try again',async(t)=>{
 const w=settledWorld(t,{post:async()=>{throw Error('timeout')}});const adapter=await w.made;
 const state={input:'abc',phase:'completed',paid:{...stagedPaid,stage:'release-ready'}};
 await assert.rejects(()=>adapter.advance(task,state),/timeout/);
 assert.equal(state.paid.stage,'release-ready');
});
test('a refund request on a staged job never releases the full text',async()=>{
 const w=refundWorld({answerOfPerson:'keep'});const adapter=await w.made;
 await adapter.advance(task,{input:'abc',phase:'completed',paid:{...stagedPaid,stage:'awaiting-withdrawal'}});
 assert.ok(w.posts.every(({comment})=>!comment.includes(FULL_TEXT)));
 assert.match(w.posts[1].comment,/full text/);
});
test('the staged choice is told to the owner before payment and fixed for the job',async()=>{
 const body=[];const {core,posts}=coreCounting();
 const adapter=await createPaidAdapter({target,core,registration:{...registration,supportedPaymentSourceIndex:0},stagedDelivery:true,save:async()=>{},answer:async()=>{throw Error('unexpected model')},mps:async(_,b)=>{body.push(b);return {...payment,payByTime:String(Date.now()+60000)};}});
 let state=await adapter.advance(task,{input:'abc'});
 assert.equal(state.paid.staged,true);
 state=await adapter.advance(task,state);
 assert.match(posts[0].comment,/sample/);assert.match(posts[0].comment,/after the payment is released/);
});
test('comment replies wait while the full text is held back',()=>{
 assert.equal(fullTextHeldBack({paid:{staged:true,stage:'awaiting-withdrawal'}}),true);
 assert.equal(fullTextHeldBack({paid:{staged:true,stage:'settled'}}),false);
 assert.equal(fullTextHeldBack({paid:{stage:'awaiting-withdrawal'}}),false);
});
