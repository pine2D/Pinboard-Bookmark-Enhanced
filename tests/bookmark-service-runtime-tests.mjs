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
// Blocks, in run order. PBP_RUNTIME_ONLY=<name part>[,<name part>...] runs only
// the blocks whose name contains one of the parts (case-insensitive); --list
// prints the names and exits. Neither set: every block runs. Each block's own connection needs are declared on its
// block() call and set up before every block (reset first), filtered or not, so one
// block run alone reaches the same verdict as in the full run.
const BLOCKS=['archive explanation and JSON restore','services: connect, save, reader','access gateway form','linkding sharing capability','Karakeep create race','linkding merge and server dates','linkding multi-line Description','linkding over-long tag','linkding unknown Description','linkding queued empty Description','linkding restored draft for another URL','linkding address typed after open','linkding cleaned page address','linkding Description server semantics','gateway probes'];
const only=(process.env.PBP_RUNTIME_ONLY||'').split(',').map(part=>part.trim().toLowerCase()).filter(Boolean);
const selected=name=>!only.length||only.some(part=>name.toLowerCase().includes(part));
if(process.argv.includes('--list')){console.log(BLOCKS.join('\n'));process.exit(0);}
if(only.length&&!BLOCKS.some(selected)){console.error('PBP_RUNTIME_ONLY='+process.env.PBP_RUNTIME_ONLY+' matched no block; run with --list for the names');process.exit(2);}
const filterNote=only.length?'Only ran '+BLOCKS.filter(selected).length+'/'+BLOCKS.length+' blocks (PBP_RUNTIME_ONLY='+process.env.PBP_RUNTIME_ONLY+'): '+BLOCKS.filter(selected).join('; '):'';
if(filterNote)console.log(filterNote.replace('Only ran','Running only'));
const {chromium}=createRequire(resolve(root,'.qa-scan/package.json'))('playwright');
const profile=mkdtempSync(join(tmpdir(),'pbp-bookmark-runtime-'));
const records={linkding:new Map(),karakeep:new Map()}, requests=[], membership=new Set(), wire=[];
const raceCreates=new Map();
// The synthetic pages this server publishes. linkding's own scraper reads the
// same title and meta description, so a "server-scraped" value below comes
// from the page itself, never from the request the extension sent.
const pageMetadata=pathname=>pathname==='/article-meta'
  ?{title:'Meta article',description:'Server-scraped description'}
  :pathname==='/article-recent'?{title:'Recent article',description:'Recent page description'}
  :{title:'Runtime article',description:null};
