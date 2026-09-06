import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const lines = createInterface({input:process.stdin});
const send = x => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
const reply = (m,result) => send({id:m.id,result});
let prompt, sessionId, permission;
const update = value => send({method:'session/update',params:{sessionId,update:value}});
const chunk = text => update({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});
lines.on('line', line => {
  const m=JSON.parse(line);
  if (!m.method) {
    permission=m.result;
    chunk('permission: '+JSON.stringify(permission)); reply(prompt,{stopReason:'end_turn'}); prompt=undefined; return;
  }
  switch(m.method) {
    case 'initialize': reply(m,{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[{id:'cached_token'}],_meta:{agentVersion:'fixture',modelState:{currentModelId:'grok-fixture',availableModels:[{modelId:'other-model',name:'Other'}, {modelId:'grok-fixture',name:'Grok fixture',_meta:{reasoningEffort:'low',reasoningEfforts:[{id:'high'},{id:'low'}]}}]}}}); break;
    case 'authenticate': reply(m,{}); break;
    case 'session/new': sessionId=randomUUID(); reply(m,{sessionId,models:{currentModelId:'grok-fixture'}}); break;
    case 'session/load': sessionId=m.params.sessionId; chunk('REPLAY MUST NOT BE ADDED'); reply(m,{}); break;
    case 'session/prompt': {
      prompt=m; const text=m.params.prompt[0].text;
      appendFileSync(join(process.cwd(),'prompts.ndjson'),JSON.stringify({sessionId,text})+'\n');
      if (text==='crash') { process.exit(1); break; }
      if (text==='hang') break;
      if (text.startsWith('approve')) {
        chunk('before permission');
        const once=text!=='approve-always-only';
        send({id:99,method:'session/request_permission',params:{sessionId,toolCall:{toolCallId:'t',title:'Write fixture',rawInput:{path:'fixture.txt'}},options:[{kind:once?'allow_once':'allow_always',optionId:'allow'},{kind:'reject_once',optionId:'deny'}]}}); break;
      }
      if (text==='tools') {
        update({sessionUpdate:'tool_call',toolCallId:'tool',title:'Fixture command',status:'in_progress'});
        update({sessionUpdate:'tool_call_update',toolCallId:'tool',status:'completed',content:[{type:'content',content:{type:'text',text:'output'}}]});
      }
      const value=text==='large'?'中文🙂'.repeat(100000):'hello 世界';
      chunk(value.slice(0,5)); chunk(value.slice(5)); reply(m,{stopReason:'end_turn'}); prompt=undefined; break;
    }
    case 'session/cancel': if(prompt) { reply(prompt,{stopReason:'cancelled'}); prompt=undefined; } break;
    default: send({id:m.id,error:{code:-32601,message:'Method not found'}});
  }
});
