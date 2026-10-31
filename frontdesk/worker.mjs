import {runCommand} from './sokosumi-cli.mjs';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseEnv} from 'node:util';
import {acquireWorkerLock} from './worker-lock.mjs';
import {answer,client} from './client.mjs';
import {reply} from './comments.mjs';
import {createPaidAdapter,fullTextHeldBack,isPaidReady} from './paid-task.mjs';
import {taskTarget,isTaskForTarget} from './task-target.mjs';
import {createFrontDesk} from '../orchestrator/front-desk.mjs';
import {createLiveParts,EVIDENCE_DIR} from '../orchestrator/live-parts.mjs';
import {createRefundReviewer} from '../orchestrator/refund-review.mjs';
import {refillBuyerKey} from '../payments/buyer-key.mjs';
const target=taskTarget();
const id=target.coworkerId;
const releaseLock=acquireWorkerLock();
process.once('exit',releaseLock);
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{releaseLock();process.exit(0)});
function cli(args){return JSON.parse(runCommand('sokosumi',['--preprod',...args,'--json'],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024}));}
await client.health();
// The owner's 1 test USDM pays for the task, so each paid task refills the orchestrator's limited key once.
const topUp=()=>refillBuyerKey({baseUrl:process.env.MPS_URL,adminKey:parseEnv(readFileSync('.local/mps.env','utf8')).ADMIN_KEY});
const desk=createFrontDesk({answerPlainly:answer,createParts:()=>createLiveParts(),topUp});
const evidenceOf=(taskId)=>{const path=join(EVIDENCE_DIR,`${taskId}-evidence.jsonl`);return existsSync(path)?readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map((line)=>JSON.parse(line)):[];};
const paid=await createPaidAdapter({target,answer:desk,reviewRefund:createRefundReviewer({readLines:evidenceOf}),save:async(taskId,state)=>writeFileSync(`.local/${taskId}.json`,JSON.stringify(state),{mode:0o600})});
console.log('Continuous worker running',process.pid);
while(true){
 try{
 const tasks=cli(['tasks','list','--coworker-id',id,...target.taskArgs]).tasks;
 for(const t of tasks.filter(t=>isTaskForTarget(t,target))){
 try{
 const journal=`.local/${t.id}.json`,resultFile=`.local/${t.id}.txt`;
 let state=existsSync(journal)?JSON.parse(readFileSync(journal,'utf8')):{};
 if(t.status==='READY'&&!state.phase){writeFileSync(journal,JSON.stringify({phase:'starting'}),{mode:0o600});const started=cli(['runtime','start',t.id,...target.runtimeArgs,'--coworker-id',id]);state={phase:'started',input:started.description};writeFileSync(journal,JSON.stringify(state),{mode:0o600});}
 if(state.paid&&process.env.PAID_TASKS_ENABLED!=='true')continue;
 if(state.paid||(state.phase==='started'&&process.env.PAID_TASKS_ENABLED==='true'&&isPaidReady())){state=await paid.advance(t,state);if(state.phase==='completed'&&!fullTextHeldBack(state))await reply(t);continue;}
 if(state.phase==='started'){
 writeFileSync(journal,JSON.stringify({...state,phase:'model-pending'}),{mode:0o600});
 const result=await answer(state.input,`.local/${t.id}-session.json`);
 writeFileSync(resultFile,result,{mode:0o600});state={...state,phase:'result-saved'};writeFileSync(journal,JSON.stringify(state),{mode:0o600});
 }
 if(state.phase==='result-saved'){
 writeFileSync(journal,JSON.stringify({...state,phase:'complete-pending'}),{mode:0o600});
 const completed=cli(['runtime','complete',t.id,...target.runtimeArgs,'--coworker-id',id,'--result-file',resultFile]);
 writeFileSync(journal,JSON.stringify({...state,phase:'completed',completion:completed}),{mode:0o600});console.log('Completed',t.id);
 }
 if(state.phase==='completed')await reply(t);
 }catch(e){console.error('Task blocked',t.id,e.message.slice(0,200))}
 }
 }catch(e){console.error('Polling read failed',e.message.slice(0,200))}
 await new Promise(r=>setTimeout(r,5000));
}