// linkding v1.47 serializer timestamps carry microseconds.
const serverNow=()=>new Date().toISOString().replace(/Z$/,'000Z');
const list={id:'later1',name:'Read Later',description:'Pinboard Bookmark Enhanced: Read Later',icon:'bookmark',type:'manual',public:false,hasCollaborators:false,userRole:'owner'};
let listCreated=false;
let holdLinkdingPatch = null;
// gate.linkding puts a Cloudflare Access-shaped gateway in front of /linkding/.
const gate={linkding:false}, acceptedKeys=new Set(['fixture-key']);
// linkding on PostgreSQL: Tag.name holds 64 characters (models.py; varchar
// counts characters). A longer tag (parse_tag_string splits at commas) fails
// the write, and Django with DEBUG off answers with its stock page
// (django/views/defaults.py server_error; linkding ships no 500.html).
// down: every linkding write meets the same page, whatever its tags.
const postgres={linkding:false}, down={linkding:false};
const tooLongForPostgres=names=>postgres.linkding&&(names||[]).some(name=>String(name).split(',').some(part=>Array.from(part.trim()).length>64));
const DJANGO_500='\n<!doctype html>\n<html lang="en">\n<head>\n  <title>Server Error (500)</title>\n</head>\n<body>\n  <h1>Server Error (500)</h1><p></p>\n</body>\n</html>\n';
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
  if(url.pathname.startsWith('/article')) {const meta=pageMetadata(url.pathname);res.setHeader('Content-Type','text/html');res.end('<html><head><title>'+meta.title+'</title>'+(meta.description?'<meta name="description" content="'+meta.description+'">':'')+'</head><body><article><h1>'+meta.title+'</h1><p>'+('Public synthetic article for a local extension test. '.repeat(80))+'</p></article></body></html>');return;}
  const service=url.pathname.startsWith('/linkding/')?'linkding':'karakeep';
  if(service==='linkding'&&gate.linkding&&(req.headers['cf-access-client-id']!=='fixture-cf-id'||req.headers['cf-access-client-secret']!=='fixture-cf-secret')){
    res.writeHead(302,{Location:origin+'/cdn-cgi/access/login/fixture'});res.end();return;
  }
  const path=url.pathname.replace(/^\/(?:linkding|karakeep)\/api(?:\/v1)?\//,'');
  let body='';for await(const chunk of req)body+=chunk;
  let data;try{data=body?JSON.parse(body):{};}catch{res.writeHead(400).end();return;}
  requests.push({service,path,query:url.search,method:req.method,data});
  const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(status===204?'':JSON.stringify(value));};
  const serverError=()=>{res.writeHead(500,{'Content-Type':'text/html; charset=utf-8'});res.end(DJANGO_500);};
  const scheme=service==='linkding'?'Token ':'Bearer ';
  if(![...acceptedKeys].some(key=>req.headers.authorization===scheme+key)){reply(401,{});return;}
  const store=records[service];
  // linkding v1.47 (website_loader): metadata of a page this server publishes,
  // under either loopback name; anything else could not be fetched, so the
  // scraper finds nothing.
  const scrapeMetadata=raw=>{try{const page=new URL(raw);if([origin,unreadOrigin].includes(page.origin)&&page.pathname.startsWith('/article'))return pageMetadata(page.pathname);}catch{}return {title:null,description:null};};
  // serializers.py BookmarkSerializer: every field, the archive link falling
  // back to a capture at date_added, website_* always null.
  const serialize=row=>{const added=Date.parse(row.date_added);return {id:row.id,url:row.url,title:row.title,description:row.description,notes:row.notes,
    web_archive_snapshot_url:row.web_archive_snapshot_url||(Number.isFinite(added)?'https://web.archive.org/web/'+new Date(added).toISOString().replace(/[-:T]/g,'').slice(0,14)+'/'+row.url:null),
    favicon_url:null,preview_image_url:null,is_archived:row.is_archived,unread:row.unread,shared:row.shared,tag_names:row.tag_names,date_added:row.date_added,date_modified:row.date_modified,website_title:null,website_description:null};};
  if(path==='user/profile/')return reply(200,{theme:'auto',enable_sharing:true,permanent_notes:false});
  if(path==='users/me')return reply(200,{id:'u1',name:'Fixture',email:null,localUser:true});
  if(path.startsWith('bookmarks/check')){
    const row=[...store.values()].find(b=>(b.url||b.content?.url)===url.searchParams.get('url'));
    if(service!=='linkding')return reply(200,{bookmarkId:row?.id||null});
    // routes.py check(): the page's metadata is loaded whether or not it is saved.
    const meta=scrapeMetadata(url.searchParams.get('url'));
    return reply(200,{bookmark:row?serialize(row):null,metadata:{url:url.searchParams.get('url'),title:meta.title,description:meta.description,preview_image:null},auto_tags:[]});
  }
  if(path==='tags/'||path==='tags')return reply(200,service==='linkding'?{count:0,next:null,results:[]}:{tags:[]});
  if(path==='lists'&&req.method==='GET')return reply(200,{lists:listCreated?[list]:[]});
  if(path==='lists'&&req.method==='POST'){listCreated=true;return reply(201,list);}
  if(path==='lists/later1')return reply(200,list);
  if(path.startsWith('lists/later1/bookmarks/')){
    if(req.method==='PUT')membership.add(path.split('/').pop());else membership.delete(path.split('/').pop());return reply(204);
  }
  if(/^bookmarks\/?$/.test(path)){
    // queries.py query_bookmarks: newest first unless the request sorts otherwise.
    if(req.method==='GET')return reply(200,service==='linkding'?{count:store.size,next:null,previous:null,results:[...store.values()].sort((a,b)=>(Date.parse(b.date_added)||0)-(Date.parse(a.date_added)||0)).map(serialize)}:{bookmarks:[...store.values()],nextCursor:null});
    const race=raceCreates.get(service+':'+data.url);
    if(race){store.set(String(race.record.id),structuredClone(race.record));return reply(race.status,race.record);}
    if(service==='linkding'){
      // linkding v1.47 POST (serializers.py create, services/bookmarks.py):
      // an existing URL is merged into (201, same id, date_added kept, tags
      // replaced); omitted fields take the model defaults. Unless the query
      // has disable_scraping, the server then fills an empty title and an
      // empty Description from the page it fetches itself.
      const now=serverNow(),found=[...store.values()].find(b=>b.url===data.url);
      // services/bookmarks.py: merging into an existing URL fails in
      // update_bookmark before anything is saved; a new bookmark is saved
      // before its tags, outside a transaction, and stays without them.
      const tagError=tooLongForPostgres(data.tag_names);
      if(down.linkding||tagError&&found)return serverError();
      const row=found||{id:Math.max(0,...[...store.keys()].map(Number).filter(Number.isFinite))+1,url:data.url,web_archive_snapshot_url:null,is_archived:false,date_added:now};
      Object.assign(row,{title:data.title===undefined?'':data.title,description:data.description===undefined?'':data.description,notes:data.notes===undefined?'':data.notes,
        unread:data.unread===undefined?false:data.unread,shared:data.shared===undefined?false:data.shared,tag_names:tagError||data.tag_names===undefined?[]:data.tag_names,date_modified:now});
      if(!url.searchParams.has('disable_scraping')){
        const meta=scrapeMetadata(row.url);
        if(!row.title)row.title=meta.title||'';
        if(!row.description)row.description=meta.description||'';
      }
      store.set(String(row.id),row);
      if(tagError)return serverError();
      return reply(201,serialize(row));
    }
    const id='b'+(store.size+1);
    // Hand-authored API record schema, independently filled from HTTP input.
    const row={id,title:data.title,note:data.note,summary:null,archived:false,favourited:false,createdAt:'2026-10-01T00:00:00Z',userId:'u1',tags:[],content:{type:'link',url:data.url,title:'Site title'},assets:[]};
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
  if(req.method==='PATCH'&&service==='linkding'&&holdLinkdingPatch) await holdLinkdingPatch;
  if(req.method==='PATCH'&&service==='linkding'){
    if(down.linkding||tooLongForPostgres(data.tag_names))return serverError();
    // serializers.py update(): only the writable fields that were sent change
    // (tags are kept when omitted); update_bookmark() stamps date_modified.
    for(const key of ['url','title','description','notes','is_archived','unread','shared','tag_names'])if(data[key]!==undefined)row[key]=data[key];
    row.date_modified=serverNow();
    return reply(200,serialize(row));
  }
  if(req.method==='PATCH')Object.assign(row,data);
  return reply(200,service==='linkding'?serialize(row):row);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port;
// The same pages under a name the extension is never granted, so it cannot read them.
const unreadOrigin='http://localhost:'+server.address().port;
// URL cleaning leaves IP hosts and the bare `localhost` alone as OAuth-like
// (shared.js _isOAuthCallback), and plain HTTP is only ever granted for those
// loopback names (manifest optional_host_permissions). A page meant to be
// cleaned is therefore an https one: the browser never reaches the network (see
// the route in the cleaning case), the grant is the manifest's https wildcard.
const cleanOrigin='https://cleaning.test';
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
    const hosts=bucket.explicit_host ||= [];for(const granted of [origin,cleanOrigin])if(!hosts.includes(granted+'/*'))hosts.push(granted+'/*');
  }
  writeFileSync(prefsPath,JSON.stringify(prefs));ctx=await launch();worker=await getWorker(ctx);await worker.evaluate(()=>primeSettings());
  ctx.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  await ctx.route(/^https:\/\//,route=>route.abort());
  assert(await worker.evaluate(origin=>chrome.permissions.contains({origins:[origin+'/*']}),origin));
  const article=await ctx.newPage();await article.goto(origin+'/article');
  const pageUrl='chrome-extension://'+extId+'/';
  const linkdingCreates=since=>requests.slice(since).filter(r=>r.service==='linkding'&&r.method==='POST'&&r.path==='bookmarks/');
  const draftFor=pageUrl=>worker.evaluate(async url=>Object.values(await chrome.storage.session.get(null)).find(row=>row?.pageUrl===url)?.draft||null,pageUrl);
  const openOnTab=async()=>{await article.bringToFront();const opened=ctx.waitForEvent('page');await worker.evaluate(url=>chrome.tabs.create({url,active:false}),pageUrl+'popup.html');const popup=await opened;
    await popup.waitForFunction(()=>typeof _popupDraftContext!=='undefined'&&_popupDraftContext?.ready===true&&!document.getElementById('submit-btn').disabled);
    await popup.evaluate(()=>{settings.optAutoCloseAfterSave=false;});return popup;};
  const settled=(popup,status)=>popup.waitForFunction(status=>bookmarkLookup.status===status,status);
  // Between blocks of a filtered run: everything a block may leave behind in
  // the worker, the server fixture and the browser, so a block never depends on
  // the one before it. Every block runs it, in a full run too, so a full run is exactly the blocks' lone runs in order.
  const resetForBlock=async()=>{
    await worker.evaluate(async()=>{
      statusCache.clear();
      const rows=await chrome.storage.session.get(null);
      const drafts=Object.entries(rows).filter(([,row])=>row?.pageUrl).map(([key])=>key);
      if(drafts.length)await chrome.storage.session.remove(drafts);
      await chrome.storage.local.set({offlineQueue:[]});await chrome.storage.local.remove('urlClean');
    });
    for(const page of ctx.pages())if(page!==article)await page.close();
    records.linkding.clear();records.karakeep.clear();membership.clear();raceCreates.clear();
    postgres.linkding=false;down.linkding=false;gate.linkding=false;holdLinkdingPatch=null;
    await article.goto(origin+'/article');
  };
  // The connection a block needs, made through the settings page like a user.
  const ensureConnected=async service=>{
    const current=await worker.evaluate(()=>pbpReadBookmarkConnection());
    if(current.service===service&&current.account)return;
    const options=await ctx.newPage();await options.goto(pageUrl+'options.html');
    await options.locator(`input[name="bookmark-service"][value="${service}"]`).check();
    await options.locator('#opt-'+service+'-url').fill(origin+'/'+service+'/');
    await options.locator('#opt-'+service+'-token').fill('fixture-key');
    await options.locator('#connect-'+service).click();
    await options.locator('#connect-'+service+'-status').filter({hasText:'Connected'}).waitFor({timeout:10000});
    await until(()=>options.evaluate(async service=>{const c=await pbpReadBookmarkConnection();return c.service===service&&!!c.account;},service),service+' connection persisted');
    await options.close();
  };
  let blockIndex=0;
  async function block(name,needs,run){
    assert.equal(BLOCKS[blockIndex++],name,'runtime blocks drifted from the BLOCKS list');
    if(!selected(name))return;
    await resetForBlock();for(const service of needs)await ensureConnected(service);
    await run();
  }
  await block('archive explanation and JSON restore',[],async()=>{
  const backupPage=await ctx.newPage();await backupPage.goto(pageUrl+'options.html');
  // The archive explanation follows the selected service immediately, before
  // any Connect or Save, and switching back must hide it again.
  const archiveHint=backupPage.locator('#wayback-selfhosted-private-hint');
  assert.equal(await archiveHint.count(),1,'self-hosted archive explanation is missing');
  for(const service of ['pinboard','karakeep','linkding','pinboard']){
    await backupPage.locator('#tab-general').click();
    await backupPage.locator(`input[name="bookmark-service"][value="${service}"]`).check();
    await backupPage.locator('#tab-archive').click();
    assert.equal(await archiveHint.isVisible(),service!=='pinboard',service+' archive explanation visibility');
  }
  console.log('archive explanation follows Pinboard / Karakeep / linkding selection and hides on return');
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
  });
  let personalOwner;
  await block('services: connect, save, reader',[],async()=>{
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
    if(service==='linkding') assert.equal(await options.evaluate(async()=>JSON.parse(deobfuscateKey((await pbpReadSettingsWithSecrets(SETTINGS_DEFAULTS)).linkdingToken)).sharing),true,'Connect did not persist the non-secret sharing capability');
    await options.close();await article.bringToFront();
    const popupPromise=ctx.waitForEvent('page');
    await worker.evaluate(url=>chrome.tabs.create({url,active:false}),pageUrl+'popup.html');
    let popup=await popupPromise;await popup.waitForLoadState();
    await popup.locator('#main-section:not(.hidden)').waitFor({timeout:10000}).catch(async error=>{console.error({errors,popupUrl:popup.url(),body:(await popup.locator('body').innerText()).slice(0,1200),connection:await popup.evaluate(async()=>{const c=await pbpReadBookmarkConnection();return {service:c.service,connected:!!c.account};})});throw error;});
    await popup.waitForFunction(()=>typeof _popupDraftContext!=='undefined'&&_popupDraftContext?.ready===true&&!document.getElementById('submit-btn').disabled);
    if(service==='linkding'){
      assert(await popup.locator('#private-check').isHidden());assert(await popup.locator('#share-check').isVisible());assert(!await popup.locator('#share-check').isChecked());
      await popup.keyboard.press('Alt+p');assert(await popup.locator('#private-check').isChecked(),'Alt+P toggled hidden supported Private');assert(!await popup.locator('#share-check').isChecked(),'Alt+P changed visible Share');
      await popup.locator('#share-check').check();
      await until(()=>worker.evaluate(async()=>Object.values(await chrome.storage.session.get(null)).some(row=>row?.draft?.private===false&&row.draft.sharedExplicit===true)),'shared choice persisted in private draft field');
      await popup.close();await article.bringToFront();
      const reopened=ctx.waitForEvent('page');await worker.evaluate(url=>chrome.tabs.create({url,active:false}),pageUrl+'popup.html');popup=await reopened;
      await popup.waitForFunction(()=>typeof _popupDraftContext!=='undefined'&&_popupDraftContext?.ready===true&&!document.getElementById('submit-btn').disabled);
      assert(await popup.locator('#share-check').isChecked(),'reopening lost the shared draft choice');
      await popup.locator('#share-check').uncheck();
    }
    await popup.locator('#title-input').fill(service+' title');await popup.locator('#description-input').fill('My note');
    await popup.locator('#tags-input').fill('reading');await popup.locator('#tags-input').press('Enter');
    await popup.locator('#submit-btn').click();
    await until(()=>popup.evaluate(()=>document.getElementById('submit-btn').classList.contains('saved-success')),'popup save success').catch(async error=>{console.error({requests:requests.map(r=>({path:r.path,method:r.method})),status:await popup.locator('body').innerText()});throw error;});
    assert.equal(records[service].size,1,service+' popup did not save');
    if(service==='linkding'){
      const latestWrite=()=>requests.filter(r=>r.service==='linkding'&&['POST','PATCH'].includes(r.method)).at(-1);
      assert.equal(latestWrite().method,'POST');assert.equal(latestWrite().data.shared,false);
      // The popup read /article and knows it has no meta description: a known
      // empty Description, so linkding is asked not to scrape one in.
      assert.deepEqual([latestWrite().query,latestWrite().data.description],['?disable_scraping',''],'a read page without a meta description was left to linkding');
      const reopen=async()=>{await popup.close();await article.bringToFront();const event=ctx.waitForEvent('page');await worker.evaluate(url=>chrome.tabs.create({url,active:false}),pageUrl+'popup.html');popup=await event;await popup.waitForFunction(()=>document.getElementById('existing-banner')&&!document.getElementById('existing-banner').classList.contains('hidden')&&!document.getElementById('submit-btn').disabled);};
      await reopen();assert(!await popup.locator('#share-check').isChecked());
      await popup.evaluate(()=>{settings.optAutoCloseAfterSave=false;});
      await popup.locator('#share-check').check();await popup.locator('#submit-btn').click();await until(()=>latestWrite().data.shared===true,'popup changed sharing');
      await popup.waitForFunction(()=>!document.getElementById('submit-btn').classList.contains('loading'));
      assert.match(await popup.locator('#status-msg').textContent(),/saved/i,'popup did not confirm its completed save');
      [...records.linkding.values()][0].shared=false;
      await popup.locator('#title-input').fill('Second same-popup title edit');await popup.locator('#submit-btn').click();
      await until(()=>latestWrite().data.title==='Second same-popup title edit','second same-popup update');
      assert(!Object.hasOwn(latestWrite().data,'shared')&&![...records.linkding.values()][0].shared,'settled sharing intent leaked into later title edit');
      await popup.waitForFunction(()=>!document.getElementById('submit-btn').classList.contains('loading'));
      assert.match(await popup.locator('#status-msg').textContent(),/saved/i,'popup did not confirm its completed save');
      [...records.linkding.values()][0].shared=true;
      let releasePatch;
      holdLinkdingPatch=new Promise(resolve=>{releasePatch=resolve;});
      await popup.locator('#share-check').uncheck();
      const beforePending=requests.length;await popup.locator('#submit-btn').click();
      await until(()=>requests.length>beforePending&&latestWrite().data.shared===false,'held sharing PATCH');
      assert(await popup.locator('#share-check').isEnabled(),'sharing control unexpectedly disabled during delivery');
      await popup.locator('#share-check').check();await popup.locator('#share-check').uncheck();
      holdLinkdingPatch=null;releasePatch();
      await popup.waitForFunction(()=>!document.getElementById('submit-btn').classList.contains('loading'));
      assert.match(await popup.locator('#status-msg').textContent(),/saved/i,'popup did not confirm its completed save');
      assert(await popup.evaluate(()=>_linkdingSharedExplicit),'delivery cleared a later same-value sharing choice');
      [...records.linkding.values()][0].shared=true;
      await popup.locator('#title-input').fill('Apply later explicit choice');await popup.locator('#submit-btn').click();
      await until(()=>latestWrite().data.title==='Apply later explicit choice','later explicit choice delivery');
      assert.equal(latestWrite().data.shared,false,'later explicit choice was not delivered');
      await popup.waitForFunction(()=>!document.getElementById('submit-btn').classList.contains('loading'));
      assert.match(await popup.locator('#status-msg').textContent(),/saved/i,'popup did not confirm its completed save');
      assert(!await popup.evaluate(()=>_linkdingSharedExplicit),'latest settled choice was not consumed');
      [...records.linkding.values()][0].shared=true;

      await reopen();assert(await popup.locator('#share-check').isChecked(),'existing shared record was not filled');
      await popup.keyboard.press('Alt+p');assert(!await popup.locator('#private-check').isChecked()&&await popup.locator('#share-check').isChecked(),'Alt+P changed hidden Private on an existing shared record');
      [...records.linkding.values()][0].shared=false; // Another client unshares after this popup loaded.
      await popup.locator('#title-input').fill('Unrelated title edit');await popup.locator('#submit-btn').click();await until(()=>latestWrite().data.title==='Unrelated title edit','title-only update');assert(!Object.hasOwn(latestWrite().data,'shared'),'title update rewrote shared');
      assert.equal([...records.linkding.values()][0].shared,false,'untouched popup republished remote private bookmark');
      [...records.linkding.values()][0].shared=true;
      const merge=await worker.evaluate(url=>submitSaveIntent({mode:'merge',url,title:'Ignored',notes:'',tags:'extra',private:true,toread:false}),origin+'/article');assert.equal(merge.status,'saved');assert(!Object.hasOwn(latestWrite().data,'shared'),'merge rewrote shared');
    }
    await popup.close();
    const account=(await worker.evaluate(()=>getCurrentBookmarkAuth())).account;
    await worker.evaluate(async data=>chrome.storage.local.set({md_preview_data_services:{markdown:'# Runtime article\n\nA synthetic article for the reader.',title:'Runtime article',url:data.url,baseUrl:data.url,account:data.account,tags:[],description:'',source:'local',ts:Date.now()}}),{url:origin+'/article',account});
    const reader=await ctx.newPage();await reader.goto(pageUrl+'md-preview.html?k=services');
    await reader.waitForFunction(()=>document.getElementById('reader-bookmark-later')?.getAttribute('aria-busy')==='false');
    await reader.locator('#reader-bookmark-later').click();
    await reader.waitForFunction(()=>document.getElementById('reader-bookmark-later')?.getAttribute('aria-pressed')==='true');
    assert(service==='linkding'?[...records.linkding.values()][0].unread:membership.size===1);
    await reader.locator('#reader-bookmark-edit[aria-busy="false"]').click();
    await reader.locator('#reader-bookmark-editor:popover-open').waitFor();
    if(service==='karakeep')assert(await reader.locator('#reader-bookmark-private').isHidden());
    else {assert(await reader.locator('#reader-bookmark-private').isVisible());assert(await reader.locator('#reader-bookmark-private').isChecked());assert((await reader.locator('#reader-bookmark-private').locator('xpath=ancestor::label').textContent()).includes('Share'));assert(!Object.hasOwn(requests.filter(r=>r.service==='linkding'&&r.method==='PATCH').at(-1).data,'shared'),'reader Read Later changed sharing');}
    if(service==='linkding'){
      const latestPatch=()=>requests.filter(r=>r.service==='linkding'&&r.method==='PATCH').at(-1);
      const row=[...records.linkding.values()][0];row.shared=false;
      await reader.locator('#reader-bookmark-title').fill('Reader title-only edit');
      await reader.locator('#reader-bookmark-apply').click();
      await until(()=>latestPatch().data.title==='Reader title-only edit','reader title-only delivery');
      assert(!Object.hasOwn(latestPatch().data,'shared')&&!row.shared,'untouched reader republished remotely private bookmark');
      for(const desired of [true,false]){
        await reader.locator('#reader-bookmark-editor:popover-open').waitFor({state:'hidden'});
        // Closing the editor precedes the post-save refresh. Wait for the
        // operation to settle, otherwise edit() correctly ignores this click.
        await reader.locator('#reader-bookmark-edit[aria-busy="false"]').click();await reader.locator('#reader-bookmark-editor:popover-open').waitFor();
        await reader.locator('#reader-bookmark-private').setChecked(desired);
        const before=requests.length;await reader.locator('#reader-bookmark-apply').click();
        await until(()=>requests.length>before&&latestPatch().data.shared===desired,'reader explicit sharing delivery');
        assert.equal(row.shared,desired);
      }
      await reader.locator('#reader-bookmark-editor:popover-open').waitFor({state:'hidden'});
      await reader.locator('#reader-bookmark-edit[aria-busy="false"]').click();await reader.locator('#reader-bookmark-editor:popover-open').waitFor();
    }
    await reader.locator('#reader-bookmark-delete').click();await reader.locator('.confirm-yes').click();
    await reader.waitForFunction(()=>document.getElementById('reader-bookmark-status')?.textContent==='Bookmark deleted');
    assert.equal(records[service].size,0);await reader.close();
    assert.equal(await worker.evaluate(()=>pbpVocabCurrentOwner()),personalOwner);
    if(service==='karakeep'){
      // The real worker records a delivered summary block where the popup reads it back (ai-cache.js in the service worker).
      const owned=await worker.evaluate(async url=>{
        const notes='Auto notes\n\nA plain summary paragraph.',range={start:'Auto notes\n\n'.length,end:notes.length};
        const result=await submitSaveIntent({mode:'merge',url,title:'T',notes,tags:'',private:true,toread:false},{summaryRange:range});
        return {status:result.status,range,owned:await pbpAiLoadSummaryOwnership((await getCurrentBookmarkAuth()).account,url,notes)};
      },origin+'/article-summary');
      assert.equal(owned.status,'saved');assert.deepEqual(owned.owned,owned.range,'the worker did not record the delivered summary block');
      records.karakeep.clear();
    }
    console.log(service+': settings, popup save, reader Read Later/delete, shared vocabulary passed');
  }
  });
  await block('access gateway form',['linkding'],async()=>{
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
  });
  await block('linkding sharing capability',['linkding'],async()=>{
  // Old envelopes and disabled sharing expose no checkbox in either surface.
  const sharingCredential=await worker.evaluate(async()=>(await loadSettings()).linkdingToken);
  for(const capability of ['missing','disabled']){
    await worker.evaluate(async({credential,capability})=>{const value=JSON.parse(deobfuscateKey(credential));if(capability==='missing')delete value.sharing;else value.sharing=false;await persistSettings({linkdingToken:JSON.stringify(value)});},{credential:sharingCredential,capability});
    await article.bringToFront();const opened=ctx.waitForEvent('page');await worker.evaluate(url=>chrome.tabs.create({url,active:false}),pageUrl+'popup.html');const popup=await opened;
    await popup.waitForFunction(()=>typeof _popupDraftContext!=='undefined'&&_popupDraftContext?.ready===true&&!document.getElementById('submit-btn').disabled);
    assert(await popup.locator('#private-check').isHidden());assert(await popup.locator('#share-check').isHidden());assert(await popup.locator('#private-check').isChecked());await popup.keyboard.press('Alt+p');assert(await popup.locator('#private-check').isChecked(),'Alt+P toggled hidden legacy/disabled Private');await popup.close();
    const auth=await worker.evaluate(()=>getCurrentBookmarkAuth());const url=origin+'/article-'+capability;
    await worker.evaluate(async({account,url})=>chrome.storage.local.set({md_preview_data_sharing:{markdown:'# Fixture',title:'Sharing fixture',url,account,ts:Date.now()}}),{account:auth.account,url});
    const reader=await ctx.newPage();await reader.goto(pageUrl+'md-preview.html?k=sharing');await reader.waitForFunction(()=>document.getElementById('reader-bookmark-edit')?.getAttribute('aria-busy')==='false');await reader.locator('#reader-bookmark-edit').click();await reader.locator('#reader-bookmark-editor:popover-open').waitFor({timeout:5000}).catch(async error=>{console.error({capability,status:await reader.locator('#reader-bookmark-status').textContent(),errors,paths:requests.slice(-5).map(r=>r.path),state:await reader.evaluate(async()=>{const auth=await pbpReadBookmarkConnection();const result=await chrome.runtime.sendMessage({type:'mdReaderBookmarkState',account:auth.account});return {known:result?.known,reason:result?.reason};})});throw error;});assert(await reader.locator('#reader-bookmark-private').isHidden());await reader.close();
    // A forged/stale public choice cannot enable sharing on an unsupported connection.
    const created=await worker.evaluate(url=>submitSaveIntent({mode:'create',url,title:'T',notes:'',tags:'',private:false,toread:false}),url);assert.equal(created.status,'saved');assert.equal([...records.linkding.values()].find(row=>row.url===url).shared,false);
    const row=[...records.linkding.values()].find(row=>row.url===url);row.shared=true;
    const updated=await worker.evaluate(({url,time})=>submitSaveIntent({mode:'update',url,title:'Edit without sharing control',notes:'',tags:'',private:true,toread:false,time}),{url,time:row.date_added});assert.equal(updated.status,'saved');assert(!Object.hasOwn(requests.filter(r=>r.service==='linkding'&&r.method==='PATCH').at(-1).data,'shared'));assert.equal(row.shared,true);records.linkding.delete(String(row.id));
  }
  await worker.evaluate(async credential=>persistSettings({linkdingToken:credential}),sharingCredential);
  const publicUrl=origin+'/article-explicit-shared';
  assert.equal((await worker.evaluate(url=>submitSaveIntent({mode:'create',url,title:'Explicit share',notes:'',tags:'',private:false,toread:false,sharedExplicit:true}),publicUrl)).status,'saved');
  const publicRow=[...records.linkding.values()].find(row=>row.url===publicUrl);assert.equal(publicRow.shared,true,'enabled explicit new sharing was lost');records.linkding.delete(String(publicRow.id));
  console.log('linkding missing/disabled sharing: popup and reader controls hidden, new shared=false, existing shared=true preserved');
  });
  await block('Karakeep create race',[],async()=>{
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
  });
  await block('linkding merge and server dates',['linkding'],async()=>{
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
  });
  await block('linkding multi-line Description',['linkding'],async()=>{
  // A Description written elsewhere keeps its line breaks. The popup and the
  // reader show it as one line; a save that leaves that line alone must not
  // flatten it. Hand-written v1.47 record for a URL no lookup has cached yet.
  const multiUrl=origin+'/article-multiline', multiId='40', multiLine='First line\n\n  Second   line';
  await article.goto(multiUrl);
  records.linkding.set(multiId,{id:40,url:multiUrl,title:'Stored title',description:multiLine,notes:'Stored notes',web_archive_snapshot_url:'https://web.archive.org/web/20261030030122/'+multiUrl,favicon_url:null,preview_image_url:null,is_archived:false,unread:false,shared:false,tag_names:['kept'],date_added:'2026-10-30T03:01:22.656384Z',date_modified:'2026-10-30T03:01:22.656384Z',website_title:null,website_description:null});
  const multiPatches=()=>requests.filter(r=>r.service==='linkding'&&r.method==='PATCH'&&r.path==='bookmarks/'+multiId+'/');
  {
    await article.bringToFront();const opened=ctx.waitForEvent('page');await worker.evaluate(url=>chrome.tabs.create({url,active:false}),pageUrl+'popup.html');const popup=await opened;
    await popup.waitForFunction(()=>document.getElementById('existing-banner')&&!document.getElementById('existing-banner').classList.contains('hidden')&&!document.getElementById('submit-btn').disabled);
    await popup.evaluate(()=>{settings.optAutoCloseAfterSave=false;});
    assert.equal(await popup.locator('#linkding-description-input').inputValue(),'First line Second line','the popup did not show the stored Description as one line');
    // Another client rewrites the Description after the popup loaded it, and
    // again after the popup's first update. A tag-only update leaves it alone
    // each time: the popup compares with the line it showed, so it neither
    // flattens the stored value nor writes back the one it loaded.
    const elsewhere=['Changed\n\n  elsewhere','Changed  again'];
    Object.assign(records.linkding.get(multiId),{description:elsewhere[0],date_modified:serverNow()});
    await popup.locator('#tags-input').fill('added');await popup.locator('#tags-input').press('Enter');
    let before=multiPatches().length;await popup.locator('#submit-btn').click();
    await until(()=>multiPatches().length>before,'popup tag-only update');
    assert(!Object.hasOwn(multiPatches().at(-1).data,'description'),'a tag-only popup update rewrote the Description');
    assert.equal(records.linkding.get(multiId).description,elsewhere[0],'a tag-only popup update flattened or overwrote the Description');
    assert.deepEqual(records.linkding.get(multiId).tag_names,['kept','added']);
    await popup.waitForFunction(()=>!document.getElementById('submit-btn').classList.contains('loading'));
    Object.assign(records.linkding.get(multiId),{description:elsewhere[1],date_modified:serverNow()});
    await popup.locator('#tags-input').fill('again');await popup.locator('#tags-input').press('Enter');
    before=multiPatches().length;await popup.locator('#submit-btn').click();
    await until(()=>multiPatches().length>before,'second popup tag-only update');
    assert(!Object.hasOwn(multiPatches().at(-1).data,'description'),'a second tag-only popup update wrote the Description it loaded');
    assert.equal(records.linkding.get(multiId).description,elsewhere[1],'a second tag-only popup update overwrote a Description changed elsewhere');
    await popup.waitForFunction(()=>!document.getElementById('submit-btn').classList.contains('loading'));
    await popup.locator('#linkding-description-input').fill('Edited   description ');
    before=multiPatches().length;await popup.locator('#submit-btn').click();
    await until(()=>multiPatches().length>before,'popup Description edit');
    assert.equal(multiPatches().at(-1).data.description,'Edited description','an edited Description was not written as its one line');
    await popup.waitForFunction(()=>!document.getElementById('submit-btn').classList.contains('loading'));
    await popup.close();
  }
  // A draft keeps only a Description the user or an AI summary wrote; the one
  // the lookup filled in is read again on the next open. A draft that kept the
  // loaded line restored it as the user's: the lookup then left the box alone
  // and the save overwrote a Description changed elsewhere in the meantime.
  {
    // Drop the worker's cached lookups, as five minutes or a worker restart
    // would, so the reopened popup reads what the server holds now.
    const clearLookups=()=>worker.evaluate(()=>statusCache.clear());
    const storedDraft=()=>worker.evaluate(async url=>Object.values(await chrome.storage.session.get(null)).find(row=>row?.pageUrl===url)?.draft||null,multiUrl);
    const openPopup=async()=>{await article.bringToFront();const opened=ctx.waitForEvent('page');await worker.evaluate(url=>chrome.tabs.create({url,active:false}),pageUrl+'popup.html');const popup=await opened;
      await popup.waitForFunction(()=>document.getElementById('existing-banner')&&!document.getElementById('existing-banner').classList.contains('hidden')&&!document.getElementById('submit-btn').disabled);return popup;};
    Object.assign(records.linkding.get(multiId),{description:multiLine,date_modified:serverNow()});await clearLookups();
    assert.equal(await storedDraft(),null,'an earlier popup left a draft of this page');
    let popup=await openPopup();
    assert.equal(await popup.locator('#linkding-description-input').inputValue(),'First line Second line');
    await popup.locator('#title-input').fill('Drafted title');
    await until(async()=>(await storedDraft())?.title==='Drafted title','title edit drafted');
    assert(!Object.hasOwn(await storedDraft(),'summary'),'the draft kept the Description the lookup filled in');
    await popup.close();
    const elsewhere='Changed\n\n  in another client';
    Object.assign(records.linkding.get(multiId),{description:elsewhere,date_modified:serverNow()});await clearLookups();
    popup=await openPopup();await popup.evaluate(()=>{settings.optAutoCloseAfterSave=false;});
    assert.equal(await popup.locator('#title-input').inputValue(),'Drafted title','the title draft was not restored');
    assert.equal(await popup.locator('#linkding-description-input').inputValue(),'Changed in another client','the reopened popup did not show the current Description');
    const before=multiPatches().length;await popup.locator('#submit-btn').click();
    await until(()=>multiPatches().length>before,'update from a restored title draft');
    assert.equal(multiPatches().at(-1).data.title,'Drafted title');
    assert(!Object.hasOwn(multiPatches().at(-1).data,'description'),'a restored title draft rewrote the Description');
    assert.equal(records.linkding.get(multiId).description,elsewhere,'a restored draft overwrote a Description changed elsewhere');
    await popup.waitForFunction(()=>!document.getElementById('submit-btn').classList.contains('loading'));
    await popup.close();
  }
  records.linkding.get(multiId).description=multiLine;
  {
    const account=(await worker.evaluate(()=>getCurrentBookmarkAuth())).account;
    await worker.evaluate(async data=>chrome.storage.local.set({md_preview_data_multiline:{markdown:'# Runtime article',title:'Runtime article',url:data.url,baseUrl:data.url,account:data.account,tags:[],description:'',source:'local',ts:Date.now()}}),{url:multiUrl,account});
    const reader=await ctx.newPage();await reader.goto(pageUrl+'md-preview.html?k=multiline');
    await reader.locator('#reader-bookmark-edit[aria-busy="false"]').click();await reader.locator('#reader-bookmark-editor:popover-open').waitFor();
    assert.equal(await reader.locator('#reader-bookmark-summary').inputValue(),'First line Second line','the reader did not show the stored Description as one line');
    await reader.locator('#reader-bookmark-title').fill('Reader title edit');
    const before=multiPatches().length;await reader.locator('#reader-bookmark-apply').click();
    await until(()=>multiPatches().length>before,'reader title-only update');
    assert.equal(multiPatches().at(-1).data.title,'Reader title edit');
    assert(!Object.hasOwn(multiPatches().at(-1).data,'description'),'a title-only reader edit rewrote the Description');
    assert.equal(records.linkding.get(multiId).description,multiLine,'a title-only reader edit flattened the Description');
    // Only a Description the user changed is sent, as the one line the editor shows.
    await reader.locator('#reader-bookmark-edit[aria-busy="false"]').click();await reader.locator('#reader-bookmark-editor:popover-open').waitFor();
    await reader.locator('#reader-bookmark-summary').fill('Reader   edited ');
    const beforeEdit=multiPatches().length;await reader.locator('#reader-bookmark-apply').click();
    await until(()=>multiPatches().length>beforeEdit,'reader Description edit');
    assert.equal(multiPatches().at(-1).data.description,'Reader edited','an edited reader Description was not written as its one line');
    await reader.close();
  }
  records.linkding.delete(multiId);await article.goto(origin+'/article');
  console.log('linkding multi-line Description: tag-only popup updates keep it, also after a change elsewhere; a reopened title draft shows and keeps the current one; a title-only reader update keeps it; an edit writes its one line');
  });
  // A tag longer than PostgreSQL's 64-character column, typed in the popup:
  // the error names it, nothing is queued or offered for a retry, and the
  // form keeps the tag and the bookmark the create left behind, so a shorter
  // tag of 64 code points (128 UTF-16 units) updates that bookmark.
  await block('linkding over-long tag',['linkding'],async()=>{
    postgres.linkding=true;
    const tagUrl=origin+'/article-tag-limit', long='research-'+'x'.repeat(56), fits='\u{1F600}'.repeat(64);
    const en=JSON.parse(readFileSync(new URL('../_locales/en/messages.json',import.meta.url),'utf8'));
    const expected=en.bookmarkErrTagTooLong.message.replace('$TAG$',[...long].slice(0,40).join('')+'…').replace('$MAX$','64');
    await article.goto(tagUrl);await article.bringToFront();
    const opened=ctx.waitForEvent('page');await worker.evaluate(url=>chrome.tabs.create({url,active:false}),pageUrl+'popup.html');const popup=await opened;
    await popup.waitForFunction(()=>typeof _popupDraftContext!=='undefined'&&_popupDraftContext?.ready===true&&!document.getElementById('submit-btn').disabled);
    await popup.evaluate(()=>{settings.optAutoCloseAfterSave=false;});
    await popup.locator('#tags-input').fill(long);await popup.locator('#tags-input').press('Enter');
    await popup.locator('#submit-btn').click();
    const card=popup.locator('.feedback-card .fc-message').filter({hasText:'64'});
    await card.waitFor({timeout:10000}).catch(async error=>{console.error({body:(await popup.locator('body').innerText()).slice(0,800),errors});throw error;});
    assert.equal((await card.textContent()).trim(),expected);
    const errorCard=popup.locator('.feedback-card',{has:popup.locator('.fc-message',{hasText:'64'})});
    assert.equal(await errorCard.count(),1,JSON.stringify(await popup.locator('.feedback-card').allInnerTexts()));
    assert.equal(await errorCard.locator('.fc-actions button').count(),0,'an over-long tag offered a Retry that fails the same way: '+JSON.stringify(await popup.locator('.feedback-card').allInnerTexts()));
    assert.deepEqual(await worker.evaluate(async()=>(await chrome.storage.local.get('offlineQueue')).offlineQueue||[]),[],'an over-long tag was queued for replay');
    const kept=[...records.linkding.values()].find(row=>row.url===tagUrl);
    assert(kept,'the PostgreSQL create left no bookmark');assert.deepEqual(kept.tag_names,[]);
    await popup.waitForFunction(()=>!document.getElementById('existing-banner').classList.contains('hidden'));
    assert.deepEqual(await popup.locator('#tags-display .tag-item').allTextContents(),[long],'the form lost the tag to shorten');
    await popup.locator('#tags-input').press('Backspace');
    await popup.locator('#tags-input').fill(fits);await popup.locator('#tags-input').press('Enter');
    const before=requests.length;await popup.locator('#submit-btn').click();
    await until(()=>JSON.stringify(kept.tag_names)===JSON.stringify([fits]),'the shortened tag updated the kept bookmark');
    assert.deepEqual(requests.slice(before).filter(r=>r.service==='linkding'&&r.method!=='GET').map(r=>[r.method,r.path]),[['PATCH','bookmarks/'+kept.id+'/']],'the shortened save did not update the kept bookmark once');
    // The same server page with tags that fit is an outage: queued for retry.
    down.linkding=true;
    await popup.locator('#tags-input').fill('work');await popup.locator('#tags-input').press('Enter');
    await popup.locator('#submit-btn').click();
    const queuedCard=popup.locator('.feedback-card[data-variant="warning"] .fc-message');
    await queuedCard.waitFor({timeout:10000});
    assert.equal((await queuedCard.textContent()).trim(),en.saveQueuedServer.message);
    const queue=await worker.evaluate(async()=>(await chrome.storage.local.get('offlineQueue')).offlineQueue||[]);
    assert.deepEqual(queue.map(item=>[item.url,item.tags]),[[tagUrl,fits+' work']],'a server error without an over-long tag was not queued');
    await worker.evaluate(()=>chrome.storage.local.set({offlineQueue:[]}));down.linkding=false;
    await popup.close();records.linkding.delete(String(kept.id));postgres.linkding=false;
    await worker.evaluate(()=>statusCache.clear());await article.goto(origin+'/article');
    console.log('linkding over-long tag on PostgreSQL: the 500 names the tag, nothing is queued or offered for retry, the form updates the kept bookmark with a 64-code-point tag, and the same 500 without an over-long tag is queued');
  });
  // A page the extension may not read (the localhost name was never granted)
  // leaves the popup nothing to vouch for: the create sends no Description
  // and no disable_scraping, and linkding fills in the page's own meta
  // description. The reader has no page description of its own either, so a
  // reader save without a popup draft does the same.
  await block('linkding unknown Description',['linkding'],async()=>{
  {
    const unreadUrl=unreadOrigin+'/article-meta';
    await article.goto(unreadUrl);await article.bringToFront();
    const opened=ctx.waitForEvent('page');await worker.evaluate(url=>chrome.tabs.create({url,active:false}),pageUrl+'popup.html');const popup=await opened;
    await popup.waitForFunction(()=>typeof _popupDraftContext!=='undefined'&&_popupDraftContext?.ready===true&&!document.getElementById('submit-btn').disabled);
    await popup.evaluate(()=>{settings.optAutoCloseAfterSave=false;});
    assert.equal(await popup.locator('#url-input').inputValue(),unreadUrl);
    assert.equal(await popup.locator('#linkding-description-input').inputValue(),'','the popup showed a Description it could not read');
    const before=requests.length;await popup.locator('#submit-btn').click();
    await until(()=>linkdingCreates(before).length>0,'popup create for an unread page');
    const create=linkdingCreates(before)[0];
    assert.equal(create.query,'','an unread page still asked linkding not to scrape');
    assert(!Object.hasOwn(create.data,'description'),'an unread page sent a Description');
    const row=[...records.linkding.values()].find(b=>b.url===unreadUrl);
    assert.equal(row?.description,'Server-scraped description','linkding did not fill in the Description itself');
    await popup.waitForFunction(()=>!document.getElementById('submit-btn').classList.contains('loading'));
    await popup.close();records.linkding.delete(String(row.id));
  }
  {
    const readerUrl=origin+'/article-meta?reader';
    const account=(await worker.evaluate(()=>getCurrentBookmarkAuth())).account;
    await worker.evaluate(async data=>chrome.storage.local.set({md_preview_data_scrape:{markdown:'# Meta article',title:'Meta article',url:data.url,baseUrl:data.url,account:data.account,tags:[],description:'',source:'local',ts:Date.now()}}),{url:readerUrl,account});
    const reader=await ctx.newPage();await reader.goto(pageUrl+'md-preview.html?k=scrape');
    const before=requests.length;await reader.locator('#reader-bookmark-save[aria-busy="false"]').click();
    await until(()=>linkdingCreates(before).length>0,'reader create without a popup draft');
    const create=linkdingCreates(before)[0];
    assert.equal(create.data.url,readerUrl);
    assert.equal(create.query,'','a reader save without a Description asked linkding not to scrape');
    assert(!Object.hasOwn(create.data,'description'),'a reader save invented a Description');
    const row=[...records.linkding.values()].find(b=>b.url===readerUrl);
    assert.equal(row?.description,'Server-scraped description','linkding did not fill in the reader save Description');
    await reader.close();records.linkding.delete(String(row.id));
  }
  await article.goto(origin+'/article');
  console.log('linkding unknown Description: an unread popup page and a draft-free reader save let linkding scrape it');
  });
  // Before the Description became optional, every save without one wrote "",
  // pages the extension could not read included, so a queued "" is ambiguous:
  // known empty or never read. Replay cannot tell them apart and keeps what
  // those versions did: an explicit empty Description sent with
  // disable_scraping, not "unknown" for linkding to scrape. Hand-written
  // storage shape; the account binding is the connection identity the queue keeps.
  await block('linkding queued empty Description',['linkding'],async()=>{
    const queuedUrl=origin+'/article-meta?queued-empty';
    const account=(await worker.evaluate(()=>getCurrentBookmarkAuth())).account;
    const record={queueId:'legacy-empty',queuedAt:1,account,mode:'merge',url:queuedUrl,title:'Queued title',notes:'',summary:'',tags:'queued',private:true,toread:false};
    await worker.evaluate(async item=>chrome.storage.local.set({offlineQueue:[item]}),record);
    const before=requests.length;
    const outcome=await worker.evaluate(()=>retryOfflineItem('legacy-empty'));
    assert.equal(outcome.ok,true,'the queued record was not delivered: '+JSON.stringify(outcome));
    const create=linkdingCreates(before)[0];
    assert.equal(create?.data.url,queuedUrl);
    assert.equal(create.query,'?disable_scraping','a queued empty Description let linkding scrape');
    assert(Object.hasOwn(create.data,'description')&&create.data.description==='','a queued empty Description was not sent as empty');
    const row=[...records.linkding.values()].find(b=>b.url===queuedUrl);
    assert.equal(row?.description,'','a queued "" did not stay an explicit empty Description');
    records.linkding.delete(String(row.id));
    assert.deepEqual(await worker.evaluate(async()=>(await chrome.storage.local.get('offlineQueue')).offlineQueue||[]),[],'the delivered record stayed queued');
    console.log('linkding queued empty Description: a record queued with "" replays as an explicit empty Description');
  });
  // A draft made by editing a recent bookmark is kept for the tab the popup was
  // opened on but holds that bookmark's URL. The tab's meta description is the
  // tab's, not that bookmark's: once the bookmark is gone (deleted elsewhere)
  // the restored form creates it again and must leave the Description to
  // linkding, which reads the page it is given. The same draft on the tab's own
  // URL still takes the meta description, as a first open does.
  await block('linkding restored draft for another URL',['linkding'],async()=>{
    const tabUrl=origin+'/article-meta', recentUrl=origin+'/article-recent', recentId='50';
    records.linkding.set(recentId,{id:50,url:recentUrl,title:'Recent title',description:'Stored recent description',notes:'',web_archive_snapshot_url:null,favicon_url:null,preview_image_url:null,is_archived:false,unread:false,shared:false,tag_names:['kept'],date_added:serverNow(),date_modified:serverNow(),website_title:null,website_description:null});
    await worker.evaluate(()=>chrome.storage.local.set({optShowRecent:true}));
    await article.goto(tabUrl);
    let popup=await openOnTab();
    assert.equal(await popup.locator('#linkding-description-input').inputValue(),'Server-scraped description','a first open did not take its own page description');
    // The list is newest first, so the bookmark made for this case leads it.
    await popup.locator('.recent-bm-row:has(a[href="'+recentUrl+'"]) .recent-bm-edit').click({timeout:8000}).catch(async error=>{console.error({recent:await popup.locator('#recent-bookmarks a').evaluateAll(links=>links.map(a=>a.getAttribute('href'))),errors});throw error;});
    await popup.waitForFunction(()=>document.getElementById('title-input').value==='Recent title'&&!document.getElementById('existing-banner').classList.contains('hidden'));
    assert.equal(await popup.locator('#linkding-description-input').inputValue(),'Stored recent description','editing a recent bookmark did not show its stored Description');
    await popup.locator('#tags-input').fill('drafted');await popup.locator('#tags-input').press('Enter');
    await until(async()=>{const d=await draftFor(tabUrl);return d?.url===recentUrl&&d.tags.includes('drafted');},'recent-bookmark edit drafted for the tab');
    assert(!Object.hasOwn(await draftFor(tabUrl),'summary'),'the draft kept the Description the lookup filled in');
    await popup.close();
    records.linkding.delete(recentId);await worker.evaluate(()=>statusCache.clear());
    popup=await openOnTab();
    assert.equal(await popup.locator('#url-input').inputValue(),recentUrl,'the draft for the tab was not restored');
    await settled(popup,'missing');
    assert.equal(await popup.locator('#linkding-description-input').inputValue(),'',"the tab's description filled another bookmark's Description");
    const before=requests.length;await popup.locator('#submit-btn').click();
    await until(()=>linkdingCreates(before).length>0,'create from the restored recent-bookmark draft');
    const create=linkdingCreates(before)[0];
    assert.equal(create.data.url,recentUrl);
    assert.equal(create.query,'',"the restored draft told linkding not to read the bookmark's own page");
    assert(!Object.hasOwn(create.data,'description'),"the tab's description was sent for another bookmark");
    assert.equal([...records.linkding.values()].find(b=>b.url===recentUrl)?.description,'Recent page description','linkding did not fill in the bookmark Description itself');
    await popup.waitForFunction(()=>!document.getElementById('submit-btn').classList.contains('loading'));
    await popup.close();
    // The same draft shape on the tab's own URL: the meta description still fills the box.
    assert.equal(await draftFor(tabUrl),null,'the delivered recent-bookmark draft was still stored for the tab');
    popup=await openOnTab();
    await popup.locator('#title-input').fill('Same page draft');
    await until(async()=>(await draftFor(tabUrl))?.title==='Same page draft','title edit drafted on the tab itself');
    assert(!Object.hasOwn(await draftFor(tabUrl),'summary'),"the tab's own description was drafted as the user's");
    await popup.close();
    popup=await openOnTab();await settled(popup,'missing');
    assert.equal(await popup.locator('#title-input').inputValue(),'Same page draft','the title draft was not restored');
    assert.equal(await popup.locator('#linkding-description-input').inputValue(),'Server-scraped description','a draft on the tab itself lost its page description');
    const beforeOwn=requests.length;await popup.locator('#submit-btn').click();
    await until(()=>linkdingCreates(beforeOwn).length>0,'create from the restored same-page draft');
    const own=linkdingCreates(beforeOwn)[0];
    assert.deepEqual([own.data.url,own.query,own.data.description],[tabUrl,'?disable_scraping','Server-scraped description'],'a same-page create did not send its known Description');
    await popup.waitForFunction(()=>!document.getElementById('submit-btn').classList.contains('loading'));
    await popup.close();
    for(const row of [...records.linkding.values()].filter(b=>b.url===tabUrl||b.url===recentUrl))records.linkding.delete(String(row.id));
    await worker.evaluate(()=>chrome.storage.local.set({optShowRecent:false}));await article.goto(origin+'/article');
    console.log("linkding restored draft for another URL: the tab's description stays out of the Description, linkding reads the bookmark itself; the tab's own draft still takes it");
  });
  // The box is filled for the page the popup opened on, and that page owns the
  // text. An address typed over it afterwards names another page: a create for
  // it must leave the Description to linkding (no text, no ?disable_scraping),
  // which reads that page itself, not save this page's meta description onto
  // it. Typing the page's own address back (a fragment makes no other page)
  // returns the text, and a Description the lookup filled in for a stored
  // bookmark stays whatever address is typed after it.
  await block('linkding address typed after open',['linkding'],async()=>{
    const tabUrl=origin+'/article-meta', awayUrl=origin+'/article-recent', otherUrl=origin+'/article-away';
    const box=popup=>popup.locator('#linkding-description-input').inputValue();
    const createFrom=async(popup,label)=>{const before=requests.length;await popup.locator('#submit-btn').click();await until(()=>linkdingCreates(before).length>0,label);
      await popup.waitForFunction(()=>!document.getElementById('submit-btn').classList.contains('loading'));return linkdingCreates(before)[0];};
    await worker.evaluate(()=>statusCache.clear());
    await article.goto(tabUrl);
    let popup=await openOnTab();
    assert.equal(await box(popup),'Server-scraped description','a first open did not take its own page description');
    await popup.locator('#url-input').fill(awayUrl);
    assert.equal(await box(popup),'',"the tab's description stayed in the box of an address typed over it");
    const away=await createFrom(popup,'create for an address typed over the page');
    assert.equal(away.data.url,awayUrl);
    assert.equal(away.query,'',"an address typed over the page told linkding not to read it");
    assert(!Object.hasOwn(away.data,'description'),"the tab's description was sent for another page");
    assert.equal([...records.linkding.values()].find(b=>b.url===awayUrl)?.description,'Recent page description','linkding did not fill in the typed page Description itself');
    await popup.close();
    assert.equal(await draftFor(tabUrl),null,'the delivered draft was still stored for the tab');
    popup=await openOnTab();
    await popup.locator('#url-input').fill(otherUrl);
    assert.equal(await box(popup),'',"the tab's description stayed in the box of a second address");
    await popup.locator('#url-input').fill(tabUrl+'#intro');
    assert.equal(await box(popup),'Server-scraped description',"typing the page's own address back did not return its description");
    await popup.locator('#url-input').fill(tabUrl);
    const back=await createFrom(popup,'create after typing the page address back');
    assert.deepEqual([back.data.url,back.query,back.data.description],[tabUrl,'?disable_scraping','Server-scraped description'],"a create on the page's own address did not send its known Description");
    await popup.close();
    // The bookmark just made stores the very text the page has. Opened again the
    // lookup shows it as the bookmark's own Description, and typing another
    // address leaves it with the bookmark's title and tags.
    popup=await openOnTab();await settled(popup,'found');
    assert.equal(await box(popup),'Server-scraped description','a reopened popup did not show the stored Description');
    await popup.locator('#url-input').fill(otherUrl);
    assert.equal(await box(popup),'Server-scraped description',"an address typed over a stored bookmark took its Description out");
    await popup.evaluate(()=>pbpDiscardPopupDraft());
    assert.equal(await draftFor(tabUrl),null,'the typed address stayed drafted for the tab');
    await popup.close();
    for(const row of [...records.linkding.values()].filter(b=>[tabUrl,awayUrl,otherUrl].includes(b.url)))records.linkding.delete(String(row.id));
    await worker.evaluate(()=>statusCache.clear());await article.goto(origin+'/article');
    console.log("linkding address typed after the popup opened: another page leaves the Description to linkding, the page's own address brings its text back, a stored Description stays");
  });
  // URL cleaning can remove more than the same-page check ignores: aggressive
  // mode takes off ref and source, a custom parameter whatever was listed. The
  // popup puts the cleaned address of its own page in the form, and that is
  // still the page it was opened on: a first open and a restored draft of it
  // take the page's meta description and send it with ?disable_scraping, as an
  // address that needed no cleaning does.
  await block('linkding cleaned page address',['linkding'],async()=>{
    const cleanedUrl=cleanOrigin+'/article-meta', tabUrl=cleanedUrl+'?ref=abc&campaign=spring';
    const meta=pageMetadata('/article-meta');
    await ctx.route(cleanOrigin+'/**',route=>route.fulfill({status:200,contentType:'text/html',body:'<html><head><title>'+meta.title+'</title><meta name="description" content="'+meta.description+'"></head><body><h1>'+meta.title+'</h1></body></html>'}));
    await worker.evaluate(()=>chrome.storage.local.set({urlClean:{enabled:true,onPopupOpen:true,onPaste:true,aggressiveMode:true,customParams:['campaign'],excludeParams:[]}}));
    const createFrom=async(popup,label)=>{const before=requests.length;await popup.locator('#submit-btn').click();await until(()=>linkdingCreates(before).length>0,label);
      await popup.waitForFunction(()=>!document.getElementById('submit-btn').classList.contains('loading'));await popup.close();return linkdingCreates(before)[0];};
    await article.goto(tabUrl);
    let popup=await openOnTab();
    assert.equal(await popup.locator('#url-input').inputValue(),cleanedUrl,'the popup did not clean the address of its own page');
    assert.equal(await popup.locator('#linkding-description-input').inputValue(),'Server-scraped description',"cleaning the address kept its own page's description out of the box");
    await popup.locator('#title-input').fill('Cleaned page draft');
    await until(async()=>(await draftFor(tabUrl))?.title==='Cleaned page draft','title edit drafted on the cleaned page');
    const drafted=await draftFor(tabUrl);
    assert.equal(drafted.url,cleanedUrl,'the draft did not keep the cleaned address');
    assert(!Object.hasOwn(drafted,'summary'),"the page's own description was drafted as the user's");
    await popup.close();
    popup=await openOnTab();await settled(popup,'missing');
    assert.equal(await popup.locator('#title-input').inputValue(),'Cleaned page draft','the title draft was not restored');
    assert.equal(await popup.locator('#url-input').inputValue(),cleanedUrl,'the restored draft lost the cleaned address');
    assert.equal(await popup.locator('#linkding-description-input').inputValue(),'Server-scraped description','a restored draft of the cleaned page lost its page description');
    const create=await createFrom(popup,'create from the restored draft of a cleaned page');
    assert.deepEqual([create.data.url,create.query,create.data.description],[cleanedUrl,'?disable_scraping','Server-scraped description'],'a create from the cleaned page did not send its known Description');
    for(const row of [...records.linkding.values()].filter(b=>b.url===cleanedUrl))records.linkding.delete(String(row.id));
    // Cleaning settings the popup cannot apply (customParams not a list, as a
    // hand-edited storage or an old backup can leave it): opening runs every
    // cleaning step of showMain, and the form must still open, keep the page's
    // own address, log the failure and save.
    await worker.evaluate(()=>{statusCache.clear();return chrome.storage.local.set({urlClean:{enabled:true,onPopupOpen:true,onPaste:true,aggressiveMode:true,customParams:'campaign',excludeParams:[]}});});
    await worker.evaluate(async()=>{const drafts=Object.entries(await chrome.storage.session.get(null)).filter(([,row])=>row?.pageUrl).map(([key])=>key);if(drafts.length)await chrome.storage.session.remove(drafts);});
    const warnings=[],onPage=page=>page.on('console',message=>{if(message.type()==='warning')warnings.push(message.text());});
    ctx.on('page',onPage);
    try{
      const errorsBefore=errors.length;
      popup=await openOnTab();
      assert.equal(await popup.locator('#url-input').inputValue(),tabUrl,'unusable cleaning settings did not leave the page address as it was');
      assert(warnings.some(text=>text.includes('URL cleaning failed')&&text.includes('TypeError')),'the cleaning failure was not logged: '+JSON.stringify(warnings));
      assert.equal(errors.length,errorsBefore,'opening with unusable cleaning settings threw: '+errors.slice(errorsBefore).join('; '));
      const create=await createFrom(popup,'create with unusable cleaning settings');
      assert.equal(create.data.url,tabUrl,'the form opened on unusable cleaning settings did not save the page address');
    }finally{ctx.off('page',onPage);}
    for(const row of [...records.linkding.values()].filter(b=>b.url===tabUrl))records.linkding.delete(String(row.id));
    await worker.evaluate(()=>{statusCache.clear();return chrome.storage.local.remove('urlClean');});
    await article.goto(origin+'/article');await ctx.unroute(cleanOrigin+'/**');
    console.log("linkding page address cleaned by aggressive mode and a custom parameter: a first open and a restored draft still take the page's description and send it with ?disable_scraping; unusable cleaning settings leave the address as it is and the form saves");
  });
  await block('linkding Description server semantics',['linkding'],async()=>{
  // linkding Description against the server's own v1.47 create and update
  // semantics (the mock above). /article-meta publishes a meta description,
  // so a create the server may scrape picks it up by itself.
  const descriptionUrl=origin+'/article-meta', emptyDescriptionUrl=origin+'/article-meta?empty', customDescriptionUrl=origin+'/article-meta?custom';
  const descriptionStart=requests.length;
  const descriptions=await worker.evaluate(async({origin,url,emptyUrl,customUrl})=>{
    const client=pbpCreateBookmarkServiceClient({service:'linkding',baseUrl:origin+'/linkding/',beforeRequest:async()=>({token:'fixture-key'})});
    const fields={url,title:'T',notes:'My note',tags:[]};
    const unknown=await client.save(fields);
    const empty=await client.save({...fields,url:emptyUrl,summary:''});
    const custom=await client.save({...fields,url:customUrl,summary:'Custom description'});
    const summaries=[];let existing=custom.bookmark;
    for(const summary of [undefined,'Custom description','Changed description','']){
      const result=await client.save({...fields,url:customUrl,summary},existing);summaries.push(result.bookmark.summary);existing=result.bookmark;
    }
    return {unknown:unknown.bookmark,empty:empty.bookmark,custom:custom.bookmark,summaries,post:pbpBookmarkAsPost(custom.bookmark)};
  },{origin,url:descriptionUrl,emptyUrl:emptyDescriptionUrl,customUrl:customDescriptionUrl});
  const descriptionCalls=requests.slice(descriptionStart), customPatch=['PATCH','bookmarks/'+descriptions.custom.id+'/',''];
  assert.deepEqual(descriptionCalls.map(r=>[r.method,r.path,r.query]),[['POST','bookmarks/',''],['POST','bookmarks/','?disable_scraping'],['POST','bookmarks/','?disable_scraping'],customPatch,customPatch,customPatch,customPatch]);
  assert(!Object.hasOwn(descriptionCalls[0].data,'description'),'an unknown Description was sent');
  assert.deepEqual(descriptionCalls.slice(1,3).map(r=>r.data.description),['','Custom description']);
  assert.deepEqual(descriptionCalls.slice(3).map(r=>Object.hasOwn(r.data,'description')),[false,false,true,true]);
  assert.equal(descriptionCalls[5].data.description,'Changed description');assert.equal(descriptionCalls[6].data.description,'');
  // Only the create that sent nothing reads back what linkding scraped.
  assert.deepEqual([descriptions.unknown.summary,descriptions.empty.summary,descriptions.custom.summary],['Server-scraped description','','Custom description']);
  assert.deepEqual(descriptions.summaries,['Custom description','Custom description','Changed description','']);
  assert.deepEqual([descriptions.post.description,descriptions.post.extended,descriptions.post.summary],['T','My note','Custom description']);
  for(const bookmark of [descriptions.unknown,descriptions.empty,descriptions.custom])records.linkding.delete(String(bookmark.id));
  console.log('linkding Description: known creates disable scraping, an unknown one is scraped; unchanged/changed/cleared PATCH and independent post projection passed');
  });
  await block('gateway probes',[],async()=>{
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
  });
  assert.equal(errors.length,0,errors.join('\n'));
  assert(requests.every(r=>r.service==='linkding'||r.service==='karakeep'));
  assert.equal(blockIndex,BLOCKS.length,'a runtime block is missing from the script');
  console.log('bookmark service runtime smoke passed; synthetic loopback APIs only');
  if(filterNote)console.log(filterNote);
}finally{
  if(ctx)await ctx.close();await new Promise(r=>server.close(r));rmSync(profile,{recursive:true,force:true});
}
