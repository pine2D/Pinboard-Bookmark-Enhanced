// Exercise the opt-in runner with synthetic credentials only. No real services.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const dir=mkdtempSync(join(tmpdir(),'pbp-live-preflight-'));
const credentialsPath=join(dir,'synthetic-credentials.json');
const marker=join(dir,'credential-access');
const hook=join(dir,'guard.mjs');
const syntheticKey='synthetic-key-must-not-appear-in-output';
writeFileSync(credentialsPath,JSON.stringify({linkdingToken:syntheticKey}),{mode:0o600});
writeFileSync(hook,`import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
for (const name of ['readFileSync','lstatSync']) {
  const original=fs[name];
  fs[name]=function(path,...args) {
    if(String(path)===${JSON.stringify(credentialsPath)}) {
      fs.writeFileSync(${JSON.stringify(marker)},'attempted');
      throw new Error('credential_access_blocked');
    }
    return original.call(this,path,...args);
  };
}
syncBuiltinESMExports();
globalThis.fetch=()=>{throw new Error('network_access_blocked');};
`);
async function run(args,{guard=true}={}) {
  const child=spawn(process.execPath,[...(guard?['--import',hook]:[]),'scripts/bookmark-service-live.mjs',...args,'--credentials',credentialsPath],{cwd:root,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  assert(!output.includes(syntheticKey),'synthetic credential leaked to output');
  assert(!existsSync(marker),'preflight accessed the credential file');
  const reportPath=output.match(/Local report: (.+)/)?.[1];
  let report;
  if(reportPath){const raw=readFileSync(reportPath,'utf8');assert(!raw.includes(syntheticKey),'synthetic credential leaked to report');report=JSON.parse(raw);rmSync(reportPath);}
  return {code,output,report};
}
let server;
try {
  const plan=await run(['--plan','--service','linkding','--linkding','http://127.0.0.1:48100']);
  assert.equal(plan.code,0,'--plan must succeed without credential or network access');
  const value=JSON.parse(plan.output);
  assert.deepEqual(value.services,['linkding']);assert.equal(value.bookmarksPerService,2);
  assert.equal(value.credentialsRead,false);assert.equal(value.realRequests,0);
  const edges=await run(['--plan','--scenario','edges','--service','karakeep','--karakeep','http://127.0.0.1:3030']);
  assert.equal(edges.code,0);
  const edgePlan=JSON.parse(edges.output);
  assert.equal(edgePlan.scenario,'edges');assert.equal(edgePlan.bookmarksPerService,6);
  assert.equal(edgePlan.credentialsRead,false);assert.equal(edgePlan.realRequests,0);
  const unknown=await run(['--run','--scenario','unknown','--service','linkding','--linkding','http://127.0.0.1:48100']);
  assert.equal(unknown.code,1);assert.equal(unknown.report.failure.code,'scenario');
  for(const args of [['--help','--run'],[]]) {
    const result=await run(args);assert.equal(result.code,args.includes('--help')?0:2);
  }
  for(const base of ['https://example.com','http://127.0.0.1.evil.test','http://user:password@127.0.0.1:48100','http://127.0.0.1:48100/?key=x']) {
    const result=await run(['--run','--service','linkding','--linkding',base]);
    assert.equal(result.code,1);assert.equal(result.report.failure.code,'loopback_required');
  }
  const inference=await run(['--run','--service','karakeep','--karakeep','http://127.0.0.1:48101']);
  assert.equal(inference.code,1);assert.equal(inference.report.failure.code,'karakeep_auto_ai_not_confirmed_off');
  const requests=[];let allowAuthentication=false;
  server=createServer((req,res)=>{
    requests.push({url:req.url,method:req.method,authenticated:req.headers.authorization==='Token '+syntheticKey});
    let status=200,body;
    if(req.url==='/health')body={status:'healthy'};
    else if(!allowAuthentication||req.headers.authorization!=='Token '+syntheticKey){status=403;body={detail:syntheticKey};}
    else if(req.url==='/api/user/profile/')body={theme:'auto',enable_sharing:false,permanent_notes:false,version:'1.47.0'};
    else if(req.url.startsWith('/api/bookmarks/check/'))body={bookmark:null,metadata:{},auto_tags:[]};
    else if(req.url.startsWith('/api/tags/')||req.url.startsWith('/api/bookmarks/'))body={count:0,next:null,previous:null,results:[]};
    else {status=404;body={detail:'Unknown fixture route'};}
    res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const result=await run(['--run','--read-only','--service','linkding','--linkding','http://127.0.0.1:'+server.address().port],{guard:false});
  assert.equal(result.code,1);assert.equal(result.report.failure.code,'api_http_403');
  assert.deepEqual(requests,[{url:'/health',method:'GET',authenticated:false},{url:'/api/user/profile/',method:'GET',authenticated:true}]);
  allowAuthentication=true;requests.length=0;
  const success=await run(['--run','--read-only','--service','linkding','--linkding','http://127.0.0.1:'+server.address().port],{guard:false});
  assert.equal(success.code,0,success.output);assert.equal(success.report.passed,true);
  assert.deepEqual(success.report.created,[]);assert(requests.length>4);
  assert(requests.every(r=>r.method==='GET'&&(r.url==='/health'||r.authenticated)),'read-only browser path escaped authenticated GETs');
  console.log('bookmark live preflight: plan/help/invalid endpoint/AI gate/opaque authentication/isolated read-only browser passed');
} finally {
  if(server)await new Promise(resolve=>server.close(resolve));
  rmSync(dir,{recursive:true,force:true});
}
