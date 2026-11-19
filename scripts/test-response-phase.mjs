import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yunhui-phase-'));
const file=path.join(dir,'phase.cjs');
await build({entryPoints:['src/core/gateway/responsePhase.ts'],bundle:true,platform:'node',format:'cjs',outfile:file,logLevel:'silent'});
const {ResponsePhaseStream,fillResponsePhases}=createRequire(import.meta.url)(file);
const event=v=>'event: '+v.type+'\ndata: '+JSON.stringify(v)+'\n\n';
const message=phase=>({type:'response.output_item.done',item:{id:'msg-1',type:'message',role:'assistant',content:[{type:'output_text',text:'回答'}],...(phase?{phase}:{})}});
const completed=event({type:'response.completed',response:{status:'completed',output:[message().item]}});
let checks=0;const check=(name,fn)=>{fn();checks++;console.log('PASS',name);};
try{
check('Unphased final message is delayed until successful completion',()=>{const s=new ResponsePhaseStream();assert.equal(s.push(event(message())), '');const output=s.push(completed);assert.ok(output.indexOf('final_answer')<output.indexOf('response.completed'));assert.ok(output.includes('回答'));});
check('Tool calls make the preceding message commentary',()=>{const s=new ResponsePhaseStream();s.push(event(message()));const out=s.push(event({type:'response.output_item.added',item:{type:'custom_tool_call',input:'opaque'}}));assert.ok(out.includes('commentary'));assert.ok(out.includes('opaque'));});
check('Existing phases and opaque fields pass through unchanged',()=>{const s=new ResponsePhaseStream();const raw=event({...message('commentary'),extra:{encrypted:'untouched'}});assert.equal(s.push(raw),raw);});
check('Failed and interrupted responses do not invent a final answer',()=>{for(const type of ['response.failed','response.incomplete','error']){const s=new ResponsePhaseStream();const raw=event(message());s.push(raw);assert.equal(s.push(event({type})),raw+event({type}));}const s=new ResponsePhaseStream();const raw=event(message());s.push(raw);assert.equal(s.end(),raw);});
check('Fragmented SSE retains the completed message and terminal event',()=>{const s=new ResponsePhaseStream();const input=event(message())+completed;let out='';for(const ch of input)out+=s.push(ch);out+=s.end();assert.ok(out.includes('final_answer'));assert.ok(out.includes('response.completed'));});
check('A terminal sentinel keeps pending messages before DONE without inventing success',()=>{const s=new ResponsePhaseStream();const raw=event(message());assert.equal(s.push(raw),'');assert.equal(s.push('data: [DONE]\n\n'),raw+'data: [DONE]\n\n');assert.equal(s.end(),'');});
check('JSON response preserves known phases and marks only the final assistant item',()=>{const r=fillResponsePhases({status:'completed',output:[{...message().item,id:'early'},message().item]});assert.equal(r.output[0].phase,'commentary');assert.equal(r.output[1].phase,'final_answer');assert.equal(fillResponsePhases({status:'incomplete',output:[message().item]}).output[0].phase,undefined);});
console.log(`${checks} response phase checks passed.`);
}finally{fs.rmSync(dir,{recursive:true,force:true});}
