// Isolated Chromium smoke: real settings/popup/reader/worker against a loopback
// API fixture. No credentials, profiles or remote services from the user.
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url));
const {chromium}=createRequire(resolve(root,'.qa-scan/package.json'))('playwright');
const profile=mkdtempSync(join(tmpdir(),'pbp-bookmark-runtime-'));
const records={linkding:new Map(),karakeep:new Map()}, requests=[], membership=new Set(), wire=[];
const raceCreates=new Map();
const list={id:'later1',name:'Read Later',description:'Pinboard Bookmark Enhanced: Read Later',icon:'bookmark',type:'manual',public:false,hasCollaborators:false,userRole:'owner'};
let listCreated=false;
// gate.linkding puts a Cloudflare Access-shaped gateway in front of /linkding/.
const gate={linkding:false}, acceptedKeys=new Set(['fixture-key']);
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  wire.push({method:req.method,path:url.pathname,hasCookie:!!req.headers.cookie});
  const probe=url.pathname.match(/^\/probe\/([a-z]+)\/api\//);
  if(probe){
    // Hand-written gateway shapes (design section 5); the redirect target must never be requested.
    const kind=probe[1];
    if(kind==='redirect'){res.writeHead(302,{Location:origin+'/cdn-cgi/access/login/probe'});res.end();return;}
    if(kind==='challenge'){res.writeHead(403,{'Content-Type':'text/html; charset=UTF-8','cf-mitigated':'challenge'});res.end('<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body></body></html>');return;}
    if(kind==='basic'){res.writeHead(401,{'Content-Type':'text/plain','WWW-Authenticate':'Basic realm="Restricted"'});res.end('Unauthorized');return;}
    if(kind==='denied'){res.writeHead(403,{'Content-Type':'text/html'});res.end('<html><body>Forbidden</body></html>');return;}
    if(kind==='page'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<html><title>Sign in</title></html>');return;}
    if(kind==='headers'){
      if(req.headers['x-probe-gateway']==='probe-value'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({theme:'auto',version:'1.44.0'}));}
      else{res.writeHead(400).end();}
      return;
    }
    res.writeHead(404).end();return;
  }
  if(url.pathname.startsWith('/article')) {res.setHeader('Content-Type','text/html');res.end('<html><head><title>Runtime article</title></head><body><article><h1>Runtime article</h1><p>'+('Public synthetic article for a local extension test. '.repeat(80))+'</p></article></body></html>');return;}
  const service=url.pathname.startsWith('/linkding/')?'linkding':'karakeep';
  if(service==='linkding'&&gate.linkding&&(req.headers['cf-access-client-id']!=='fixture-cf-id'||req.headers['cf-access-client-secret']!=='fixture-cf-secret')){
    res.writeHead(302,{Location:origin+'/cdn-cgi/access/login/fixture'});res.end();return;
  }
  const path=url.pathname.replace(/^\/(?:linkding|karakeep)\/api(?:\/v1)?\//,'');
  let body='';for await(const chunk of req)body+=chunk;
  let data;try{data=body?JSON.parse(body):{};}catch{res.writeHead(400).end();return;}
  requests.push({service,path,method:req.method,data});
  const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(status===204?'':JSON.stringify(value));};
  const scheme=service==='linkding'?'Token ':'Bearer ';
  if(![...acceptedKeys].some(key=>req.headers.authorization===scheme+key)){reply(401,{});return;}
  const store=records[service];
  if(path==='user/profile/')return reply(200,{theme:'auto',version:'1.44.0'});
  if(path==='users/me')return reply(200,{id:'u1',name:'Fixture',email:null,localUser:true});
  if(path.startsWith('bookmarks/check')){
    const row=[...store.values()].find(b=>(b.url||b.content?.url)===url.searchParams.get('url'));
    return reply(200,service==='linkding'?{bookmark:row||null,metadata:{},auto_tags:[]}:{bookmarkId:row?.id||null});
  }
  if(path==='tags/'||path==='tags')return reply(200,service==='linkding'?{count:0,next:null,results:[]}:{tags:[]});
  if(path==='lists'&&req.method==='GET')return reply(200,{lists:listCreated?[list]:[]});
  if(path==='lists'&&req.method==='POST'){listCreated=true;return reply(201,list);}
  if(path==='lists/later1')return reply(200,list);
  if(path.startsWith('lists/later1/bookmarks/')){
    if(req.method==='PUT')membership.add(path.split('/').pop());else membership.delete(path.split('/').pop());return reply(204);
  }
  if(/^bookmarks\/?$/.test(path)){
    if(req.method==='GET')return reply(200,service==='linkding'?{count:store.size,next:null,results:[...store.values()]}:{bookmarks:[...store.values()],nextCursor:null});
    const race=raceCreates.get(service+':'+data.url);
    if(race){store.set(String(race.record.id),structuredClone(race.record));return reply(race.status,race.record);}
    const id=service==='linkding'?store.size+1:'b'+(store.size+1);
    // Hand-authored API record schemas, independently filled from HTTP input.
    const row=service==='linkding'?{id,url:data.url,title:data.title,description:'Site summary',notes:data.notes,tag_names:data.tag_names||[],unread:data.unread||false,shared:data.shared||false,is_archived:false,date_added:'2026-10-01T00:00:00Z'}:
      {id,title:data.title,note:data.note,summary:null,archived:false,favourited:false,createdAt:'2026-10-01T00:00:00Z',userId:'u1',tags:[],content:{type:'link',url:data.url,title:'Site title'},assets:[]};
    store.set(String(id),row);return reply(201,row);
  }
  const id=path.split('/')[1],row=store.get(id);
  if(!row)return reply(404,{});
  if(path.endsWith('/lists'))return reply(200,{lists:membership.has(id)?[list]:[]});
  if(path.endsWith('/tags')){
    if(req.method==='POST'){for(const tag of data.tags)row.tags.push({id:'tag'+row.tags.length,name:tag.tagName,attachedBy:'human'});return reply(200,{attached:row.tags.map(t=>t.id)});}
    row.tags=row.tags.filter(t=>!data.tags.some(x=>x.tagId===t.id));return reply(200,{detached:data.tags.map(t=>t.tagId)});
  }
  if(req.method==='DELETE'){store.delete(id);return reply(204);}
  if(req.method==='PATCH')Object.assign(row,data);
  return reply(200,row);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port;
const launch=()=>chromium.launchPersistentContext(profile,{headless:true,executablePath:chromium.executablePath(),viewport:{width:1280,height:900},args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`,'--no-first-run','--disable-background-networking','--disable-component-update','--disable-sync','--no-pings','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']});
const getWorker=async ctx=>ctx.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'))||ctx.waitForEvent('serviceworker');
let ctx;
const errors=[];
async function until(read, label) {
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){if(await read())return;await new Promise(r=>setTimeout(r,100));}
  throw new Error('Timed out: '+label+'; page errors: '+errors.join('; '));
}
try{
  ctx=await launch();let worker=await getWorker(ctx);const extId=new URL(worker.url()).hostname;
  await worker.evaluate(async()=>{await primeSettings();await chrome.storage.local.set({optSyncEnabled:false,optAiAutoTags:false,previewAiEnabled:false,optAutoCloseAfterSave:false,optLang:'en',optCheckBookmarkStatus:false});});
  await ctx.close();ctx=null;
  // Same isolated-profile grant technique as qa-drive; no user profile changes.
  const prefsPath=join(profile,'Default','Preferences'),prefs=JSON.parse(readFileSync(prefsPath,'utf8'));
  for(const key of ['granted_permissions','active_permissions']){
    const bucket=prefs.extensions.settings[extId][key] ||= {};
    const hosts=bucket.explicit_host ||= [];if(!hosts.includes(origin+'/*'))hosts.push(origin+'/*');
  }
  writeFileSync(prefsPath,JSON.stringify(prefs));ctx=await launch();worker=await getWorker(ctx);await worker.evaluate(()=>primeSettings());
  ctx.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  await ctx.route(/^https:\/\//,route=>route.abort());
  assert(await worker.evaluate(origin=>chrome.permissions.contains({origins:[origin+'/*']}),origin));
  const article=await ctx.newPage();await article.goto(origin+'/article');
  const pageUrl='chrome-extension://'+extId+'/';
  const backupPage=await ctx.newPage();await backupPage.goto(pageUrl+'options.html');
  const restored=await backupPage.evaluate(async()=>{
    const before=(await indexedDB.databases()).map(db=>db.name).filter(name=>['pbp-vocab','pbp-dict-archive','pbp-ask-archive'].includes(name)).sort();
    const empty=await pbpBackupPersonalLibraryEmpty();
    const after=(await indexedDB.databases()).map(db=>db.name).filter(name=>['pbp-vocab','pbp-dict-archive','pbp-ask-archive'].includes(name)).sort();
    const payload={_schemaVersion:3,_backup:{createdAt:'2026-10-01T00:00:00.000Z',extensionVersion:'2.0.0',source:'manual'},_highlightsOwner:'restored-personal',_highlights:{pbp_hl_restore_fixture:{v:1,url:'https://fixture.test/restore',title:'Restore',items:[{id:'fixture-hl',n:1,quote:'restored quote',color:1,ts:1}]}}};
    const result=await pbpApplyBackupPayload(payload,{exportableKeys:[],sections:{settings:false,themes:false,secrets:false,highlights:true,vocabulary:false}});
    const owner=await pbpPersonalLibraryAccount();
    const populated=await pbpBackupPersonalLibraryEmpty();
    const denied=await pbpBackupLibraryIdentity({highlightsOwner:'another-library'},{highlights:true},{apply:true});
    return {before,after,empty,populated,result,owner,denied};
  });
  assert(restored.empty);assert.deepEqual(restored.before,restored.after,'emptiness probe created a database');
  assert.equal(restored.result.highlights,'applied');assert(restored.result.libraryAdopted);
  assert.equal(restored.owner,'restored-personal');assert.equal(restored.populated,false);assert.equal(restored.denied,'');
  await backupPage.close();
  console.log('empty-library JSON restore adopted its owner; a populated library refused another owner');
  let personalOwner;
  for(const service of ['linkding','karakeep']){
    const options=await ctx.newPage();await options.goto(pageUrl+'options.html');
    await options.locator(`input[name="bookmark-service"][value="${service}"]`).check();
    const en=JSON.parse(readFileSync(new URL('../_locales/en/messages.json',import.meta.url),'utf8'));
    // The gateway ? stays reachable with the gateway on None and answers "when do I need one": only that paragraph is visible.
    await options.locator('#'+service+'-gateway-help > summary').click();
    await options.locator('#'+service+'-gateway-none-help').waitFor({state:'visible',timeout:5000}).catch(()=>{throw new Error('gateway help does not say when a gateway is needed while the gateway is None')});
    assert((await options.locator('#'+service+'-gateway-none-help').textContent()).trim()===en.bookmarkGatewayNoneHint.message,'none help text is not the new copy');
    assert(await options.locator('#'+service+'-gateway-cf-help').isHidden(),'Cloudflare steps show while the gateway is None');
    assert(await options.locator('#'+service+'-gateway-custom-help').isHidden(),'custom help shows while the gateway is None');
    await options.evaluate(service=>{const s=document.getElementById('opt-'+service+'-gateway');s.value='cloudflare';s.dispatchEvent(new Event('change',{bubbles:true}));},service);
    assert(await options.locator('#'+service+'-gateway-cf-help').isVisible()&&await options.locator('#'+service+'-gateway-none-help').isHidden(),'Cloudflare help does not replace the none help');
    await options.evaluate(service=>{const s=document.getElementById('opt-'+service+'-gateway');s.value='none';s.dispatchEvent(new Event('change',{bubbles:true}));},service);
    // The connection overview follows the chosen service (its first row names it).
    await until(()=>options.evaluate(name=>(document.querySelector('#connection-health .connection-health-name')?.textContent||'').includes(name),service==='karakeep'?'Karakeep':'linkding'),'connection overview names '+service);
    // Header names/labels re-apply on a language re-apply: a stale name is rewritten, not left behind.
    await options.evaluate(()=>{for(const el of document.querySelectorAll('[data-gw-header],[data-gw-header-name],[data-gw-header-value]'))el.matches('label')?el.textContent='stale':el.setAttribute('aria-label','stale');document.dispatchEvent(new Event('pbp:i18n-applied'));});
    assert.equal(await options.evaluate(()=>[document.querySelector('label[data-gw-header="2"]').textContent,document.querySelector('[data-gw-header-name="2"]').getAttribute('aria-label'),document.querySelector('[data-gw-header-value="2"]').getAttribute('aria-label')].join('|')),
      ['Header 2','Header 2 name','Header 2 value'].join('|'),'gateway header names stayed stale after pbp:i18n-applied');
    await options.locator('#opt-'+service+'-url').fill(origin+'/'+service+'/');
    if(service==='linkding'){
      await options.locator('#opt-'+service+'-token').fill('wrong-key');
      await options.locator('#connect-'+service).click();
      const authMessage=JSON.parse(readFileSync(new URL('../_locales/en/messages.json',import.meta.url),'utf8')).bookmarkConnectErrAuth.message;
      await options.locator('#connect-'+service+'-status').filter({hasText:authMessage}).waitFor({timeout:10000}).catch(async error=>{console.error({status:await options.locator('#connect-'+service+'-status').textContent()});throw error;});
      assert.equal((await options.locator('#connect-'+service+'-status').textContent()).trim(),authMessage);
      // A rejected connect is an error state, not the default success colour, and it marks the token field.
      assert(await options.locator('#connect-'+service+'-status.bad').count(),'auth rejection status has no .bad state class');
      assert.equal(await options.locator('#opt-'+service+'-token').getAttribute('aria-invalid'),'true');
      // Plain http on a public host is a URL problem: its own message, and the URL field is marked.
      await options.locator('#opt-'+service+'-url').fill('http://bookmarks.example.com/');
      await options.locator('#connect-'+service).click();
      assert.equal((await options.locator('#connect-'+service+'-status').textContent()).trim(),JSON.parse(readFileSync(new URL('../_locales/en/messages.json',import.meta.url),'utf8')).bookmarkUrlInvalid.message);
      assert.equal(await options.locator('#opt-'+service+'-url').getAttribute('aria-invalid'),'true');
      await options.locator('#opt-'+service+'-url').fill(origin+'/'+service+'/');
      assert(!(await options.evaluate(async()=>(await pbpReadBookmarkConnection()).account)),'wrong-key connection was saved');
    }
    await options.locator('#opt-'+service+'-token').fill('fixture-key');
    console.log(service+' permission:',await options.evaluate(origin=>chrome.permissions.contains({origins:[origin+'/*']}),origin));
    await options.locator('#connect-'+service).click();
    await options.locator('#connect-'+service+'-status').filter({hasText:'Connected'}).waitFor({timeout:10000}).catch(async error=>{console.error({status:await options.locator('#connect-'+service+'-status').textContent(),requests:requests.map(r=>({path:r.path,method:r.method})),errors});throw error;});
    await until(()=>options.evaluate(async service=>{const c=await pbpReadBookmarkConnection();return c.service===service&&!!c.account;},service),'selected service persisted');
    await options.setViewportSize({width:400,height:900});
    assert(await options.evaluate(service=>document.getElementById('opt-'+service+'-url').getBoundingClientRect().width>=document.getElementById('opt-'+service+'-token').parentElement.getBoundingClientRect().width-1,service),'server URL field does not fill its form column');
    await options.locator('#panel-general .settings-section').first().screenshot({path:join(tmpdir(),'pbp-'+service+'-settings.png')});
    assert(await options.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'settings horizontal overflow');
    const owner=await worker.evaluate(()=>pbpVocabCurrentOwner());
    if(!personalOwner){personalOwner=owner;assert(await worker.evaluate(owner=>pbpVocabSaveWord(owner,{term:'shared',language:'en',gloss:'fixture',contexts:[]}),owner));}
    assert.equal(owner,personalOwner);
    assert.equal(await worker.evaluate(async owner=>(await pbpVocabAll(owner)).length,owner),1);
    assert.equal((await worker.evaluate(()=>pbpReadBookmarkConnection())).service,service);
    await options.close();await article.bringToFront();
    const popupPromise=ctx.waitForEvent('page');
    await worker.evaluate(url=>chrome.tabs.create({url,active:false}),pageUrl+'popup.html');
    const popup=await popupPromise;await popup.waitForLoadState();
    await popup.locator('#main-section:not(.hidden)').waitFor({timeout:10000}).catch(async error=>{console.error({errors,popupUrl:popup.url(),body:(await popup.locator('body').innerText()).slice(0,1200),connection:await popup.evaluate(async()=>{const c=await pbpReadBookmarkConnection();return {service:c.service,connected:!!c.account};})});throw error;});
    await popup.waitForFunction(()=>!document.getElementById('submit-btn').disabled);
    await popup.locator('#title-input').fill(service+' title');await popup.locator('#description-input').fill('My note');
    await popup.locator('#tags-input').fill('reading');await popup.locator('#tags-input').press('Enter');
    await popup.locator('#submit-btn').click();
    await until(()=>popup.evaluate(()=>document.getElementById('submit-btn').classList.contains('saved-success')),'popup save success').catch(async error=>{console.error({requests:requests.map(r=>({path:r.path,method:r.method})),status:await popup.locator('body').innerText()});throw error;});
    assert.equal(records[service].size,1,service+' popup did not save');await popup.close();
    const account=(await worker.evaluate(()=>getCurrentBookmarkAuth())).account;
    await worker.evaluate(async data=>chrome.storage.local.set({md_preview_data_services:{markdown:'# Runtime article\n\nA synthetic article for the reader.',title:'Runtime article',url:data.url,baseUrl:data.url,account:data.account,tags:[],description:'',source:'local',ts:Date.now()}}),{url:origin+'/article',account});
    const reader=await ctx.newPage();await reader.goto(pageUrl+'md-preview.html?k=services');
    await reader.waitForFunction(()=>document.getElementById('reader-bookmark-later')?.getAttribute('aria-busy')==='false');
    await reader.locator('#reader-bookmark-later').click();
    await reader.waitForFunction(()=>document.getElementById('reader-bookmark-later')?.getAttribute('aria-pressed')==='true');
    assert(service==='linkding'?[...records.linkding.values()][0].unread:membership.size===1);
    await reader.locator('#reader-bookmark-edit').click();
    if(service==='karakeep')assert(await reader.locator('#reader-bookmark-private').isHidden());
    await reader.locator('#reader-bookmark-delete').click();await reader.locator('.confirm-yes').click();
    await reader.waitForFunction(()=>document.getElementById('reader-bookmark-status')?.textContent==='Bookmark deleted');
    assert.equal(records[service].size,0);await reader.close();
    assert.equal(await worker.evaluate(()=>pbpVocabCurrentOwner()),personalOwner);
    console.log(service+': settings, popup save, reader Read Later/delete, shared vocabulary passed');
  }
  {
    // Access gateway form: validation before any request, Cloudflare headers
    // sealed on Connect, linkding keeps its connection ID for the same URL and token.
    const en=JSON.parse(readFileSync(new URL('../_locales/en/messages.json',import.meta.url),'utf8'));
    const options=await ctx.newPage();await options.goto(pageUrl+'options.html');
    const status=options.locator('#connect-linkding-status');
    const waitStatus=text=>status.filter({hasText:text}).waitFor({timeout:10000}).catch(async error=>{console.error({status:await status.textContent(),errors});throw error;});
    const linkdingAccount=()=>options.evaluate(async()=>pbpBookmarkConnection({...await pbpReadSettingsWithSecrets(SETTINGS_DEFAULTS),bookmarkService:'linkding'}).account);
    const chooseGateway=value=>options.evaluate(value=>{const select=document.getElementById('opt-linkding-gateway');select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));},value);
    await options.locator('input[name="bookmark-service"][value="linkding"]').check();
    await options.locator('#opt-linkding-url').fill(origin+'/linkding/');
    await options.locator('#opt-linkding-token').fill('fixture-key');
    const before=await linkdingAccount();assert(before,'linkding connection from the main loop is missing');
    gate.linkding=true;
    await options.locator('#connect-linkding').click();
    await waitStatus(en.bookmarkErrGatewayRedirect.message);
    assert.equal((await status.textContent()).trim(),en.bookmarkErrGatewayRedirect.message);
    await chooseGateway('cloudflare');
    const wireBefore=wire.length;
    await options.locator('#connect-linkding').click();
    await waitStatus(en.bookmarkGatewayErrRequired.message);
    assert.equal((await status.textContent()).trim(),en.bookmarkGatewayErrRequired.message);
    assert.equal(wire.length,wireBefore,'an invalid gateway form sent a request');
    assert.equal(await options.locator('#opt-linkding-cf-id').getAttribute('aria-invalid'),'true');
    await options.locator('#opt-linkding-cf-id').fill('fixture-cf-id');
    await options.locator('#opt-linkding-cf-secret').fill('fixture-cf-secret');
    assert(await options.locator('#linkding-connect-pending').isVisible(),'pending gateway change is not shown');
    await options.locator('#connect-linkding').click();
    await waitStatus('Connected');
    assert(await options.locator('#linkding-connect-pending').isHidden(),'pending hint stayed after connecting');
    assert.equal(await linkdingAccount(),before,'same URL and token did not keep the linkding connection ID');
    await options.reload();
    await until(()=>options.evaluate(()=>document.getElementById('opt-linkding-gateway')?.value==='cloudflare'),'gateway type restored');
    assert.equal(await options.locator('#opt-linkding-cf-id').inputValue(),'fixture-cf-id');
    assert.equal(await options.locator('#opt-linkding-cf-secret').inputValue(),'fixture-cf-secret');
    await until(async()=>(await options.locator('#opt-linkding-gateway-btn .listbox-value').textContent()).trim()===en.bookmarkGatewayCloudflare.message,'gateway listbox shows Cloudflare Access');
    assert(await options.locator('#linkding-connect-pending').isHidden(),'restored gateway reads as modified');
    acceptedKeys.add('fixture-key-2');
    // U4: the not-applied warning covers the URL and the token too, not only the gateway.
    await options.locator('#opt-linkding-url').fill(origin+'/linkding/other/');
    assert(await options.locator('#linkding-connect-pending').isVisible(),'a changed URL is not reported as unapplied');
    await options.locator('#opt-linkding-url').fill(origin+'/linkding');
    assert(await options.locator('#linkding-connect-pending').isHidden(),'the saved URL, retyped without its slash, reads as modified');
    await options.locator('#opt-linkding-token').fill('fixture-key-2');
    assert(await options.locator('#linkding-connect-pending').isVisible(),'a changed token is not reported as unapplied');
    await options.locator('#connect-linkding').click();
    await waitStatus('Connected');
    assert(await options.locator('#linkding-connect-pending').isHidden(),'pending hint stayed after connecting a new token');
    const rotated=await linkdingAccount();
    assert(rotated&&rotated!==before,'a new token kept the old linkding connection ID');
    // Editing the form while Connect is in flight abandons it and must not leave "Connecting..." behind.
    await options.evaluate(()=>{document.getElementById('connect-linkding').click();document.getElementById('opt-linkding-token').value='fixture-key-3';});
    await until(async()=>(await status.textContent())==='','abandoned Connect left a stale status');
    await options.setViewportSize({width:400,height:900});
    await chooseGateway('custom');
    assert(await options.locator('#opt-linkding-gw-value-4').isVisible(),'custom header rows are hidden');
    assert(await options.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'gateway form horizontal overflow');
    assert.equal(wire.filter(w=>w.method==='OPTIONS').length,0,'gateway headers triggered a preflight');
    assert(wire.every(w=>!w.hasCookie),'a gateway request carried cookies');
    assert(!wire.some(w=>w.path==='/cdn-cgi/access/login/fixture'),'gateway redirect was followed');
    gate.linkding=false;await options.close();
    console.log('access gateway form: validation, Cloudflare connect, restore and connection ID reuse passed');
  }
  // A second client saves after check-url. The server response is authored
  // independently of the submitted fields (Karakeep 0.34.1 B2 shape).
  const raceUrl=origin+'/article-race';
  raceCreates.set('karakeep:'+raceUrl,{status:200,record:{id:'race1',createdAt:'2026-10-30T03:05:10.000Z',modifiedAt:'2026-10-30T03:05:10.000Z',title:null,archived:false,favourited:true,note:'Server note',summary:null,source:'api',taggingStatus:null,summarizationStatus:null,tags:[{id:'race-tag1',name:'existing',attachedBy:'human'}],content:{type:'link',url:raceUrl,title:'Crawled title',description:null},assets:[],alreadyExists:true}});
  const raceStart=requests.length;
  const raceResult=await worker.evaluate(async({origin,url})=>{
    const client=pbpCreateBookmarkServiceClient({service:'karakeep',baseUrl:origin+'/karakeep/',beforeRequest:async()=>({token:'fixture-key'}),readLaterListId:'later1'});
    const result=await client.save({url,title:'',notes:'',tags:['existing','new'],toread:true});
    await client.save({url,title:'Crawled title',notes:'Server note',tags:result.bookmark.tags},result.bookmark);
    return result;
  },{origin,url:raceUrl});
  assert.equal(raceResult.mutation,'merged');assert.equal(raceResult.status,'saved');
  const raceCalls=requests.slice(raceStart);
  assert.deepEqual(raceCalls[0].data,{type:'link',url:raceUrl,source:'extension'});
  assert.deepEqual(raceCalls.find(r=>r.path==='bookmarks/race1/tags').data,{tags:[{tagName:'new'}]});
  assert(!raceCalls.some(r=>r.method==='DELETE'),'race merge deleted server tags');
  assert(raceCalls.some(r=>r.path==='lists/later1/bookmarks/race1'&&r.method==='PUT'),'Read Later did not continue');
  assert(!Object.hasOwn(raceCalls.find(r=>r.method==='PATCH').data,'title'),'crawled title was written back');
  console.log('Karakeep create race merged safely, preserved tags and continued Read Later');
  // linkding 1.47 T7: a repeated POST is still 201 with the original id and
  // date_added. Only the server's own timestamps identify the merged record.
  const linkdingRaceUrl=origin+'/article-linkding-race';
  const linkdingPost={id:11,url:linkdingRaceUrl,title:'T',description:'',notes:'',web_archive_snapshot_url:'https://web.archive.org/web/20261030030122/https://example.com/a',favicon_url:null,preview_image_url:null,is_archived:false,unread:false,shared:false,tag_names:['pbp-research','second'],date_added:'2026-10-30T03:01:22.656384Z',date_modified:'2026-10-30T04:01:22.656384Z',website_title:null,website_description:null};
  raceCreates.set('linkding:'+linkdingRaceUrl,{status:201,record:linkdingPost});
  const linkdingSave=async url=>worker.evaluate(url=>submitSaveIntent({mode:'create',url,title:'T',notes:'',tags:'pbp-research second',private:true,toread:false}),url);
  const linkdingRaceStart=requests.length;
  const linkdingRaceResult=await linkdingSave(linkdingRaceUrl);
  assert.equal(linkdingRaceResult.status,'saved');assert.equal(linkdingRaceResult.mutation,'merged');
  assert(!Object.hasOwn(linkdingRaceResult,'account'),'a merged POST exposed a deletion undo account');
  assert.deepEqual(requests.slice(linkdingRaceStart).map(r=>r.method),['GET','POST']);
  assert(records.linkding.has('11'),'merged bookmark was removed');
  console.log('linkding 201 POST with a one-hour server timestamp gap is merged without deletion undo');
  for(const [label,dates] of [
    ['equal',{date_modified:'2026-10-30T03:01:22.656384Z'}],
    ['milliseconds',{date_modified:'2026-10-30T03:01:22.696Z'}],
    ['two-seconds',{date_modified:'2026-10-30T03:01:24.656Z'}],
    ['missing-modified',{date_modified:undefined}],
    ['invalid-modified',{date_modified:'invalid'}],
    ['missing-added',{date_added:undefined}],
    ['invalid-added',{date_added:'invalid'}]
  ]){
    const url=origin+'/article-linkding-'+label;
    raceCreates.set('linkding:'+url,{status:201,record:{...linkdingPost,id:20+records.linkding.size,url,...dates}});
    const result=await linkdingSave(url);
    assert.equal(result.status,'saved',label);assert.equal(result.mutation,'created',label);
    assert(result.account,label+' create lost its undo account');
  }
  console.log('linkding equal, near-equal, two-second and unparseable server dates remain created');
  const probes=await worker.evaluate(async origin=>{
    const out={};
    for(const kind of ['redirect','challenge','basic','denied','page','headers']){
      const client=pbpCreateBookmarkServiceClient({service:'linkding',baseUrl:origin+'/probe/'+kind+'/',beforeRequest:async()=>({token:'probe',headers:[['X-Probe-Gateway','probe-value']]})});
      try{await client.verify();out[kind]='ok';}catch(error){out[kind]=error.code;}
    }
    return out;
  },origin);
  console.log('probe results:',JSON.stringify(probes));
  assert.deepEqual(probes,{redirect:'gateway_redirect',challenge:'gateway_challenge',basic:'gateway_basic',denied:'gateway_denied',page:'not_api',headers:'ok'});
  const probeWire=wire.filter(w=>w.path.startsWith('/probe/')||w.path.startsWith('/cdn-cgi/'));
  console.log('probe wire:',JSON.stringify(probeWire.map(w=>w.method+' '+w.path+(w.hasCookie?' cookie':''))));
  assert.equal(wire.filter(w=>w.method==='OPTIONS').length,0,'custom headers triggered a preflight');
  assert(!wire.some(w=>w.path.startsWith('/cdn-cgi/')),'redirect was followed');
  assert(wire.every(w=>!w.hasCookie),'a request carried cookies');
  console.log('gateway probes classified; no preflight; redirect not followed');
  assert.equal(errors.length,0,errors.join('\n'));
  assert(requests.every(r=>r.service==='linkding'||r.service==='karakeep'));
  console.log('bookmark service runtime smoke passed; synthetic loopback APIs only');
}finally{
  if(ctx)await ctx.close();await new Promise(r=>server.close(r));rmSync(profile,{recursive:true,force:true});
}
