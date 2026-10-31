// Opt-in real-service acceptance. Never run by verify.sh. No AI, user profile,
// environment files, or existing bookmark mutations. See the local test guide.
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const args=process.argv.slice(2);
if(args.includes('--help')||(!args.includes('--run')&&!args.includes('--plan'))) {
  console.log('Opt-in: node scripts/bookmark-service-live.mjs --run --credentials /private/credentials.json --karakeep http://127.0.0.1:PORT --linkding http://127.0.0.1:PORT');
  console.log('Optional: --service karakeep|linkding; --read-only verifies Connect, tags and recent without remote writes.');
  console.log('--plan validates public arguments without accessing credentials, network or a browser.');
  console.log('Karakeep writes also require --confirm-karakeep-no-auto-ai, after verifying server automatic tagging and summarization are both disabled.');
  process.exit(args.includes('--help')?0:2);
}
const option=name=>args[args.indexOf(name)+1];
const root=fileURLToPath(new URL('../',import.meta.url));
const runId=randomUUID(),prefix='pbp-it-'+runId;
const services=args.includes('--service')?[option('--service')]:['linkding','karakeep'];
const report={runId,started:new Date().toISOString(),checks:[],created:[],lists:[],tags:[],cleanup:[],counts:{linkding:0,karakeep:0}};
const reportPath=join(tmpdir(),prefix+'.json');
const persist=()=>writeFileSync(reportPath,JSON.stringify(report,null,2),{mode:0o600});
const fail=code=>{throw new Error(code);};
const check=(condition,code)=>{if(!condition)fail(code);};
let phase='configuration',credentials={},ctx,worker,profile,failed=false;
const bases={},roots={},allowed={};
async function api(service,path,{method='GET',body,allow404=false,auth=true}={}) {
  const url=new URL(path,roots[service]);
  check(url.href.startsWith(auth?roots[service]:bases[service]),'api_origin');
  check(++report.counts[service]<=180,'node_request_budget');
  const response=await fetch(url,{method,redirect:'error',credentials:'omit',signal:AbortSignal.timeout(20000),
    headers:{Accept:'application/json',...(auth?{Authorization:(service==='linkding'?'Token ':'Bearer ')+credentials[service+'Token']}:{}),...(body?{'Content-Type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{})});
  if(allow404&&response.status===404)return null;
  check(response.ok,'api_http_'+response.status);
  if(response.status===204)return null;
  check((response.headers.get('content-type')||'').includes('json'),'api_not_json');
  return response.json();
}
async function until(read,label,timeout=20000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await read())return;await new Promise(r=>setTimeout(r,150));}
  fail('timeout_'+label);
}
const rowUrl=(service,row)=>service==='linkding'?row?.url:row?.content?.url;
const recordPath=(service,id)=>'bookmarks/'+encodeURIComponent(id)+(service==='linkding'?'/':'');
async function syncLedger() {
  if(!worker)return;
  const state=await worker.evaluate(()=>({created:globalThis.pbpLiveGuard.created,lists:globalThis.pbpLiveGuard.lists,counts:globalThis.pbpLiveGuard.counts}));
  report.created=state.created;report.lists=state.lists;report.browserCounts=state.counts;persist();
}
async function ownRow(service,url) {
  await syncLedger();const entry=report.created.find(r=>r.service===service&&r.url===url);
  check(entry,'created_id_missing');
  const row=await api(service,recordPath(service,entry.id));
  check(rowUrl(service,row)===url,'created_url_mismatch');
  const tags=service==='linkding'?[]:row.tags||[];
  for(const tag of tags)if(tag.name.startsWith(prefix)&&!report.tags.some(t=>t.service===service&&t.id===String(tag.id)))report.tags.push({service,id:String(tag.id),name:tag.name});
  persist();return row;
}
try {
  check(services.every(s=>['linkding','karakeep'].includes(s)),'service');
  for(const service of services) {
    check(args.includes('--'+service),'missing_base');const u=new URL(option('--'+service));
    check(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&!u.username&&!u.password&&!u.search&&!u.hash,'loopback_required');
    bases[service]=u.href.replace(/\/$/,'')+'/';roots[service]=bases[service]+(service==='linkding'?'api/':'api/v1/');
    allowed[service]=[1,2].map(n=>'https://example.com/?pbp-it='+runId+'-'+service+'-'+n);
  }
  if(args.includes('--plan')) {
    const plan={services,bases,credentialsRead:false,realRequests:0,bookmarksPerService:args.includes('--read-only')?0:2,nodeRequestsPerService:180,browserRequestsPerService:180,automaticRetries:0,extensionAi:false,karakeepWritesRequireAutoAiDisabled:true,cleanup:'only this run bookmarks, empty lists and unused tags',webRenderingVerified:false};
    await new Promise(resolve=>process.stdout.write(JSON.stringify(plan,null,2)+'\n',resolve));
    process.exit(0);
  }
  check(args.includes('--read-only')||!services.includes('karakeep')||args.includes('--confirm-karakeep-no-auto-ai'),'karakeep_auto_ai_not_confirmed_off');
  const path=option('--credentials');check(args.includes('--credentials')&&path,'credentials_path');
  const stat=lstatSync(path);check(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0,'credentials_permissions');
  credentials=JSON.parse(readFileSync(path,'utf8'));
  for(const service of services) {
    const token=credentials[service+'Token'];check(typeof token==='string'&&token.trim()&&!/[\r\n]/.test(token),'missing_'+service+'Token');
    phase=service+'_readonly';
    const health=await api(service,new URL(service==='linkding'?'health':'api/health',bases[service]).href,{auth:false});
    check(['ok','healthy'].includes(health.status),'health');
    await api(service,service==='linkding'?'user/profile/':'users/me');
    for(const url of allowed[service]) {
      const data=await api(service,(service==='linkding'?'bookmarks/check/':'bookmarks/check-url')+'?url='+encodeURIComponent(url));
      check(!(service==='linkding'?data.bookmark:data.bookmarkId),'fixture_already_exists');
    }
    report.checks.push(service+': health, authentication, unique URLs');console.log(service+': readonly preflight passed');
  }
  const {chromium}=createRequire(resolve(root,'.qa-scan/package.json'))('playwright');
  profile=mkdtempSync(join(tmpdir(),'pbp-live-profile-'));
  const launch=()=>chromium.launchPersistentContext(profile,{headless:true,executablePath:chromium.executablePath(),viewport:{width:1280,height:900},args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`,'--no-first-run','--disable-background-networking','--disable-component-update','--disable-sync','--no-pings','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']});
  const getWorker=async()=>ctx.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'))||ctx.waitForEvent('serviceworker');
  ctx=await launch();worker=await getWorker();const extId=new URL(worker.url()).hostname;
  await worker.evaluate(async()=>{await primeSettings();await chrome.storage.local.set({optSyncEnabled:false,optAiAutoTags:false,optAiAutoSummary:false,previewAiEnabled:false,optShowAiTags:false,optShowAiSummary:false,optAutoCloseAfterSave:false,optLang:'en',optCheckBookmarkStatus:false,waybackArchiveEnabled:false,optPrivateDefault:true,offlineQueueEnabled:false,aiTagSeparator:'_',optAutoDescription:true});});
  await ctx.close();ctx=null;worker=null;
  const prefsPath=join(profile,'Default','Preferences'),prefs=JSON.parse(readFileSync(prefsPath,'utf8'));
  for(const key of ['granted_permissions','active_permissions']) {
    const bucket=prefs.extensions.settings[extId][key] ||= {};const hosts=bucket.explicit_host ||= [];
    for(const base of Object.values(bases)){const pattern=new URL(base).origin+'/*';if(!hosts.includes(pattern))hosts.push(pattern);}
  }
  writeFileSync(prefsPath,JSON.stringify(prefs));ctx=await launch();worker=await getWorker();await worker.evaluate(()=>primeSettings());
  // Extra guard for this opt-in test: even a production bug cannot mutate an
  // existing bookmark or dispatch beyond the two authorized API roots.
  await worker.evaluate(({roots,allowed})=>{
    const original=globalThis.fetch;const state=globalThis.pbpLiveGuard={created:[],lists:[],counts:{linkding:0,karakeep:0}};
    globalThis.fetch=async(input,opts={})=>{
      const url=typeof input==='string'?input:input.url;
      if(url.startsWith('chrome-extension://'))return original(input,opts);
      const service=Object.keys(roots).find(s=>url.startsWith(roots[s]));
      if(!service)throw new Error('live_guard_origin');
      if(++state.counts[service]>180)throw new Error('live_guard_request_budget');
      const path=new URL(url).pathname.slice(new URL(roots[service]).pathname.length);
      const method=opts.method||'GET',body=opts.body?JSON.parse(opts.body):{};
      const create=method==='POST'&&/^bookmarks\/?$/.test(path);
      if(create&&!allowed[service].includes(body.url))throw new Error('live_guard_create');
      if(method!=='GET'&&!create) {
        const id=path.split('/')[1];
        const own=state.created.some(r=>r.service===service&&r.id===id);
        const listCreate=service==='karakeep'&&path==='lists'&&method==='POST'&&body.description==='Pinboard Bookmark Enhanced: Read Later';
        const member=service==='karakeep'&&/^lists\/[^/]+\/bookmarks\/[^/]+$/.test(path)&&state.created.some(r=>r.service===service&&r.id===path.split('/')[3]);
        if(!((path.startsWith('bookmarks/')&&own)||listCreate||member))throw new Error('live_guard_mutation');
      }
      const response=await original(input,opts);
      if(create&&response.ok) {
        const row=await response.clone().json(),id=String(row.id),actual=service==='linkding'?row.url:row.content?.url;
        if(actual!==body.url)throw new Error('live_guard_response');
        if(!state.created.some(r=>r.service===service&&r.id===id))state.created.push({service,id,url:body.url});
      }
      if(service==='karakeep'&&method==='POST'&&path==='lists'&&response.ok)state.lists.push({service,id:String((await response.clone().json()).id)});
      return response;
    };
  },{roots,allowed});
  const pageErrors=[];ctx.on('page',p=>p.on('pageerror',()=>pageErrors.push('pageerror')));
  await ctx.route(/^https?:\/\//,route=>{
    const url=route.request().url();
    if(Object.values(allowed).flat().includes(url))return route.fulfill({contentType:'text/html',body:'<title>联调样例</title><meta name="description" content="Public synthetic meta description."><article><h1>联调样例</h1><p>'+('公开合成文本，不含个人资料。 '.repeat(100))+'</p></article>'});
    if(Object.values(bases).some(base=>url.startsWith(base)))return route.continue();
    return route.abort();
  });
  const extension='chrome-extension://'+extId+'/';let libraryOwner;
  for(const service of services) {
    phase=service+'_connect';
    const options=await ctx.newPage();await options.goto(extension+'options.html');
    await options.locator(`input[name="bookmark-service"][value="${service}"]`).check();
    await options.locator('#opt-'+service+'-url').fill(bases[service]);await options.locator('#opt-'+service+'-token').fill(credentials[service+'Token']);
    await options.locator('#connect-'+service).click();
    await options.locator('#connect-'+service+'-status').filter({hasText:'Connected'}).waitFor({timeout:25000});
    await until(()=>worker.evaluate(async service=>(await pbpReadBookmarkConnection()).service===service,service),'selected_service');
    const owner=await worker.evaluate(()=>pbpVocabCurrentOwner());
    if(!libraryOwner){libraryOwner=owner;await worker.evaluate(owner=>pbpVocabSaveWord(owner,{term:'shared',language:'en',gloss:'local fixture',contexts:[]}),owner);}
    check(owner===libraryOwner,'library_switched');check(await worker.evaluate(async owner=>(await pbpVocabAll(owner)).length===1,owner),'library_lost');
    await options.close();
    if(args.includes('--read-only')) {
      const result=await worker.evaluate(async()=>{const client=pbpBookmarkClient(await getCurrentBookmarkAuth());return {tags:(await client.tags()).length,recent:(await client.recent(2)).length};});
      report.checks.push(service+': authenticated extension tags/recent passed ('+result.tags+' usable tags)');
      console.log(service+': readonly extension checks passed ('+result.tags+' usable tags)');await syncLedger();continue;
    }
    const url=allowed[service][0];const article=await ctx.newPage();await article.goto(url);await article.bringToFront();
    phase=service+'_popup';
    const opened=ctx.waitForEvent('page');await worker.evaluate(url=>chrome.tabs.create({url,active:false}),extension+'popup.html');const popup=await opened;
    await popup.waitForLoadState();await popup.locator('#main-section:not(.hidden)').waitFor();await popup.waitForFunction(()=>typeof _popupDraftContext!=='undefined'&&_popupDraftContext?.ready===true&&!document.getElementById('submit-btn').disabled);
    if(service==='linkding') {
      check(await popup.locator('#private-check').isHidden(),'linkding_private_control');
      check(!await popup.locator('#share-check').isChecked(),'linkding_default_shared');
      check(await popup.locator('#linkding-description-input').inputValue()==='Public synthetic meta description.','linkding_meta_description');
      check(!(await popup.locator('#description-input').inputValue()).includes('Public synthetic meta description.'),'linkding_meta_repeated_in_notes');
      await popup.locator('#linkding-description-input').fill('手工描述，与笔记分开');
    }
    await popup.locator('#title-input').fill(prefix+' 中文标题');await popup.locator('#description-input').fill('中文笔记\n第二行');
    await popup.locator('#tags-input').fill(prefix);await popup.locator('#tags-input').press('Enter');await popup.locator('#submit-btn').click();
    await until(()=>popup.evaluate(()=>document.getElementById('submit-btn').classList.contains('saved-success')),'popup_save');
    let row=await ownRow(service,url);check(row.title===prefix+' 中文标题','popup_title');check((service==='linkding'?row.notes:row.note)==='中文笔记\n第二行','popup_note');
    check(service!=='linkding'||row.shared===false,'privacy');
    check(service!=='linkding'||row.description==='手工描述，与笔记分开','linkding_description');await popup.close();
    phase=service+'_reader';const account=await worker.evaluate(async()=>(await getCurrentBookmarkAuth()).account);
    await worker.evaluate(async data=>chrome.storage.local.set({md_preview_data_live:{markdown:'# 合成文章\n\n不含个人资料。',title:'合成文章',url:data.url,baseUrl:data.url,account:data.account,tags:[],description:'',source:'local',ts:Date.now()}}),{url,account});
    const reader=await ctx.newPage();await reader.goto(extension+'md-preview.html?k=live');
    await reader.waitForFunction(()=>document.getElementById('reader-bookmark-later')?.getAttribute('aria-busy')==='false');
    await reader.locator('#reader-bookmark-later').click();await reader.waitForFunction(()=>document.getElementById('reader-bookmark-later')?.getAttribute('aria-pressed')==='true');
    row=await ownRow(service,url);
    if(service==='linkding')check(row.unread===true,'read_later');
    else {const lists=await api(service,'bookmarks/'+row.id+'/lists');check(lists.lists.some(l=>l.type==='manual'&&!l.public&&!l.hasCollaborators&&l.userRole==='owner'),'private_read_later');check(row.archived===false,'later_changed_archive');}
    phase=service+'_reader_edit';
    await reader.waitForFunction(()=>document.getElementById('reader-bookmark-save')?.getAttribute('aria-busy')==='false');
    await reader.locator('#reader-bookmark-edit').click();await reader.locator('#reader-bookmark-title').fill(prefix+' 已编辑');await reader.locator('#reader-bookmark-notes').fill('编辑后的笔记\n第二行');
    await reader.locator('#reader-bookmark-tags').fill(JSON.stringify(prefix+' 空格'));await reader.locator('#reader-bookmark-apply').click();
    await until(()=>reader.evaluate(()=>!document.getElementById('reader-bookmark-editor').matches(':popover-open')),'reader_edit');
    row=await ownRow(service,url);check(row.title===prefix+' 已编辑'&&(service==='linkding'?row.notes:row.note)==='编辑后的笔记\n第二行','reader_fields');
    check((service==='linkding'?row.tag_names:row.tags.map(t=>t.name)).includes(prefix+'_空格'),'new_tag_separator');
    check(service!=='linkding'||row.description==='手工描述，与笔记分开','reader_preserves_description');
    phase=service+'_reader_mark_read';
    await reader.waitForFunction(()=>document.getElementById('reader-bookmark-save')?.getAttribute('aria-busy')==='false');
    await reader.locator('#reader-bookmark-save').click();await reader.waitForFunction(()=>document.getElementById('reader-bookmark-later')?.getAttribute('aria-pressed')==='false');
    row=await ownRow(service,url);if(service==='linkding')check(!row.unread,'mark_read');
    else check(!(await api(service,'bookmarks/'+row.id+'/lists')).lists.some(l=>l.description==='Pinboard Bookmark Enhanced: Read Later'),'remove_later');
    phase=service+'_reader_delete';
    await reader.waitForFunction(()=>document.getElementById('reader-bookmark-save')?.getAttribute('aria-busy')==='false');
    await reader.locator('#reader-bookmark-edit').click();await reader.locator('#reader-bookmark-delete').click();await reader.locator('.confirm-yes').click();
    await reader.waitForFunction(()=>document.getElementById('reader-bookmark-status')?.textContent==='Bookmark deleted');
    check(await api(service,recordPath(service,row.id),{allow404:true})===null,'reader_delete');await reader.close();await article.close();
    phase=service+'_worker';const second=allowed[service][1];
    const intent={mode:'create',url:second,title:prefix+' 第二条',notes:'第二条笔记',tags:JSON.stringify(prefix+' 空格'),private:true,toread:false,archive:false};
    const submit=async value=>worker.evaluate(async intent=>{const result=await submitSaveIntent(intent);return {status:result.status,reason:result.reason};},value);
    check((await submit(intent)).status==='saved','worker_create');row=await ownRow(service,second);
    await api(service,recordPath(service,row.id),{method:'PATCH',body:service==='linkding'?{is_archived:true}:{archived:true}});
    check((await submit({...intent,mode:'merge',title:'must preserve original',notes:'',tags:prefix})).status==='saved','worker_merge');row=await ownRow(service,second);
    check(row.title===intent.title&&(service==='linkding'?row.is_archived:row.archived)===true,'merge_preserves_fields');
    check((await submit(intent)).reason==='conflict','duplicate_create');
    if(service==='linkding'){
      let status='missing';const deadline=Date.now()+120000;
      while(Date.now()<deadline){const assets=await api(service,'bookmarks/'+row.id+'/assets/');const snapshot=assets.results.find(a=>a.asset_type==='snapshot');status=snapshot?.status||'missing';if(['complete','failure'].includes(status))break;await new Promise(r=>setTimeout(r,2000));}
      report.snapshot=status;check(status==='complete','snapshot_incomplete');
    }
    const data=await worker.evaluate(async()=>{const auth=await getCurrentBookmarkAuth();const client=pbpBookmarkClient(auth);return {tags:(await client.tags()).length,recent:(await client.recent(2)).length};});
    check(data.tags>=1&&data.recent>=0,'tags_recent');
    check(await worker.evaluate(async()=>!(await pbpReadSettingsWithSecrets({pinboardToken:''})).pinboardToken),'pinboard_required');
    check((await worker.evaluate(()=>pbpVocabCurrentOwner()))===libraryOwner,'library_changed');
    report.checks.push(service+': Connect, popup save, reader edit/tags/Read Later/read/delete, worker create/merge/duplicate, archived-field preservation, tags/recent, shared library');
    console.log(service+': real UI and worker acceptance passed');await syncLedger();
  }
  check(pageErrors.length===0,'browser_page_error');
} catch(error) {
  failed=true;let message=String(error.message);
  for(const value of Object.values(credentials))if(typeof value==='string'&&value)message=message.split(value).join('[redacted]');
  // Assertion messages are fixed codes. Browser/transport errors may carry
  // input or response data, so retain only their class, not their message.
  report.failure={phase,code:/^[a-z_0-9]+$/.test(message)?message:error.name};
  console.error('FAILED '+phase+': '+report.failure.code);
} finally {
  await syncLedger().catch(()=>{});
  if(ctx)await ctx.close().catch(()=>{});worker=null;
  for(const item of report.created) {
    try {
      const row=await api(item.service,recordPath(item.service,item.id),{allow404:true});
      if(row!==null){check(rowUrl(item.service,row)===item.url&&allowed[item.service].includes(item.url),'cleanup_url');await api(item.service,recordPath(item.service,item.id),{method:'DELETE'});}
      check(await api(item.service,recordPath(item.service,item.id),{allow404:true})===null,'cleanup_delete');report.cleanup.push({kind:'bookmark',service:item.service,id:item.id,deleted:true});
    }catch{failed=true;report.cleanup.push({kind:'bookmark',service:item.service,id:item.id,deleted:false});}
  }
  for(const item of report.lists) {
    try {
      const row=await api(item.service,'lists/'+item.id),members=await api(item.service,'lists/'+item.id+'/bookmarks?limit=1');
      check(row.description==='Pinboard Bookmark Enhanced: Read Later'&&!row.public&&!row.hasCollaborators&&row.userRole==='owner'&&!members.bookmarks.length,'cleanup_list');
      await api(item.service,'lists/'+item.id,{method:'DELETE'});report.cleanup.push({kind:'list',id:item.id,deleted:true});
    }catch{failed=true;report.cleanup.push({kind:'list',id:item.id,deleted:false});}
  }
  // Karakeep exposes an exact reference count; only zero-use run tags qualify.
  for(const item of report.tags.filter(t=>t.service==='karakeep')) {
    try{const tag=await api(item.service,'tags/'+item.id);check(tag.name===item.name&&tag.numBookmarks===0,'cleanup_tag');await api(item.service,'tags/'+item.id,{method:'DELETE'});report.cleanup.push({kind:'tag',service:item.service,id:item.id,deleted:true});}
    catch{failed=true;report.cleanup.push({kind:'tag',service:item.service,id:item.id,deleted:false});}
  }
  if(report.created.some(r=>r.service==='linkding')) {
    try {
      let path='tags/?limit=100';const seen=new Set();
      while(path){check(!seen.has(path)&&seen.size<100,'cleanup_pagination');seen.add(path);const data=await api('linkding',path);
        for(const tag of data.results){
          if(![prefix,prefix+'_空格',prefix+'-空格'].includes(tag.name))continue;
          const query='?limit=1&q='+encodeURIComponent('#'+tag.name);
          const active=await api('linkding','bookmarks/'+query),archived=await api('linkding','bookmarks/archived/'+query);
          const fresh=await api('linkding','tags/'+tag.id+'/');
          check(active.count===0&&archived.count===0&&!active.results.length&&!archived.results.length&&fresh.name===tag.name,'cleanup_tag_referenced');
          await api('linkding','tags/'+tag.id+'/',{method:'DELETE'});report.cleanup.push({kind:'tag',service:'linkding',id:String(tag.id),deleted:true});
        }
        path=data.next;
      }
    }catch{failed=true;report.cleanup.push({kind:'tag',service:'linkding',deleted:false});}
  }
  if(profile)rmSync(profile,{recursive:true,force:true});
  report.finished=new Date().toISOString();report.passed=!failed;persist();
  console.log('Local report: '+reportPath);console.log('Created bookmarks: '+report.created.length+'; deleted: '+report.cleanup.filter(r=>r.kind==='bookmark'&&r.deleted).length);
}
process.exitCode=failed?1:0;
