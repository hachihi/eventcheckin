/* HACHIHI EVENT CHECK-IN
 * Cloudflare Workers + D1 + R2. Independent from the attendance Worker.
 * Required bindings: DB (D1). Optional: PHOTOS (R2). Without R2, photos are stored in Google Drive through the Apps Script web app (key prefix 'drive:').
 * Required secrets: SESSION_SECRET, ADMIN_PASSWORD, MACHINE_API_KEY, GOOGLE_CLIENT_ID, APPS_SCRIPT_SECRET
 */
const enc = new TextEncoder();
const json = (data, status=200, headers={}) => new Response(JSON.stringify(data), {status, headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers}});
const html = (body) => new Response(body,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
const esc = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const slugify = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').replace(/Đ/g,'d').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60);
const now = () => new Date(Date.now()+7*3600000).toISOString().slice(0,19).replace('T',' ');
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));
const hex = b => [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256',enc.encode(s)));
const rand = n => crypto.getRandomValues(new Uint8Array(n));
const emailNorm = s => String(s||'').trim().toLowerCase();
const validEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s||''));
const safeFile = s => String(s||'photo').replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,90);
const safeEq=(a,b)=>{a=String(a||'');b=String(b||'');let r=a.length^b.length;const n=Math.max(a.length,b.length);for(let i=0;i<n;i++)r|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return r===0};
const fmtTime=ms=>new Date(ms+7*3600000).toISOString().slice(0,19).replace('T',' ');
const MEM={ev:new Map(),disp:new Map()};
async function cachedEvent(env,slug,ttl=30000){const c=MEM.ev.get(slug);if(c&&c.until>Date.now())return c.e;const e=await eventBySlug(env,slug);if(e){if(MEM.ev.size>200)MEM.ev.clear();MEM.ev.set(slug,{e,until:Date.now()+ttl})}return e}
const cooldownMs=env=>Math.max(5,Number(env.REPEAT_COOLDOWN_SEC)||30)*1000;
const dupResp=r=>json({error:'Bạn đã check-in lúc '+((r.previous&&r.previous.checkin_time)||'trước đó'),duplicate:true,previous:r.previous||null},409);
// Structured logs (one JSON object per line) -> Cloudflare Workers Logs. Never log keys, passwords, emails or photo data.
const log=(evt,data,level)=>{try{(level==='error'?console.error:level==='warn'?console.warn:console.log)(JSON.stringify({evt,t:fmtTime(Date.now()),...data}))}catch(e){}};
async function audit(env,me,action,detail){try{await env.DB.prepare('INSERT INTO audit_logs(admin,action,detail,created_at) VALUES(?,?,?,?)').bind(me?me.username:'system',action,String(detail||'').slice(0,500),now()).run()}catch(e){}}

async function hashPassword(password, saltHex) {
  const salt = saltHex ? Uint8Array.from(saltHex.match(/../g).map(x=>parseInt(x,16))) : rand(16);
  const key = await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);
  const bits = await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:150000,hash:'SHA-256'},key,256);
  return hex(salt)+':'+hex(bits);
}
async function verifyPassword(password, stored) {
  if(!stored || !stored.includes(':')) return false;
  const [salt] = stored.split(':');
  return await hashPassword(password,salt) === stored;
}
async function hmac(env, value) {
  const key = await crypto.subtle.importKey('raw',enc.encode(env.SESSION_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return hex(await crypto.subtle.sign('HMAC',key,enc.encode(value)));
}
async function sessionCookie(env,id) {
  const exp=Date.now()+7*864e5, payload=id+'.'+exp;
  return `hch_event=${payload}.${await hmac(env,payload)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`;
}
async function admin(req,env) {
  const m=(req.headers.get('cookie')||'').match(/(?:^|; )hch_event=([^;]+)/); if(!m)return null;
  const [id,exp,sig]=m[1].split('.'); if(!id||Date.now()>Number(exp)||!sig)return null;
  if(await hmac(env,id+'.'+exp)!==sig)return null;
  return env.DB.prepare('SELECT id,username,role FROM admins WHERE id=?').bind(Number(id)).first();
}
async function requireAdmin(req,env) { const u=await admin(req,env); if(!u)throw Object.assign(new Error('Vui lòng đăng nhập quản trị'),{status:401}); return u; }
const V3=[
  'ALTER TABLE checkins ADD COLUMN idem_key TEXT',
  'ALTER TABLE login_logs ADD COLUMN ok INTEGER DEFAULT 1',
  'ALTER TABLE sheet_sources ADD COLUMN content_hash TEXT',
  'CREATE TABLE IF NOT EXISTS audit_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,admin TEXT,action TEXT NOT NULL,detail TEXT,created_at TEXT NOT NULL)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_checkins_idem ON checkins(event_id,idem_key) WHERE idem_key IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS idx_checkins_event_attendee ON checkins(event_id,attendee_id,id)',
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_attendees_auto_code ON attendees(event_id,attendee_code) WHERE attendee_code LIKE 'AUTO-%'",
  'CREATE INDEX IF NOT EXISTS idx_login_logs_fail ON login_logs(ok,created_at)',
  'DROP INDEX IF EXISTS idx_checkins_event_time',
  'DROP INDEX IF EXISTS idx_attendees_event_email'
];
// Fallback only: normal path is `wrangler d1 migrations apply` (0001-0003). Runs when a probe shows the schema is incomplete.
async function ensureSchema(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS admins(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'admin',created_at TEXT NOT NULL)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,slug TEXT UNIQUE NOT NULL,name TEXT NOT NULL,event_date TEXT,venue TEXT,logo_url TEXT,banner_url TEXT,primary_color TEXT DEFAULT '#b89454',welcome_title TEXT DEFAULT 'Chào mừng Quý khách',welcome_message TEXT DEFAULT 'Cảm ơn bạn đã tham dự sự kiện',allow_walkin INTEGER DEFAULT 1,allow_repeat INTEGER DEFAULT 0,active INTEGER DEFAULT 1,created_at TEXT NOT NULL)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS attendees(id INTEGER PRIMARY KEY AUTOINCREMENT,event_id INTEGER NOT NULL,full_name TEXT NOT NULL,attendee_code TEXT,email TEXT,phone TEXT,company TEXT,position TEXT,photo_key TEXT,photo_url TEXT,registration_source TEXT DEFAULT 'manual',created_at TEXT NOT NULL,UNIQUE(event_id,email))`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS checkins(id INTEGER PRIMARY KEY AUTOINCREMENT,event_id INTEGER NOT NULL,attendee_id INTEGER,full_name TEXT NOT NULL,email TEXT,company TEXT,checkin_time TEXT NOT NULL,machine TEXT,gmail TEXT,source TEXT NOT NULL,result TEXT NOT NULL DEFAULT 'success',photo_key TEXT,photo_url TEXT,raw_json TEXT)`).run();
  try{await env.DB.prepare('ALTER TABLE attendees ADD COLUMN attendee_code TEXT').run()}catch(e){}
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_attendees_event_email ON attendees(event_id,email)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_attendees_event_name ON attendees(event_id,full_name)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_attendees_event_code ON attendees(event_id,attendee_code)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_checkins_event_id ON checkins(event_id,id)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_checkins_event_time ON checkins(event_id,checkin_time)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sync_outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,checkin_id INTEGER NOT NULL UNIQUE,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER DEFAULT 0,next_try INTEGER DEFAULT 0,last_error TEXT,created_at TEXT NOT NULL)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS login_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT,ip TEXT,created_at TEXT)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sheet_sources(id INTEGER PRIMARY KEY AUTOINCREMENT,event_id INTEGER NOT NULL UNIQUE,spreadsheet_id TEXT NOT NULL,gid TEXT NOT NULL DEFAULT '0',sheet_url TEXT NOT NULL,last_sync_at TEXT,last_error TEXT,created_at TEXT NOT NULL)`).run();
  for(const s of V3){try{await env.DB.prepare(s).run()}catch(e){if(!/duplicate column|already exists/i.test(String(e.message)))throw e}}
}
async function init(env) {
  let ready=false;
  try{await env.DB.batch([env.DB.prepare('SELECT idem_key FROM checkins LIMIT 0'),env.DB.prepare('SELECT ok FROM login_logs LIMIT 0'),env.DB.prepare('SELECT content_hash FROM sheet_sources LIMIT 0'),env.DB.prepare('SELECT 1 FROM audit_logs LIMIT 0'),env.DB.prepare('SELECT 1 FROM admins LIMIT 0')]);ready=true}catch(e){}
  if(!ready){log('schema_fallback',{},'warn');await ensureSchema(env)}
  if(env.ADMIN_USERNAME && env.ADMIN_PASSWORD) {
    const count=await env.DB.prepare('SELECT COUNT(*) n FROM admins').first();
    if(!count.n) await env.DB.prepare('INSERT INTO admins(username,password_hash,role,created_at) VALUES(?,?,?,?)').bind(env.ADMIN_USERNAME,await hashPassword(env.ADMIN_PASSWORD),'admin',now()).run();
  }
}
async function eventBySlug(env,slug) { return env.DB.prepare('SELECT * FROM events WHERE slug=? AND active=1').bind(slug).first(); }
async function getEventId(env,slug) { const e=await eventBySlug(env,slug); if(!e)throw Object.assign(new Error('Không tìm thấy sự kiện hoặc sự kiện đã khóa'),{status:404}); return e; }
function publicEvent(e){return {id:e.id,slug:e.slug,name:e.name,event_date:e.event_date,venue:e.venue,logo_url:e.logo_url,banner_url:e.banner_url,primary_color:e.primary_color,welcome_title:e.welcome_title,welcome_message:e.welcome_message};}
const driveOn=env=>!!(env.APPS_SCRIPT_URL&&env.APPS_SCRIPT_SECRET);
const DRIVE_ID=/(?:\/d\/|[?&]id=)([A-Za-z0-9_-]{20,})/;
const driveThumb=id=>'https://drive.google.com/thumbnail?id='+id+'&sz=w900';
// Upload an image to Google Drive via the Apps Script web app (action "photo"). Returns the key 'drive:<fileId>' or null.
async function driveUpload(env,b64,mime){
  const res=await fetch(env.APPS_SCRIPT_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({secret:env.APPS_SCRIPT_SECRET,action:'photo',mime,data:b64}),redirect:'follow',signal:AbortSignal.timeout(25000)});
  const txt=(await res.text()).trim(),m=txt.match(/^ok ([A-Za-z0-9_-]{20,})$/);
  if(!res.ok||!m){log('drive_upload_error',{status:res.status,msg:txt.slice(0,120)},'error');throw new Error('Drive upload failed: '+txt.slice(0,120))}
  return 'drive:'+m[1];
}
const toB64=buf=>{let s='';const u=new Uint8Array(buf);for(let i=0;i<u.length;i+=0x8000)s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));return btoa(s)};
async function putPhoto(env,file,eventId) {
  if(!file || !file.size) return null;
  if(file.size>6*1024*1024) throw new Error('Ảnh tối đa 6 MB');
  const type=file.type||'application/octet-stream';
  if(!['image/jpeg','image/png','image/webp'].includes(type)) throw new Error('Chỉ nhận ảnh JPG, PNG hoặc WEBP');
  if(!env.PHOTOS){
    if(!driveOn(env))return null;   // no photo storage configured: check-in still succeeds without a photo
    try{return await driveUpload(env,toB64(await file.arrayBuffer()),type)}catch(e){return null}
  }
  const ext=type==='image/png'?'png':type==='image/webp'?'webp':'jpg';
  const key=`events/${eventId}/attendees/${crypto.randomUUID()}.${ext}`;
  await env.PHOTOS.put(key,file.stream(),{httpMetadata:{contentType:type,cacheControl:'public, max-age=31536000, immutable'}});
  return key;
}
function photoUrl(key,env){if(!key)return '';if(key.startsWith('drive:'))return driveThumb(key.slice(6));return String(env.PUBLIC_BASE_URL||'').replace(/\/$/,'')+'/media/'+key;}
async function findDuplicate(env,e,a,idem){
  if(idem){const r=await env.DB.prepare('SELECT id,checkin_time FROM checkins WHERE event_id=? AND idem_key=?').bind(e.id,idem).first();if(r)return r}
  if(!a)return null;
  if(e.allow_repeat)return env.DB.prepare("SELECT id,checkin_time FROM checkins WHERE event_id=? AND attendee_id=? AND result='success' AND checkin_time>? ORDER BY id DESC LIMIT 1").bind(e.id,a.id,fmtTime(Date.now()-cooldownMs(env))).first();
  return env.DB.prepare('SELECT id,checkin_time FROM checkins WHERE event_id=? AND attendee_id=? ORDER BY id DESC LIMIT 1').bind(e.id,a.id).first();
}
// Atomic, idempotent check-in. One D1 batch (= one transaction): the guard (NOT EXISTS) and the INSERT are a single
// statement, so two concurrent requests for the same guest can never both insert. Retries carrying the same idempotency
// key hit the unique index idx_checkins_idem and are ignored. The Sheets outbox row is written in the same batch.
async function addCheckin(env,ctx,{event,attendee,name,email,company,machine,gmail,source,photoKey,photoUrl:external,raw,idem}) {
  const t0=Date.now(),time=fmtTime(t0),idemKey=idem||null;
  const pk=(attendee&&attendee.photo_key) || photoKey || null;
  const pu=pk?photoUrl(pk,env):(external || (attendee&&attendee.photo_url) || '');
  let rawJson=JSON.stringify(raw||{});if(rawJson.length>2000)rawJson=JSON.stringify({truncated:true});
  let guard='',gp=[];
  if(attendee){
    if(event.allow_repeat){guard=" AND NOT EXISTS(SELECT 1 FROM checkins WHERE event_id=? AND attendee_id=? AND result='success' AND checkin_time>?)";gp=[event.id,attendee.id,fmtTime(t0-cooldownMs(env))]}
    else{guard=" AND NOT EXISTS(SELECT 1 FROM checkins WHERE event_id=? AND attendee_id=? AND result='success')";gp=[event.id,attendee.id]}
  }
  const stmts=[env.DB.prepare("INSERT OR IGNORE INTO checkins(event_id,attendee_id,full_name,email,company,checkin_time,machine,gmail,source,result,photo_key,photo_url,raw_json,idem_key) SELECT ?,?,?,?,?,?,?,?,?,'success',?,?,?,? WHERE 1=1"+guard)
    .bind(event.id,attendee?attendee.id:null,name,email||null,company||null,time,machine||'',gmail||'',source,pk,pu,rawJson,idemKey,...gp)];
  const sheetsOn=!!(env.APPS_SCRIPT_URL&&env.APPS_SCRIPT_SECRET);
  if(sheetsOn){
    const payload={event_id:event.id,event_slug:event.slug,event_name:event.name,attendee_id:attendee?attendee.id:null,full_name:name,email:email||'',company:company||'',checkin_time:time,machine:machine||'',gmail:gmail||'',source,result:'success',photo_url:pu};
    stmts.push(env.DB.prepare("INSERT INTO sync_outbox(checkin_id,payload,status,next_try,created_at) SELECT last_insert_rowid(),?,'pending',?,? WHERE changes()>0").bind(JSON.stringify(payload),Date.now(),time));
  }
  const res=await env.DB.batch(stmts),meta=res[0].meta;
  if(!meta.changes){
    const previous=await findDuplicate(env,event,attendee,idemKey);
    if(photoKey&&!photoKey.startsWith('drive:')&&env.PHOTOS&&ctx)ctx.waitUntil(env.PHOTOS.delete(photoKey).catch(()=>{}));
    log('checkin',{result:'duplicate',event_id:event.id,attendee_id:attendee?attendee.id:null,source,machine:machine||'',prev_id:previous?previous.id:null,ms:Date.now()-t0});
    return {duplicate:true,previous:previous||null,name,email,company};
  }
  log('checkin',{result:'success',event_id:event.id,attendee_id:attendee?attendee.id:null,source,machine:machine||'',id:meta.last_row_id,ms:Date.now()-t0});
  return {success:true,id:meta.last_row_id,time,attendee_id:attendee?attendee.id:null,name,email,company,photo_url:pu,source};
}
// Batched delivery to Google Sheets (reporting copy). Never on the check-in path; driven by the 1-minute cron.
async function drainOutbox(env,limit=200) {
  if(!env.APPS_SCRIPT_URL||!env.APPS_SCRIPT_SECRET)return {sent:0,failed:0,skipped:true};
  const rows=(await env.DB.prepare("SELECT id,checkin_id,payload,attempts FROM sync_outbox WHERE status='pending' AND next_try<=? ORDER BY id LIMIT ?").bind(Date.now(),limit).all()).results;
  let sent=0,failed=0;
  for(let i=0;i<rows.length;i+=100){
    const chunk=rows.slice(i,i+100);
    try{
      const res=await fetch(env.APPS_SCRIPT_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({secret:env.APPS_SCRIPT_SECRET,rows:chunk.map(r=>({...JSON.parse(r.payload),checkin_id:r.checkin_id}))}),redirect:'follow',signal:AbortSignal.timeout(25000)});
      const txt=(await res.text()).trim();if(!res.ok||!/^ok/i.test(txt))throw new Error('Apps Script '+res.status+' '+txt.slice(0,160));
      await env.DB.batch(chunk.map(r=>env.DB.prepare("UPDATE sync_outbox SET status='sent',last_error=NULL WHERE id=?").bind(r.id)));sent+=chunk.length;
    }catch(e){
      log('outbox_error',{msg:String(e.message).slice(0,200),rows:chunk.length},'error');
      await env.DB.batch(chunk.map(r=>{const n=(r.attempts||0)+1;return env.DB.prepare('UPDATE sync_outbox SET status=?,attempts=?,next_try=?,last_error=? WHERE id=?').bind(n>=25?'dead':'pending',n,Date.now()+Math.min(6*3600e3,Math.pow(2,Math.min(n,10))*30000),String(e.message).slice(0,300),r.id)}));failed+=chunk.length;
    }
  }
  if(rows.length)log('outbox',{sent,failed,pending_batch:rows.length},failed?'warn':'log');
  return {sent,failed};
}
async function googleKeys(env,force=false) {
  const cached=globalThis.__gkeys; if(!force&&cached&&cached.until>Date.now())return cached.keys;
  const r=await fetch('https://www.googleapis.com/oauth2/v3/certs'); if(!r.ok)throw new Error('Không lấy được khóa Google');
  const keys=(await r.json()).keys||[]; globalThis.__gkeys={keys,until:Date.now()+3600000}; return keys;
}
async function verifyGoogle(env,credential,nonce) {
  if(!env.GOOGLE_CLIENT_ID)throw Object.assign(new Error('Chưa cấu hình GOOGLE_CLIENT_ID'),{status:501});
  const p=String(credential||'').split('.'); if(p.length!==3)throw Object.assign(new Error('Google credential không hợp lệ'),{status:401});
  let h,c; try{h=JSON.parse(new TextDecoder().decode(unb64u(p[0])));c=JSON.parse(new TextDecoder().decode(unb64u(p[1])));}catch{throw Object.assign(new Error('Google credential không hợp lệ'),{status:401});}
  if(h.alg!=='RS256'||!h.kid)throw Object.assign(new Error('Google credential không hợp lệ'),{status:401});
  let jwk=(await googleKeys(env)).find(k=>k.kid===h.kid); if(!jwk)jwk=(await googleKeys(env,true)).find(k=>k.kid===h.kid);
  if(!jwk)throw Object.assign(new Error('Không xác minh được chữ ký Google'),{status:401});
  const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  const ok=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,unb64u(p[2]),enc.encode(p[0]+'.'+p[1]));
  const audiences=String(env.GOOGLE_CLIENT_ID).split(',').map(x=>x.trim());
  if(!ok||!audiences.includes(c.aud)||!['accounts.google.com','https://accounts.google.com'].includes(c.iss)||c.exp*1000<Date.now()-60000||!c.email_verified||c.nonce!==nonce)throw Object.assign(new Error('Phiên Google không hợp lệ hoặc hết hạn'),{status:401});
  return c;
}
function makeNonce(env){const raw=hex(rand(16)),exp=Date.now()+5*60e3;return hmac(env,raw+'.'+exp).then(sig=>raw+'.'+exp+'.'+sig);}
async function checkNonce(env,value){const [raw,exp,sig]=String(value||'').split('.');if(!raw||Date.now()>Number(exp)||await hmac(env,raw+'.'+exp)!==sig)throw Object.assign(new Error('Nonce không hợp lệ, vui lòng tải lại trang'),{status:400});}

let initPromise;
const APP = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#101a2b"><title>HACHIHI EVENT CHECK-IN</title><style>
:root{--navy:#101a2b;--navy2:#17263c;--gold:#c6a56b;--cream:#f6f3ed;--muted:#718096;--line:#e8e5df;--green:#16865b}*{box-sizing:border-box}body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#f4f5f7;color:#1c2736}button,input,select,textarea{font:inherit}button{cursor:pointer;border:0;border-radius:12px;padding:12px 16px;background:var(--navy);color:white;font-weight:650}button.secondary{background:#e9edf2;color:#233247}button.gold{background:var(--gold);color:#1b2431}input,select,textarea{width:100%;padding:12px 13px;border:1px solid #dce1e7;border-radius:11px;background:white;color:#1d2939;outline:none}input:focus,select:focus{border-color:var(--gold);box-shadow:0 0 0 3px #c6a56b22}.shell{max-width:1240px;margin:auto;padding:24px}.top{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:22px}.brand{font-weight:850;letter-spacing:.11em;color:var(--navy)}.brand small{display:block;font-size:10px;color:var(--gold);letter-spacing:.22em}.card{background:white;border:1px solid #e8ebef;border-radius:20px;padding:22px;box-shadow:0 8px 30px #1a29400a}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.stat{padding:20px;border-radius:17px;background:white;border:1px solid var(--line)}.stat b{font-size:30px;display:block;color:var(--navy)}.muted{color:var(--muted)}.row{display:flex;gap:10px;align-items:center}.between{justify-content:space-between}.stack{display:grid;gap:13px}.field{display:grid;gap:6px}.field label{font-size:13px;font-weight:700;color:#455468}.tablewrap{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:12px;border-bottom:1px solid #edf0f3;white-space:nowrap}th{font-size:12px;color:#718096;background:#fafbfc}.pill{display:inline-block;border-radius:999px;padding:5px 9px;background:#e8f6ef;color:#16734f;font-size:12px;font-weight:700}.tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}.tabs button{background:#e8ebef;color:#344256}.tabs button.on{background:var(--navy);color:white}.hidden{display:none!important}.error{color:#b42318;font-size:13px}.success{color:var(--green);font-weight:700}.hero{min-height:100vh;background:radial-gradient(circle at 78% 15%,#33445c 0,transparent 32%),linear-gradient(135deg,#0d1728,#172a43);color:white;display:flex;align-items:center;justify-content:center;text-align:center;padding:5vw;position:relative;overflow:hidden}.hero:before{content:"";position:absolute;inset:24px;border:1px solid #c6a56b55;pointer-events:none}.hero-inner{width:min(1100px,100%);position:relative}.hero-logo{max-height:82px;max-width:220px;object-fit:contain;margin-bottom:24px}.eyebrow{letter-spacing:.32em;text-transform:uppercase;color:#d8bd8b;font-size:12px}.hero h1{font-family:Georgia,serif;font-weight:500;font-size:clamp(38px,6vw,78px);margin:20px 0;color:#f8f4ec}.hero p{font-size:clamp(15px,2vw,22px);color:#d6deea}.ornament{width:110px;height:1px;background:var(--gold);margin:28px auto}.waiting{font-size:13px;letter-spacing:.22em;color:#d8bd8b;text-transform:uppercase;margin-top:50px}.guest{display:grid;grid-template-columns:270px 1fr;gap:42px;align-items:center;text-align:left;max-width:900px;margin:35px auto 0;animation:appear .55s ease both}.guest img{width:270px;height:310px;object-fit:cover;border-radius:18px;border:3px solid #c6a56b;box-shadow:0 20px 70px #0005}.guest h2{font-size:clamp(32px,5vw,58px);margin:0 0 12px;color:#fff}.guest .company{font-size:23px;color:#ddc99e}.ok{font-size:15px;letter-spacing:.2em;color:#b8e8ce;text-transform:uppercase}.recent{display:flex;justify-content:center;gap:10px;flex-wrap:wrap;margin-top:35px}.recent span{border:1px solid #ffffff30;border-radius:999px;padding:8px 14px;color:#d9e1eb;font-size:13px}@keyframes appear{from{opacity:0;transform:translateY(18px) scale(.98)}to{opacity:1;transform:none}}.checkin-page{min-height:100vh;background:linear-gradient(140deg,#101a2b,#243b56);display:grid;place-items:center;padding:20px}.checkin-card{width:min(560px,100%);background:#fff;border-radius:25px;padding:30px;box-shadow:0 25px 80px #0004}.checkin-card h1{font-family:Georgia,serif;font-size:32px;color:var(--navy);margin:0 0 8px}.checkin-card .field{margin:13px 0}.checkin-card button{width:100%;padding:15px}.preview{width:84px;height:84px;object-fit:cover;border-radius:50%;background:#eef1f4}.login{max-width:420px;margin:8vh auto}.actions{display:flex;gap:8px;flex-wrap:wrap}.small{font-size:12px}.avatar{width:38px;height:38px;border-radius:50%;object-fit:cover;background:#eef1f4}@media(max-width:760px){.shell{padding:14px}.grid{grid-template-columns:1fr}.guest{grid-template-columns:1fr;text-align:center;gap:20px}.guest img{width:190px;height:210px;margin:auto}.hero{padding:28px}.hero:before{inset:10px}.top{align-items:flex-start}.hide-mobile{display:none}}
.noimg{width:270px;height:310px;border:1px solid #c6a56b;border-radius:18px;display:grid;place-items:center;font-size:84px;color:#c6a56b;font-family:Georgia,serif;background:#ffffff0a}#conn{position:fixed;top:14px;right:18px;z-index:9;font-size:12px;letter-spacing:.12em;color:#d8bd8b;display:flex;gap:8px;align-items:center;opacity:.85}#conn i{width:9px;height:9px;border-radius:50%;background:#2ecc8f;display:inline-block}#conn.off i{background:#e5484d}#conn.off{color:#ffb4b4}.btn-busy{opacity:.6;pointer-events:none}@media(max-width:760px){.noimg{width:190px;height:210px;margin:auto;font-size:60px}}
</style></head><body><div id="app"></div><script>
const $=s=>document.querySelector(s), app=$('#app');let eventSlug=location.pathname.split('/')[2]||'',eventData=null,pollTimer=null,lastId=0,displayInit=false,displayQueue=[],displayBusy=false;
async function api(path,method='GET',data){let r=await fetch(path,{method,headers:data instanceof FormData?{}:{'content-type':'application/json'},body:data?(data instanceof FormData?data:JSON.stringify(data)):undefined,credentials:'same-origin'});let j=await r.json().catch(()=>({error:'Phản hồi máy chủ không hợp lệ'}));if(!r.ok)throw Error(j.error||'Có lỗi xảy ra');return j}
function msg(s,ok=false){let n=$('#msg');if(n){n.textContent=s;n.className=ok?'success':'error'}}
async function shrinkImage(file,max){max=max||900;try{if(!file.type.startsWith('image/')||file.size<250000)return file;const bmp=await createImageBitmap(file);const k=Math.min(1,max/Math.max(bmp.width,bmp.height));const c=document.createElement('canvas');c.width=Math.round(bmp.width*k);c.height=Math.round(bmp.height*k);c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',0.85));return blob?new File([blob],'photo.jpg',{type:'image/jpeg'}):file}catch(e){return file}}
function thanks(r){return '<div class="hero"><div class="hero-inner"><div class="eyebrow">CHECK-IN SUCCESSFUL</div><div class="ornament"></div><h1>Xin cảm ơn<br>'+esc(r.name)+'!</h1><p>'+esc(r.company||eventData.name)+'</p><div class="ornament"></div><p>'+esc(eventData.welcome_message||'Chúc bạn có trải nghiệm tuyệt vời tại sự kiện')+'</p><button class="gold" onclick="location.reload()">Check-in khách tiếp theo</button></div></div>'}
function header(title='HACHIHI EVENT CHECK-IN'){return '<div class="top"><div class="brand">HACHIHI <small>EVENT EXPERIENCE</small></div><div class="muted">'+title+'</div></div>'}
function renderLogin(){app.innerHTML='<div class="shell">'+header()+'<div class="card login stack"><div><div class="eyebrow">SECURE ADMINISTRATION</div><h1>Đăng nhập quản trị</h1><p class="muted">Quản lý sự kiện và khách tham dự</p></div><div class="field"><label>Tài khoản</label><input id="username" autocomplete="username"></div><div class="field"><label>Mật khẩu</label><input id="password" type="password" autocomplete="current-password"></div><div id="msg"></div><button id="login">Đăng nhập</button></div></div>';
$('#login').onclick=async()=>{try{await api('/api/admin/login','POST',{username:$('#username').value,password:$('#password').value});location.href='/admin'}catch(e){msg(e.message)}}}
function renderAdmin(){app.innerHTML='<div class="shell">'+header('<span id="adminName">Quản trị</span>')+'<div class="row between"><h1>Trung tâm điều hành</h1><button class="secondary" id="logout">Đăng xuất</button></div><div class="tabs"><button class="on" data-tab="overview">Tổng quan</button><button data-tab="events">Sự kiện</button><button data-tab="attendees">Khách tham dự</button><button data-tab="checkins">Lịch sử check-in</button></div><section id="overview" class="stack"><div class="grid"><div class="stat"><span class="muted">Tổng khách đăng ký</span><b id="sReg">—</b></div><div class="stat"><span class="muted">Đã check-in</span><b id="sIn">—</b></div><div class="stat"><span class="muted">Chưa đến</span><b id="sOut">—</b></div></div><div class="card"><div class="row between"><h3>Chọn sự kiện</h3><select id="eventSelect" style="max-width:360px"></select></div><div class="actions" id="eventLinks"></div><div class="tablewrap"><table><thead><tr><th>Khách vừa đến</th><th>Thời gian</th><th>Nguồn</th><th>Thiết bị</th></tr></thead><tbody id="recentRows"></tbody></table></div></div></section><section id="events" class="hidden stack"><div class="card"><h2>Tạo / cập nhật sự kiện</h2><div class="grid"><div class="field"><label>Tên sự kiện</label><input id="evName" placeholder="Hội nghị khách hàng 2026"></div><div class="field"><label>Mã URL (slug)</label><input id="evSlug" placeholder="hoi-nghi-khach-hang-2026"></div><div class="field"><label>Ngày tổ chức</label><input id="evDate" type="date"></div><div class="field"><label>Địa điểm</label><input id="evVenue"></div><div class="field"><label>Logo URL (tùy chọn)</label><input id="evLogo"></div><div class="field"><label>Banner URL (tùy chọn)</label><input id="evBanner"></div><div class="field"><label>Tiêu đề chào mừng</label><input id="evWelcome" value="Chào mừng Quý khách"></div><div class="field"><label>Lời cảm ơn</label><input id="evMessage" value="Cảm ơn bạn đã tham dự sự kiện"></div></div><div class="actions" style="margin-top:14px"><label><input id="evWalkin" type="checkbox" checked style="width:auto"> Cho phép khách vãng lai</label><label><input id="evRepeat" type="checkbox" style="width:auto"> Cho phép check-in nhiều lần</label></div><button id="saveEvent" style="margin-top:16px">Lưu sự kiện</button><div id="eventMsg"></div></div><div class="card"><h3>Danh sách sự kiện</h3><div class="tablewrap"><table><thead><tr><th>Sự kiện</th><th>Ngày</th><th>Khách</th><th>Trạng thái</th><th>Liên kết</th><th></th></tr></thead><tbody id="eventRows"></tbody></table></div></div></section><section id="attendees" class="hidden stack"><div class="card"><h2>Kết nối Google Sheets</h2><p class="muted">Dán link Sheet đang nhận câu trả lời từ Google Form. Worker sẽ nhập ngay và tự đồng bộ định kỳ mỗi 5 phút.</p><div class="field"><label>Link Google Sheet</label><input id="sheetUrl" placeholder="https://docs.google.com/spreadsheets/d/.../edit#gid=0"></div><div class="actions" style="margin-top:12px"><button id="connectSheet">Kết nối & nhập dữ liệu</button><button id="syncSheet" class="secondary">Đồng bộ ngay</button><button id="disconnectSheet" class="secondary">Ngắt kết nối</button></div><div id="sheetMsg" class="small"></div><p class="muted small">Yêu cầu: chia sẻ Sheet ở chế độ “Bất kỳ ai có đường liên kết – Người xem” hoặc Publish to web. Dữ liệu chỉ được đọc, không chỉnh sửa Sheet gốc.</p></div><div class="card"><div class="row between"><h2>Khách tham dự</h2><div class="actions"><input id="importFile" type="file" accept=".csv,text/csv" style="max-width:210px"><button id="importCsv" class="secondary">Nhập CSV</button><button id="exportCsv" class="secondary">Xuất CSV</button></div></div><div class="grid"><div class="field"><label>Họ tên</label><input id="aName"></div><div class="field"><label>Mã khách / mã máy</label><input id="aCode"></div><div class="field"><label>Email</label><input id="aEmail" type="email"></div><div class="field"><label>Điện thoại</label><input id="aPhone"></div><div class="field"><label>Công ty</label><input id="aCompany"></div><div class="field"><label>Chức danh</label><input id="aPosition"></div><div class="field"><label>Ảnh chân dung</label><input id="aPhoto" type="file" accept="image/jpeg,image/png,image/webp"></div></div><button id="addAttendee" style="margin-top:14px">Thêm khách</button><div id="attMsg"></div></div><div class="card"><div class="row between"><h3>Danh sách khách theo sự kiện</h3><input id="attSearch" placeholder="Tìm tên, email, công ty" style="max-width:300px"></div><div class="tablewrap"><table><thead><tr><th>Khách</th><th>Mã</th><th>Email</th><th>Công ty</th><th>Trạng thái</th></tr></thead><tbody id="attRows"></tbody></table></div></div></section><section id="checkins" class="hidden"><div class="card"><div class="row between"><h2>Lịch sử check-in</h2><button id="exportCheckins" class="secondary">Xuất CSV</button></div><div class="tablewrap"><table><thead><tr><th>Khách</th><th>Thời gian</th><th>Nguồn</th><th>Máy / Gmail</th><th>Kết quả</th></tr></thead><tbody id="checkRows"></tbody></table></div></div></section></div>';
let currentEvent=null,events=[],attendees=[];
$('#logout').onclick=async()=>{await api('/api/admin/logout','POST');renderLogin()};document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('on',x===b));['overview','events','attendees','checkins'].forEach(x=>$('#'+x).classList.toggle('hidden',x!==b.dataset.tab));if(b.dataset.tab==='attendees'){loadAttendees();loadSheetSource();}if(b.dataset.tab==='checkins')loadCheckins()});
async function loadEvents(){events=await api('/api/admin/events');$('#eventSelect').innerHTML=events.map(e=>'<option value="'+e.id+'">'+esc(e.name)+'</option>').join('');if(events.length){currentEvent=events[0];$('#eventSelect').value=currentEvent.id;await selectEvent()}$('#eventRows').innerHTML=events.map(e=>'<tr><td>'+esc(e.name)+'</td><td>'+esc(e.event_date||'—')+'</td><td>'+e.attendee_count+'</td><td>'+(e.active?'Hoạt động':'Đã khóa')+'</td><td><a href="/e/'+encodeURIComponent(e.slug)+'/checkin" target="_blank">Quầy</a> · <a href="/e/'+encodeURIComponent(e.slug)+'/display" target="_blank">LED</a></td><td><button class="secondary" data-act="toggle" data-id="'+e.id+'" data-active="'+(e.active?1:0)+'">'+(e.active?'Khóa':'Mở lại')+'</button></td></tr>').join('')}
async function selectEvent(){currentEvent=events.find(e=>String(e.id)===$('#eventSelect').value)||events[0];if(!currentEvent)return;const s=await api('/api/admin/events/'+currentEvent.id+'/summary');$('#sReg').textContent=s.registered;$('#sIn').textContent=s.checked_in;$('#sOut').textContent=s.not_arrived;$('#eventLinks').innerHTML='<a target="_blank" href="/e/'+currentEvent.slug+'/checkin">Mở quầy check-in ↗</a>　<a target="_blank" href="/e/'+currentEvent.slug+'/display">Mở màn hình LED ↗</a>';$('#recentRows').innerHTML=s.recent.map(x=>'<tr><td>'+esc(x.full_name)+'</td><td>'+esc(x.checkin_time)+'</td><td>'+esc(x.source)+'</td><td>'+esc(x.machine)+'</td></tr>').join('')}
$('#eventSelect').onchange=selectEvent;$('#eventRows').onclick=async ev=>{const b=ev.target.closest('button[data-act]');if(!b)return;try{await api('/api/admin/events/'+b.dataset.id+'/update','POST',{active:b.dataset.active==='1'?0:1});await loadEvents()}catch(e){alert(e.message)}};
$('#saveEvent').onclick=async()=>{try{const b={name:$('#evName').value,slug:$('#evSlug').value,event_date:$('#evDate').value,venue:$('#evVenue').value,logo_url:$('#evLogo').value,banner_url:$('#evBanner').value,welcome_title:$('#evWelcome').value,welcome_message:$('#evMessage').value,allow_walkin:$('#evWalkin').checked,allow_repeat:$('#evRepeat').checked};await api('/api/admin/events','POST',b);$('#eventMsg').textContent='Đã lưu sự kiện';await loadEvents()}catch(e){$('#eventMsg').textContent=e.message}};

async function loadSheetSource(){
 if(!currentEvent)return;const x=await api('/api/admin/sheets/source?event_id='+currentEvent.id);
 $('#sheetUrl').value=x.sheet_url||'';
 $('#sheetMsg').textContent=x.last_sync_at?'Đã kết nối · đồng bộ gần nhất: '+x.last_sync_at+(x.last_error?' · Lỗi: '+x.last_error:''):(x.connected?'Đã kết nối':'Chưa kết nối');
}
$('#connectSheet').onclick=async()=>{try{if(!currentEvent)throw Error('Hãy chọn sự kiện');const r=await api('/api/admin/sheets/connect','POST',{event_id:currentEvent.id,sheet_url:$('#sheetUrl').value});$('#sheetMsg').textContent='Đã nhập từ Google Sheet: '+r.inserted+' mới, '+r.updated+' cập nhật, '+r.skipped+' bỏ qua. Tự đồng bộ mỗi 5 phút.';await loadAttendees();}catch(e){$('#sheetMsg').textContent=e.message}};
$('#syncSheet').onclick=async()=>{try{const r=await api('/api/admin/sheets/sync','POST',{event_id:currentEvent.id});$('#sheetMsg').textContent='Đồng bộ xong: '+r.inserted+' mới, '+r.updated+' cập nhật, '+r.skipped+' bỏ qua.';await loadAttendees()}catch(e){$('#sheetMsg').textContent=e.message}};
$('#disconnectSheet').onclick=async()=>{try{await api('/api/admin/sheets/disconnect','POST',{event_id:currentEvent.id});$('#sheetUrl').value='';$('#sheetMsg').textContent='Đã ngắt kết nối Sheet.'}catch(e){$('#sheetMsg').textContent=e.message}};
$('#addAttendee').onclick=async()=>{try{if(!currentEvent)throw Error('Hãy tạo/chọn sự kiện trước');let f=new FormData();['full_name','attendee_code','email','phone','company','position'].forEach((k,i)=>f.append(k,$(['#aName','#aCode','#aEmail','#aPhone','#aCompany','#aPosition'][i]).value));f.append('event_id',currentEvent.id);let file=$('#aPhoto').files[0];if(file)f.append('photo',await shrinkImage(file));await api('/api/admin/attendees','POST',f);$('#attMsg').textContent='Đã thêm khách';['#aName','#aCode','#aEmail','#aPhone','#aCompany','#aPosition'].forEach(x=>$(x).value='');$('#aPhoto').value='';loadAttendees()}catch(e){$('#attMsg').textContent=e.message}};
let attTimer=null;async function loadAttendees(){if(!currentEvent)return;const q=encodeURIComponent($('#attSearch').value||'');attendees=await api('/api/admin/attendees?event_id='+currentEvent.id+'&limit=300&q='+q);drawAttendees()};function drawAttendees(){$('#attRows').innerHTML=attendees.map(a=>'<tr><td><div class="row">'+(a.photo_url?'<img class="avatar" loading="lazy" src="'+esc(a.photo_url)+'">':'')+esc(a.full_name)+'</div></td><td>'+esc(a.attendee_code||'—')+'</td><td>'+esc(a.email||'—')+'</td><td>'+esc(a.company||'—')+'</td><td>'+(a.checked_in?'<span class="pill">Đã đến</span>':'Chưa đến')+'</td></tr>').join('')+(attendees.length>=300?'<tr><td colspan="5" class="muted">Hiển thị 300 khách đầu — dùng ô tìm kiếm để thu hẹp.</td></tr>':'')};$('#attSearch').oninput=()=>{clearTimeout(attTimer);attTimer=setTimeout(()=>loadAttendees().catch(()=>{}),250)};
$('#exportCsv').onclick=()=>{if(currentEvent)location.href='/api/admin/attendees/export?event_id='+currentEvent.id};
$('#importCsv').onclick=async()=>{try{if(!currentEvent)throw Error('Hãy chọn sự kiện');const file=$('#importFile').files[0];if(!file)throw Error('Chọn file CSV trước');const rows=parseCsv(await file.text());if(rows.length<2)throw Error('File CSV không có dữ liệu');const heads=rows[0].map(x=>x.trim().toLowerCase());const pick=(r,names,idx)=>{let i=heads.findIndex(h=>names.some(n=>h===n||h.includes(n)));return i>=0?r[i]||'':r[idx]||''};const data=rows.slice(1).filter(r=>r.some(Boolean)).map(r=>({full_name:pick(r,['họ tên','ho ten','full_name','name'],0),email:pick(r,['email'],1),phone:pick(r,['điện thoại','dien thoai','phone','số điện thoại'],2),company:pick(r,['công ty','cong ty','company'],3),position:pick(r,['chức danh','chuc danh','position'],4),attendee_code:pick(r,['mã khách','ma khach','mã nv','employee code','attendee_code'],5)}));const result=await api('/api/admin/attendees/import','POST',{event_id:currentEvent.id,rows:data});$('#attMsg').textContent='Đã nhập '+result.inserted+' khách; bỏ qua '+result.skipped+' dòng trùng/không hợp lệ';loadAttendees()}catch(e){$('#attMsg').textContent=e.message}};
function parseCsv(text){let rows=[],row=[],v='',q=false;for(let i=0;i<text.length;i++){let c=text[i];if(c==='"'&&q&&text[i+1]==='"'){v+='"';i++}else if(c==='"')q=!q;else if(c===','&&!q){row.push(v);v=''}else if((c==='\\n'||c==='\\r')&&!q){if(c==='\\r'&&text[i+1]==='\\n')i++;row.push(v);rows.push(row);row=[];v=''}else v+=c}if(v||row.length){row.push(v);rows.push(row)}return rows}$('#exportCheckins').onclick=()=>{if(currentEvent)location.href='/api/admin/checkins/export?event_id='+currentEvent.id};
async function loadCheckins(){if(!currentEvent)return;let a=await api('/api/admin/checkins?event_id='+currentEvent.id);$('#checkRows').innerHTML=a.map(x=>'<tr><td>'+esc(x.full_name)+'</td><td>'+esc(x.checkin_time)+'</td><td>'+esc(x.source)+'</td><td>'+esc(x.machine)+' '+esc(x.gmail)+'</td><td><span class="pill">Thành công</span></td></tr>').join('')}
setInterval(()=>{if(!document.hidden&&currentEvent&&$('#overview')&&!$('#overview').classList.contains('hidden'))selectEvent().catch(()=>{})},15000);loadEvents().catch(e=>{if(e.message.includes('đăng nhập'))renderLogin()});}
function renderCheckin(){app.innerHTML='<div class="checkin-page"><div class="checkin-card"><div class="eyebrow">HACHIHI EVENT EXPERIENCE</div><h1 id="eventTitle">Đăng ký check-in</h1><p class="muted" id="eventSub">Vui lòng nhập thông tin để xác nhận tham dự</p><div class="field"><label>Họ và tên *</label><input id="guestName" placeholder="Nguyễn Văn A" autocomplete="name"></div><div class="field"><label>Email</label><input id="guestEmail" type="email" placeholder="email@example.com"></div><div class="field"><label>Công ty</label><input id="guestCompany" placeholder="Tên công ty"></div><div class="field"><label>Số điện thoại</label><input id="guestPhone" placeholder="09xx..."></div><div class="field"><label>Ảnh chân dung (không bắt buộc)</label><input id="guestPhoto" type="file" accept="image/jpeg,image/png,image/webp"></div><div id="msg"></div><button id="guestSubmit" class="gold">XÁC NHẬN CHECK-IN</button><div style="text-align:center;color:#718096;margin:10px">— hoặc —</div><div id="googleSignIn"></div><p class="muted small" style="text-align:center">Thông tin chỉ được sử dụng để xác nhận tham dự sự kiện.</p></div></div>';
api('/api/public/event/'+eventSlug).then(e=>{eventData=e;$('#eventTitle').textContent=e.name;$('#eventSub').textContent=e.venue||'Vui lòng nhập thông tin để xác nhận tham dự'}).catch(e=>msg(e.message));let rid=(window.crypto&&crypto.randomUUID)?crypto.randomUUID():String(Date.now())+Math.random();$('#guestSubmit').onclick=async()=>{const btn=$('#guestSubmit');if(btn.disabled)return;btn.disabled=true;btn.textContent='ĐANG XỬ LÝ…';try{let f=new FormData();f.append('full_name',$('#guestName').value);f.append('email',$('#guestEmail').value);f.append('company',$('#guestCompany').value);f.append('phone',$('#guestPhone').value);f.append('rid',rid);let file=$('#guestPhoto').files[0];if(file)f.append('photo',await shrinkImage(file));let r=await api('/api/public/checkin/'+eventSlug,'POST',f);app.innerHTML=thanks(r);setTimeout(()=>location.reload(),9000)}catch(e){msg(e.message);btn.disabled=false;btn.textContent='XÁC NHẬN CHECK-IN'}}
  // Gmail/Google Identity check-in. The browser requests a short-lived nonce from this Worker.
  if(window.google?.accounts?.id){initGoogle()}else{const sc=document.createElement('script');sc.src='https://accounts.google.com/gsi/client';sc.async=true;sc.defer=true;sc.onload=initGoogle;document.head.appendChild(sc)}
  async function initGoogle(){try{const cfg=await api('/api/public/google-config');if(!cfg.client_id)return;const n=await api('/api/google/nonce');window.google.accounts.id.initialize({client_id:cfg.client_id,nonce:n.nonce,callback:async response=>{try{const r=await api('/api/google/checkin/'+eventSlug,'POST',{credential:response.credential,nonce:n.nonce});app.innerHTML='<div class=\"hero\"><div class=\"hero-inner\"><div class=\"eyebrow\">CHECK-IN SUCCESSFUL</div><div class=\"ornament\"></div><h1>Xin cảm ơn<br>'+esc(r.name)+'!</h1><p>'+esc(r.company||eventData.name)+'</p><div class=\"ornament\"></div><p>'+esc(eventData.welcome_message||'Chúc bạn có trải nghiệm tuyệt vời tại sự kiện')+'</p><button class=\"gold\" onclick=\"location.reload()\">Check-in khách tiếp theo</button></div></div>'}catch(e){msg(e.message)}}});window.google.accounts.id.renderButton($('#googleSignIn'),{theme:'outline',size:'large',shape:'pill',text:'signin_with',width:480});}catch(e){}}
}
let pollFail=0,lastActivity=Date.now();
function initials(n){const p=String(n||'').trim().split(' ').filter(Boolean);return ((p[0]||'')[0]||'✦')+(p.length>1?p[p.length-1][0]:'')}
function setConn(ok){const c=$('#conn');if(c){c.className=ok?'':'off';c.lastChild.textContent=ok?'LIVE':'MẤT KẾT NỐI · ĐANG THỬ LẠI'}}
async function keepAwake(){try{if(navigator.wakeLock)window.__wl=await navigator.wakeLock.request('screen')}catch(e){}}
function toggleFullscreen(){if(document.fullscreenElement)document.exitFullscreen();else document.documentElement.requestFullscreen&&document.documentElement.requestFullscreen()}
async function renderDisplay(){app.innerHTML='<div id="conn"><i></i><span>LIVE</span></div><div class="hero"><div class="hero-inner" id="displayRoot"><div class="eyebrow">HACHIHI EVENT EXPERIENCE</div><img id="logo" class="hero-logo hidden"><div class="ornament"></div><h1 id="displayTitle">Chào mừng Quý khách</h1><p id="displayMessage">Hân hạnh được đón tiếp bạn</p><div class="waiting">WELCOME · CONNECT · INSPIRE</div><div class="recent" id="recent"></div></div></div>';document.addEventListener('dblclick',toggleFullscreen);document.addEventListener('keydown',ev=>{if(ev.key==='f'||ev.key==='F')toggleFullscreen()});document.addEventListener('visibilitychange',()=>{if(!document.hidden)keepAwake()});keepAwake();try{eventData=await api('/api/public/event/'+eventSlug);$('#displayTitle').textContent=eventData.welcome_title||eventData.name;$('#displayMessage').textContent=eventData.welcome_message||eventData.name;if(eventData.logo_url){$('#logo').src=eventData.logo_url;$('#logo').classList.remove('hidden')}}catch(e){$('#displayMessage').textContent=e.message;return}pollDisplay()}
// Incremental polling: only rows with id > lastId. Self-scheduling (never overlaps), jittered, backs off when idle or offline, drains fast when a burst is waiting.
async function pollDisplay(){let next=2500;try{let d=await api('/api/public/display/'+eventSlug+'?since='+lastId+'&init='+(displayInit?'0':'1'));displayInit=true;pollFail=0;setConn(true);if(d.cursor!=null)lastId=Math.max(lastId,d.cursor);if(d.items&&d.items.length){lastActivity=Date.now();for(const x of d.items){lastId=Math.max(lastId,x.id);displayQueue.push(x)}runDisplayQueue();if(d.items.length>=10)next=250}else{const idle=Date.now()-lastActivity;next=idle>180000?6000:idle>45000?4000:2500}if(d.recent&&d.recent.length)$('#recent').innerHTML=d.recent.map(x=>'<span>'+esc(x.full_name)+'</span>').join('')}catch(e){pollFail++;setConn(false);next=Math.min(15000,1500*Math.pow(2,Math.min(pollFail,4)))}pollTimer=setTimeout(pollDisplay,next+Math.random()*300)}
async function runDisplayQueue(){if(displayBusy)return;displayBusy=true;while(displayQueue.length){const n=displayQueue.length,dur=n>12?1500:n>5?3000:6500;await showGuest(displayQueue.shift(),dur)}displayBusy=false}
function showGuest(x,dur){return new Promise(resolve=>{let old=$('#guestLayer');if(old)old.remove();let layer=document.createElement('div');layer.id='guestLayer';layer.className='guest';const box=document.createElement('div');box.className='noimg';box.textContent=initials(x.full_name);let left=box;if(x.photo_url){const im=new Image();im.alt='';im.onerror=()=>im.replaceWith(box);im.src=x.photo_url;left=im}const info=document.createElement('div');info.innerHTML='<div class="ok">✓ CHECK-IN THÀNH CÔNG</div><h2>'+esc(x.full_name)+'</h2><div class="company">'+esc(x.company||'')+'</div><p>'+esc(eventData.welcome_message||'Cảm ơn bạn đã tham dự')+'</p>';layer.appendChild(left);layer.appendChild(info);$('#displayRoot').insertBefore(layer,$('#recent'));setTimeout(()=>{if(layer.isConnected)layer.remove();resolve()},dur||6500)})}
function boot(){let p=location.pathname;if(p==='/admin'||p==='/')renderAdmin();else if(p.endsWith('/display'))renderDisplay();else if(p.endsWith('/checkin'))renderCheckin();else renderLogin()};boot();
</script></body></html>`;

export default {
  async fetch(req,env,ctx){
    if(!env.DB)return new Response('Missing D1 binding DB',{status:500});if(!env.SESSION_SECRET)return new Response('Missing SESSION_SECRET secret',{status:500});
    const t0=Date.now(),u0=new URL(req.url);let res;try{if(!initPromise)initPromise=init(env).catch(e=>{initPromise=null;throw e});await initPromise;res=await route(req,env,ctx)}catch(e){log('error',{m:req.method,p:u0.pathname,msg:String(e&&e.message||e).slice(0,300)},'error');res=json({error:e.message||'Server error'},e.status||500)}
    // Query strings are never logged (the device key travels in them). LED polling is only logged when it fails.
    const noisy=u0.pathname.startsWith('/api/public/display/')&&res.status<400,asset=req.method==='GET'&&!u0.pathname.startsWith('/api/');if(!noisy&&!asset)log('http',{m:req.method,p:u0.pathname,status:res.status,ms:Date.now()-t0,ip:req.headers.get('CF-Connecting-IP')||''},res.status>=500?'error':res.status>=400?'warn':'log');return res
  },
  // Cron runs every minute: (1) drain the Sheets outbox in batches, (2) re-import each active event's Sheet every 5 minutes (staggered by source id).
  async scheduled(controller,env,ctx){
    if(!initPromise)initPromise=init(env).catch(e=>{initPromise=null;throw e});await initPromise;
    ctx.waitUntil(drainOutbox(env,200).catch(()=>{}));
    const sources=(await env.DB.prepare('SELECT s.* FROM sheet_sources s JOIN events e ON e.id=s.event_id WHERE e.active=1 ORDER BY s.id').all()).results,minute=Math.floor(Date.now()/60000);
    for(const src of sources){if(minute%5!==src.id%5)continue;ctx.waitUntil(syncSheetSource(env,src).catch(async e=>{log('sheet_sync_error',{source_id:src.id,event_id:src.event_id,msg:String(e.message).slice(0,200)},'error');await env.DB.prepare('UPDATE sheet_sources SET last_error=? WHERE id=?').bind(String(e.message).slice(0,300),src.id).run()}))}
  }
};

function parseCsvServer(text){
  const rows=[];let row=[],v='',q=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'&&q&&text[i+1]==='"'){v+='"';i++;}else if(c==='"')q=!q;else if(c===','&&!q){row.push(v);v='';}else if((c==='\n'||c==='\r')&&!q){if(c==='\r'&&text[i+1]==='\n')i++;row.push(v);rows.push(row);row=[];v='';}else v+=c;}
  if(v||row.length){row.push(v);rows.push(row);}return rows;
}
function sheetRef(input){
  const u=new URL(input);
  if(!['docs.google.com','www.docs.google.com'].includes(u.hostname))throw new Error('Chỉ chấp nhận link docs.google.com/spreadsheets');
  const m=u.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);if(!m)throw new Error('Link Google Sheet không đúng định dạng');
  const gid=u.searchParams.get('gid')||((u.hash.match(/gid=(\d+)/)||[])[1])||'0';
  return {id:m[1],gid};
}
function headerIndex(headers,aliases){
  return headers.findIndex(h=>aliases.some(a=>h===a||h.includes(a)));
}
function attendeeStmt(env,eventId,r,source,mode){
  const cols='event_id,full_name,attendee_code,email,phone,company,position,photo_url,registration_source,created_at';
  const t=now(),vals=[eventId,r.name,r.code||null,r.email||null,r.phone||'',r.company||'',r.position||'',r.photo||null,source,t];
  if(r.email){
    const tail=mode==='sync'
      ?" ON CONFLICT(event_id,email) DO UPDATE SET full_name=excluded.full_name,attendee_code=COALESCE(excluded.attendee_code,attendee_code),phone=excluded.phone,company=excluded.company,position=excluded.position,photo_url=COALESCE(excluded.photo_url,photo_url),registration_source=excluded.registration_source WHERE attendees.full_name IS NOT excluded.full_name OR attendees.phone IS NOT excluded.phone OR attendees.company IS NOT excluded.company OR attendees.position IS NOT excluded.position OR attendees.attendee_code IS NOT COALESCE(excluded.attendee_code,attendees.attendee_code) OR (excluded.photo_url IS NOT NULL AND attendees.photo_url IS NOT excluded.photo_url)"
      :' ON CONFLICT(event_id,email) DO NOTHING';
    return env.DB.prepare('INSERT INTO attendees('+cols+') VALUES(?,?,?,?,?,?,?,?,?,?)'+tail).bind(...vals);
  }
  if(r.code)return env.DB.prepare('INSERT INTO attendees('+cols+') SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM attendees WHERE event_id=? AND attendee_code=?)').bind(...vals,eventId,r.code);
  return env.DB.prepare("INSERT INTO attendees("+cols+") SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM attendees WHERE event_id=? AND email IS NULL AND full_name=? AND COALESCE(company,'')=?)").bind(...vals,eventId,r.name,r.company||'');
}
// Run statements in chunks of one D1 batch each (few round-trips instead of one per row). Returns total rows changed.
async function runChunks(env,stmts,size=200){let changes=0;for(let i=0;i<stmts.length;i+=size){const res=await env.DB.batch(stmts.slice(i,i+size));for(const x of res)changes+=(x.meta&&x.meta.changes)||0}return changes}
async function syncSheetSource(env,source,force=false){
  const e=await env.DB.prepare('SELECT * FROM events WHERE id=?').bind(source.event_id).first();
  if(!e)throw new Error('Sự kiện không tồn tại');
  const url=`https://docs.google.com/spreadsheets/d/${source.spreadsheet_id}/export?format=csv&gid=${encodeURIComponent(source.gid||'0')}`;
  const res=await fetch(url,{headers:{'accept':'text/csv'},redirect:'follow',signal:AbortSignal.timeout(20000)});
  if(!res.ok)throw new Error(`Google Sheets trả HTTP ${res.status}. Hãy bật quyền Người có đường liên kết - Người xem.`);
  const text=await res.text();
  if(!text||text.length>5*1024*1024||/<!doctype html|<html/i.test(text.slice(0,500)))throw new Error('Không đọc được CSV. Hãy chia sẻ Sheet ở chế độ Người có đường liên kết - Người xem hoặc Publish to web.');
  const hash=await sha(text);
  if(!force&&source.content_hash===hash){await env.DB.prepare('UPDATE sheet_sources SET last_sync_at=?,last_error=NULL WHERE id=?').bind(now(),source.id).run();return {inserted:0,updated:0,skipped:0,total:0,unchanged:true}}
  const rows=parseCsvServer(text.replace(/^\uFEFF/,''));if(rows.length<2)throw new Error('Sheet chưa có dòng dữ liệu');
  const norm=x=>String(x||'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d');
  const hs=rows[0].map(norm);
  const ix={
    name:headerIndex(hs,['ho va ten','ho ten','full_name','name']),
    email:headerIndex(hs,['email','dia chi email']),
    phone:headerIndex(hs,['so dien thoai','dien thoai','phone']),
    company:headerIndex(hs,['cong ty','company','don vi']),
    position:headerIndex(hs,['chuc danh','position','vi tri']),
    code:headerIndex(hs,['ma khach','ma dang ky','attendee_code','employee code','ma nv']),
    photo:headerIndex(hs,['anh chan dung','anh dai dien','photo','image url'])
  };
  if(ix.name<0)throw new Error('Không tìm thấy cột Họ và tên / Full name / Name trong Sheet');
  const val=(r,i)=>i>=0?String(r[i]||'').trim():'';
  let skipped=0;const stmts=[];
  for(const r of rows.slice(1)){
    const rec={name:val(r,ix.name).slice(0,120),email:emailNorm(val(r,ix.email)),code:val(r,ix.code).slice(0,100),phone:val(r,ix.phone).slice(0,40),company:val(r,ix.company).slice(0,160),position:val(r,ix.position).slice(0,120),photo:(()=>{const p=val(r,ix.photo);if(!p)return null;const m=p.match(DRIVE_ID);return m?driveThumb(m[1]):p})()};
    // A row needs a stable key (email or guest code); otherwise every 5-minute sync would insert it again.
    if(!rec.name||(rec.email&&!validEmail(rec.email))||(!rec.email&&!rec.code)){skipped++;continue}
    stmts.push(attendeeStmt(env,e.id,rec,'google_sheet','sync'));
  }
  const before=(await env.DB.prepare('SELECT COUNT(*) n FROM attendees WHERE event_id=?').bind(e.id).first()).n;
  const changes=await runChunks(env,stmts);
  const after=(await env.DB.prepare('SELECT COUNT(*) n FROM attendees WHERE event_id=?').bind(e.id).first()).n;
  const inserted=Math.max(0,after-before),updated=Math.max(0,changes-inserted);
  await env.DB.prepare('UPDATE sheet_sources SET last_sync_at=?,last_error=NULL,content_hash=? WHERE id=?').bind(now(),hash,source.id).run();
  log('sheet_sync',{event_id:e.id,inserted,updated,skipped,total:rows.length-1});
  return {inserted,updated,skipped,total:rows.length-1};
}

async function route(req,env,ctx){
  const u=new URL(req.url),p=u.pathname,method=req.method;
  if(method==='OPTIONS')return new Response(null,{status:204,headers:{'access-control-allow-origin':u.origin,'access-control-allow-methods':'GET,POST,PUT,DELETE,OPTIONS','access-control-allow-headers':'content-type,x-device-key','access-control-max-age':'86400'}});
  if(p.startsWith('/media/')){const key=decodeURIComponent(p.slice(7));if(!env.PHOTOS)return new Response('R2 unavailable',{status:503});const obj=await env.PHOTOS.get(key);if(!obj)return new Response('Not found',{status:404});return new Response(obj.body,{headers:{'content-type':obj.httpMetadata?.contentType||'application/octet-stream','cache-control':'public, max-age=31536000, immutable','etag':obj.httpEtag}})}
  // NOTE: the face-terminal webhook (POST / and POST /checkin, as documented in the README) must be routed here too; in v2 it sat inside the /api/ block only, so those URLs returned the HTML page with HTTP 200 and nothing was recorded.
  if(p.startsWith('/api/')||((p==='/'||p==='/checkin')&&method==='POST')){
    if(p==='/api/admin/login'&&method==='POST'){const b=await req.json().catch(()=>({}));const ip=req.headers.get('CF-Connecting-IP')||'',uname=String(b.username||'').slice(0,80);const since=fmtTime(Date.now()-15*60000);const [fu,fi]=await env.DB.batch([env.DB.prepare('SELECT COUNT(*) n FROM login_logs WHERE ok=0 AND created_at>? AND username=?').bind(since,uname),env.DB.prepare('SELECT COUNT(*) n FROM login_logs WHERE ok=0 AND created_at>? AND ip=?').bind(since,ip)]);/* per-account limit is strict; per-IP limit is loose because a whole venue shares one NAT address */if(fu.results[0].n>=8||fi.results[0].n>=40){log('login_locked',{user:uname,ip},'warn');return json({error:'Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.'},429)}const a=await env.DB.prepare('SELECT * FROM admins WHERE username=?').bind(uname).first();if(!a||!(await verifyPassword(String(b.password||''),a.password_hash))){await env.DB.prepare('INSERT INTO login_logs(username,ip,created_at,ok) VALUES(?,?,?,0)').bind(uname,ip,now()).run();log('login_fail',{user:uname,ip},'warn');return json({error:'Sai tài khoản hoặc mật khẩu'},401)}await env.DB.prepare('INSERT INTO login_logs(username,ip,created_at,ok) VALUES(?,?,?,1)').bind(a.username,ip,now()).run();log('login_ok',{user:a.username,ip});return json({ok:true},200,{'set-cookie':await sessionCookie(env,a.id)});}
    if(p==='/api/admin/logout'&&method==='POST')return json({ok:true},200,{'set-cookie':'hch_event=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'});
    if(p==='/api/public/event/'+p.split('/').pop()&&method==='GET'){const e=await cachedEvent(env,p.split('/').pop(),10000);return e?json(publicEvent(e)):json({error:'Không tìm thấy sự kiện'},404)}
    let m=p.match(/^\/api\/public\/display\/([a-z0-9-]+)$/);if(m&&method==='GET'){
      // Hot path: N LED screens poll this. Event row and the response are micro-cached per isolate (1 s) so a crowd of screens costs ~1 D1 query/second/isolate.
      const e=await cachedEvent(env,m[1]);if(!e)return json({error:'Không tìm thấy sự kiện hoặc sự kiện đã khóa'},404);
      const since=Math.max(0,Number(u.searchParams.get('since'))||0),init=u.searchParams.get('init')==='1',ck=e.id+'|'+since+'|'+(init?1:0),hit=MEM.disp.get(ck);
      if(hit&&hit.until>Date.now())return json(hit.body);
      let body;
      if(init){const [mx,rr]=await Promise.all([env.DB.prepare('SELECT COALESCE(MAX(id),0) cursor FROM checkins WHERE event_id=?').bind(e.id).first(),env.DB.prepare("SELECT id,full_name FROM checkins WHERE event_id=? AND result='success' ORDER BY id DESC LIMIT 3").bind(e.id).all()]);body={items:[],recent:rr.results.reverse(),cursor:mx.cursor}}
      else{const items=await env.DB.prepare("SELECT id,full_name,company,photo_url,checkin_time FROM checkins WHERE event_id=? AND id>? AND result='success' ORDER BY id LIMIT 10").bind(e.id,since).all();let recent=[];if(items.results.length){const rr=await env.DB.prepare("SELECT id,full_name FROM checkins WHERE event_id=? AND result='success' ORDER BY id DESC LIMIT 3").bind(e.id).all();recent=rr.results.reverse()}body={items:items.results,recent}}
      if(MEM.disp.size>500)MEM.disp.clear();MEM.disp.set(ck,{body,until:Date.now()+1000});return json(body);
    }
    m=p.match(/^\/api\/public\/checkin\/([a-z0-9-]+)$/);if(m&&method==='POST'){const e=await getEventId(env,m[1]);if(!e.allow_walkin)return json({error:'Sự kiện không mở đăng ký tại chỗ'},403);const f=await req.formData();const name=String(f.get('full_name')||'').trim().slice(0,120),email=emailNorm(f.get('email')),company=String(f.get('company')||'').trim().slice(0,160),phone=String(f.get('phone')||'').trim().slice(0,40);if(!name)return json({error:'Vui lòng nhập họ tên'},400);if(email&&!validEmail(email))return json({error:'Email không hợp lệ'},400);const rid=String(f.get('rid')||'').slice(0,64),idem=rid?'w:'+rid:null;let attendee=email?await env.DB.prepare('SELECT * FROM attendees WHERE event_id=? AND email=?').bind(e.id,email).first():null;if(attendee){const dup=await findDuplicate(env,e,attendee,idem);if(dup)return dupResp({previous:dup})}if(!attendee){try{const ins=await env.DB.prepare("INSERT INTO attendees(event_id,full_name,email,phone,company,registration_source,created_at) VALUES(?,?,?,?,?,'walkin',?)").bind(e.id,name,email||null,phone,company,now()).run();attendee={id:ins.meta.last_row_id,full_name:name,email,company};}catch(err){attendee=email?await env.DB.prepare('SELECT * FROM attendees WHERE event_id=? AND email=?').bind(e.id,email).first():null;if(!attendee)throw err}}else{await env.DB.prepare('UPDATE attendees SET full_name=?,phone=?,company=? WHERE id=?').bind(name,phone,company,attendee.id).run();attendee.full_name=name;attendee.company=company;}
      let key=null;const file=f.get('photo');if(file&&file.size)key=await putPhoto(env,file,e.id);if(key)await env.DB.prepare('UPDATE attendees SET photo_key=?,photo_url=NULL WHERE id=?').bind(key,attendee.id).run();const r=await addCheckin(env,ctx,{event:e,attendee,name,email,company,source:'walkin',photoKey:key,raw:{phone},idem});return r.duplicate?dupResp(r):json(r);}
    if(p==='/api/google/nonce'&&method==='GET'){const n=await makeNonce(env);return json({nonce:n});}
    m=p.match(/^\/api\/google\/checkin\/([a-z0-9-]+)$/);if(m&&method==='POST'){const e=await getEventId(env,m[1]),b=await req.json(),nonce=String(b.nonce||'');await checkNonce(env,nonce);const c=await verifyGoogle(env,b.credential,nonce),email=emailNorm(c.email);let a=await env.DB.prepare('SELECT * FROM attendees WHERE event_id=? AND email=?').bind(e.id,email).first();if(!a){if(!e.allow_walkin)return json({error:'Email chưa có trong danh sách đăng ký'},403);const ins=await env.DB.prepare("INSERT INTO attendees(event_id,full_name,email,registration_source,created_at) VALUES(?,?,?,'gmail-walkin',?)").bind(e.id,String(c.name||email.split('@')[0]).slice(0,120),email,now()).run();a={id:ins.meta.last_row_id,full_name:c.name||email,email};}const r=await addCheckin(env,ctx,{event:e,attendee:a,name:a.full_name,email,company:a.company||'',gmail:email,source:'gmail',external:c.picture||'',raw:{google_sub:c.sub},idem:await sha('g|'+e.id+'|'+nonce)});return r.duplicate?dupResp(r):json(r);}
    // Camera/attendance terminal webhook. The old Worker is untouched; the new one accepts its familiar JSON payload.
    if((p==='/'||p==='/checkin'||p==='/api/device/checkin')&&method==='POST'){
      const supplied=req.headers.get('x-device-key')||u.searchParams.get('key');
      if(!env.MACHINE_API_KEY||!safeEq(supplied,env.MACHINE_API_KEY)){log('device_unauthorized',{ip:req.headers.get('CF-Connecting-IP')||'',key_set:!!env.MACHINE_API_KEY},'warn');return json({error:'Unauthorized device'},401)}
      const b=await req.json().catch(()=>null);if(!b||typeof b!=='object')return json({error:'Invalid JSON'},400);
      const slug=String(b.EventSlug||u.searchParams.get('event')||env.DEFAULT_EVENT_SLUG||'').trim();if(!slug)return json({error:'Thiếu EventSlug hoặc DEFAULT_EVENT_SLUG'},400);
      const e=await getEventId(env,slug);
      const code=String(b.EmployeeCode||'').trim().slice(0,100),email=emailNorm(b.Email||''),machineId=String(b.MachineBoxId||'').slice(0,100),devTime=String(b.CheckinTime||'').slice(0,40);
      // Idempotency: a terminal that retries the same event (same machine + person + device timestamp) can never create a second row.
      const idem=devTime?await sha([e.id,machineId,code||email,devTime].join('|')):null;
      let a=null;if(email)a=await env.DB.prepare('SELECT * FROM attendees WHERE event_id=? AND email=?').bind(e.id,email).first();
      if(!a&&code)a=await env.DB.prepare('SELECT * FROM attendees WHERE event_id=? AND (attendee_code=? OR email=?)').bind(e.id,code,code.toLowerCase()).first();
      const name=String((a&&a.full_name)||b.EmployeeName||'Khách tham dự').trim().slice(0,120);
      // Unmatched face without a code: derive a stable code so repeated scans of the same person do not create a new guest each time.
      const autoCode=code||('AUTO-'+(await sha(machineId+'|'+name)).slice(0,12));
      if(!a&&!code)a=await env.DB.prepare('SELECT * FROM attendees WHERE event_id=? AND attendee_code=?').bind(e.id,autoCode).first();
      // Duplicate / retry short-circuit BEFORE any photo work or writes. Devices get HTTP 200 so they stop retrying.
      const early=await findDuplicate(env,e,a,idem);
      if(early){log('checkin',{result:'duplicate_early',event_id:e.id,attendee_id:a?a.id:null,source:'machine',machine:machineId,prev_id:early.id});return json({success:false,duplicate:true,previous:early,name})}
      if(!a){if(!e.allow_walkin){log('checkin',{result:'rejected_unregistered',event_id:e.id,source:'machine',machine:machineId,code:code},'warn');return json({error:'Khách chưa đăng ký'},403)}try{const ins=await env.DB.prepare("INSERT INTO attendees(event_id,full_name,attendee_code,email,company,registration_source,created_at) VALUES(?,?,?,?,?,'machine-walkin',?)").bind(e.id,name,autoCode,email||null,'',now()).run();a={id:ins.meta.last_row_id,full_name:name,email};}catch(err){a=await env.DB.prepare('SELECT * FROM attendees WHERE event_id=? AND (attendee_code=? OR email=?)').bind(e.id,autoCode,email||'-').first();if(!a)throw err}}
      let machinePhoto=null;
      let drivePhoto=null;if(b.Base64Image&&!env.PHOTOS&&driveOn(env)&&!(a&&a.photo_key)){const raw64=String(b.Base64Image).replace(/^data:[^,]+,/,'').replace(/\s/g,''),mime=String(b.ImageMimeType||'image/jpeg');if(raw64.length<8*1024*1024&&['image/jpeg','image/png','image/webp'].includes(mime))drivePhoto={raw64,mime}}
      if(b.Base64Image&&env.PHOTOS&&!(a&&a.photo_key)){try{const raw64=String(b.Base64Image).replace(/^data:[^,]+,/,'').replace(/\s/g,'');if(raw64.length<8*1024*1024){const bytes=Uint8Array.from(atob(raw64),ch=>ch.charCodeAt(0));if(bytes.length<=6*1024*1024){const mime=String(b.ImageMimeType||'image/jpeg');if(['image/jpeg','image/png','image/webp'].includes(mime)){const ext=mime==='image/png'?'png':mime==='image/webp'?'webp':'jpg';machinePhoto='events/'+e.id+'/checkins/'+crypto.randomUUID()+'.'+ext;await env.PHOTOS.put(machinePhoto,bytes,{httpMetadata:{contentType:mime,cacheControl:'public, max-age=31536000, immutable'}})}}}}catch(err){machinePhoto=null}}
      const r=await addCheckin(env,ctx,{event:e,attendee:a,name,email:email||a.email||'',company:a.company||'',machine:machineId,source:'machine',photoKey:machinePhoto,photoUrl:String(b.ImageUrl||'').slice(0,500),raw:{...b,Base64Image:undefined},idem});
      // Drive upload is slow (1-3 s), so it never blocks the check-in: it runs after the response and back-fills the photo (LED shows initials until then).
      if(r.success&&drivePhoto)ctx.waitUntil((async()=>{try{const k=await driveUpload(env,drivePhoto.raw64,drivePhoto.mime);await env.DB.batch([env.DB.prepare('UPDATE checkins SET photo_key=?,photo_url=? WHERE id=?').bind(k,photoUrl(k,env),r.id),env.DB.prepare('UPDATE attendees SET photo_key=? WHERE id=? AND photo_key IS NULL').bind(k,a.id)])}catch(e){}})());
      return json({success:!!r.success,duplicate:!!r.duplicate,...r});
    }
    if(p==='/api/public/google-config'&&method==='GET')return json({client_id:String(env.GOOGLE_CLIENT_ID||'').split(',')[0].trim()});
    // Trusted Google Apps Script integration: upsert registered guest and move Drive photo into R2.
    if(p==='/api/integrations/attendee'&&method==='POST'){
      if(!env.APPS_SCRIPT_SECRET||!safeEq(req.headers.get('x-integration-secret'),env.APPS_SCRIPT_SECRET))return json({error:'Unauthorized integration'},401);
      const b=await req.json(),e=await getEventId(env,String(b.event_slug||'')),name=String(b.full_name||'').trim(),email=emailNorm(b.email);
      if(!name)return json({error:'Thiếu họ tên'},400);if(email&&!validEmail(email))return json({error:'Email không hợp lệ'},400);
      let key=null;if(b.photo_drive_id&&/^[A-Za-z0-9_-]{20,}$/.test(String(b.photo_drive_id)))key='drive:'+b.photo_drive_id;else if(b.photo_base64&&env.PHOTOS){const bytes=Uint8Array.from(atob(String(b.photo_base64).replace(/^data:[^,]+,/,'').replace(/\s/g,'')),c=>c.charCodeAt(0));if(bytes.length>6*1024*1024)return json({error:'Ảnh vượt quá 6 MB'},413);const type=String(b.photo_mime||'image/jpeg');if(!['image/jpeg','image/png','image/webp'].includes(type))return json({error:'Định dạng ảnh không hỗ trợ'},400);const ext=type==='image/png'?'png':type==='image/webp'?'webp':'jpg';key='events/'+e.id+'/attendees/'+crypto.randomUUID()+'.'+ext;await env.PHOTOS.put(key,bytes,{httpMetadata:{contentType:type,cacheControl:'public, max-age=31536000, immutable'}})}
      const old=email?await env.DB.prepare('SELECT id FROM attendees WHERE event_id=? AND email=?').bind(e.id,email).first():null;
      if(old){await env.DB.prepare("UPDATE attendees SET full_name=?,attendee_code=COALESCE(?,attendee_code),phone=?,company=?,position=?,photo_key=COALESCE(?,photo_key),registration_source='google_forms' WHERE id=?").bind(name,b.attendee_code||null,b.phone||'',b.company||'',b.position||'',key,old.id).run();return json({ok:true,updated:true,id:old.id,photo_url:key?photoUrl(key,env):''})}
      const ins=await env.DB.prepare("INSERT INTO attendees(event_id,full_name,attendee_code,email,phone,company,position,photo_key,registration_source,created_at) VALUES(?,?,?,?,?,?,?,?,'google_forms',?)").bind(e.id,name,b.attendee_code||null,email||null,b.phone||'',b.company||'',b.position||'',key,now()).run();return json({ok:true,id:ins.meta.last_row_id,photo_url:key?photoUrl(key,env):''});
    }
    // Admin-only APIs from here
    const me=await requireAdmin(req,env);
    if(p==='/api/admin/me')return json(me);
    if(p==='/api/admin/events'&&method==='GET'){const r=await env.DB.prepare(`SELECT e.*,(SELECT COUNT(*) FROM attendees a WHERE a.event_id=e.id) attendee_count FROM events e ORDER BY e.id DESC`).all();return json(r.results)}
    if(p==='/api/admin/events'&&method==='POST'){const b=await req.json(),name=String(b.name||'').trim();if(!name)return json({error:'Thiếu tên sự kiện'},400);const slug=slugify(b.slug||name);if(!slug)return json({error:'Mã sự kiện không hợp lệ'},400);try{await env.DB.prepare(`INSERT INTO events(slug,name,event_date,venue,logo_url,banner_url,welcome_title,welcome_message,allow_walkin,allow_repeat,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(slug,name,b.event_date||null,b.venue||'',b.logo_url||'',b.banner_url||'',b.welcome_title||'Chào mừng Quý khách',b.welcome_message||'Cảm ơn bạn đã tham dự sự kiện',b.allow_walkin?1:0,b.allow_repeat?1:0,now()).run()}catch{return json({error:'Mã URL sự kiện đã tồn tại'},409)}await audit(env,me,'event.create',slug);return json({ok:true,slug})}
    m=p.match(/^\/api\/admin\/events\/(\d+)\/update$/);if(m&&method==='POST'){const b=await req.json().catch(()=>({})),sets=[],vals=[];const text=['name','event_date','venue','logo_url','banner_url','primary_color','welcome_title','welcome_message'],flags=['allow_walkin','allow_repeat','active'];for(const k of text)if(typeof b[k]==='string'){sets.push(k+'=?');vals.push(b[k].slice(0,300))}for(const k of flags)if(b[k]!==undefined){sets.push(k+'=?');vals.push(b[k]?1:0)}if(!sets.length)return json({error:'Không có thay đổi'},400);await env.DB.prepare('UPDATE events SET '+sets.join(',')+' WHERE id=?').bind(...vals,+m[1]).run();MEM.ev.clear();await audit(env,me,'event.update',m[1]+' '+Object.keys(b).join(','));return json({ok:true})}
    m=p.match(/^\/api\/admin\/events\/(\d+)\/summary$/);if(m&&method==='GET'){const id=+m[1];const [reg,ins,recent]=await Promise.all([env.DB.prepare('SELECT COUNT(*) n FROM attendees WHERE event_id=?').bind(id).first(),env.DB.prepare('SELECT COUNT(DISTINCT attendee_id) n FROM checkins WHERE event_id=? AND result=\'success\'').bind(id).first(),env.DB.prepare('SELECT full_name,checkin_time,source,machine FROM checkins WHERE event_id=? ORDER BY id DESC LIMIT 12').bind(id).all()]);return json({registered:reg.n,checked_in:ins.n,not_arrived:Math.max(0,reg.n-ins.n),recent:recent.results.reverse()})}

    if(p==='/api/admin/sheets/source'&&method==='GET'){
      const id=Number(u.searchParams.get('event_id'));
      const x=await env.DB.prepare('SELECT id,event_id,sheet_url,gid,last_sync_at,last_error FROM sheet_sources WHERE event_id=?').bind(id).first();
      return json(x||{connected:false});
    }
    if(p==='/api/admin/sheets/connect'&&method==='POST'){
      const b=await req.json(),eventId=Number(b.event_id),url=String(b.sheet_url||'').trim();
      if(!url)return json({error:'Vui lòng dán link Google Sheet'},400);
      const e=await env.DB.prepare('SELECT id FROM events WHERE id=?').bind(eventId).first();if(!e)return json({error:'Không tìm thấy sự kiện'},404);
      let ref;try{ref=sheetRef(url)}catch(err){return json({error:err.message},400)}
      await env.DB.prepare(`INSERT INTO sheet_sources(event_id,spreadsheet_id,gid,sheet_url,created_at) VALUES(?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET spreadsheet_id=excluded.spreadsheet_id,gid=excluded.gid,sheet_url=excluded.sheet_url,last_error=NULL`)
        .bind(eventId,ref.id,ref.gid,url,now()).run();
      const src=await env.DB.prepare('SELECT * FROM sheet_sources WHERE event_id=?').bind(eventId).first();
      await audit(env,me,'sheets.connect','event '+eventId);try{const result=await syncSheetSource(env,src,true);return json({ok:true,...result,last_sync_at:now()})}
      catch(err){await env.DB.prepare('UPDATE sheet_sources SET last_error=? WHERE id=?').bind(String(err.message).slice(0,300),src.id).run();return json({error:err.message,connected:true},422)}
    }
    if(p==='/api/admin/sheets/sync'&&method==='POST'){
      const b=await req.json(),id=Number(b.event_id),src=await env.DB.prepare('SELECT * FROM sheet_sources WHERE event_id=?').bind(id).first();
      if(!src)return json({error:'Sự kiện chưa kết nối Google Sheet'},404);
      await audit(env,me,'sheets.sync','event '+id);try{return json({ok:true,...await syncSheetSource(env,src,true)})}
      catch(err){await env.DB.prepare('UPDATE sheet_sources SET last_error=? WHERE id=?').bind(String(err.message).slice(0,300),src.id).run();return json({error:err.message},422)}
    }
    if(p==='/api/admin/sheets/disconnect'&&method==='POST'){
      const b=await req.json();await env.DB.prepare('DELETE FROM sheet_sources WHERE event_id=?').bind(Number(b.event_id)).run();await audit(env,me,'sheets.disconnect','event '+Number(b.event_id));return json({ok:true});
    }
    if(p==='/api/admin/attendees'&&method==='GET'){const id=Number(u.searchParams.get('event_id')),limit=Math.min(1000,Math.max(1,Number(u.searchParams.get('limit'))||300)),offset=Math.max(0,Number(u.searchParams.get('offset'))||0),q=String(u.searchParams.get('q')||'').trim().slice(0,80);let where='a.event_id=?',args=[id];if(q){where+=' AND (a.full_name LIKE ? OR a.email LIKE ? OR a.attendee_code LIKE ? OR a.company LIKE ?)';const like='%'+q.replace(/[%_]/g,'')+'%';args.push(like,like,like,like)}const r=await env.DB.prepare('SELECT a.id,a.full_name,a.attendee_code,a.email,a.phone,a.company,a.position,a.photo_key,a.photo_url,a.created_at,EXISTS(SELECT 1 FROM checkins c WHERE c.event_id=a.event_id AND c.attendee_id=a.id) checked_in FROM attendees a WHERE '+where+' ORDER BY a.full_name LIMIT ? OFFSET ?').bind(...args,limit,offset).all();return json(r.results.map(x=>({...x,photo_url:x.photo_key?photoUrl(x.photo_key,env):x.photo_url})));}
    if(p==='/api/admin/attendees'&&method==='POST'){const f=await req.formData(),id=Number(f.get('event_id')),name=String(f.get('full_name')||'').trim(),email=emailNorm(f.get('email'));if(!name)return json({error:'Thiếu họ tên'},400);const e=await env.DB.prepare('SELECT * FROM events WHERE id=?').bind(id).first();if(!e)return json({error:'Không tìm thấy sự kiện'},404);let key=null;const file=f.get('photo');if(file&&file.size)key=await putPhoto(env,file,id);try{await env.DB.prepare('INSERT INTO attendees(event_id,full_name,attendee_code,email,phone,company,position,photo_key,registration_source,created_at) VALUES(?,?,?,?,?,?,?,? ,\'admin\',?)').bind(id,name,String(f.get('attendee_code')||'').trim()||null,email||null,String(f.get('phone')||''),String(f.get('company')||''),String(f.get('position')||''),key,now()).run()}catch{return json({error:'Email đã tồn tại trong sự kiện này'},409)}return json({ok:true})}
    if(p==='/api/admin/attendees/import'&&method==='POST'){const b=await req.json(),id=Number(b.event_id),rows=Array.isArray(b.rows)?b.rows.slice(0,5000):[];const e=await env.DB.prepare('SELECT id FROM events WHERE id=?').bind(id).first();if(!e)return json({error:'Không tìm thấy sự kiện'},404);let skipped=0;const stmts=[];for(const a of rows){const rec={name:String(a.full_name||'').trim().slice(0,120),email:emailNorm(a.email),code:String(a.attendee_code||'').trim().slice(0,100),phone:String(a.phone||'').slice(0,40),company:String(a.company||'').slice(0,160),position:String(a.position||'').slice(0,120)};if(!rec.name||(rec.email&&!validEmail(rec.email))){skipped++;continue}stmts.push(attendeeStmt(env,id,rec,'csv','import'))}const changes=await runChunks(env,stmts);skipped+=stmts.length-changes;await audit(env,me,'attendees.import','event '+id+': '+changes+' inserted, '+skipped+' skipped');return json({inserted:changes,skipped})}
    if(p==='/api/admin/attendees/export'&&method==='GET'){const id=Number(u.searchParams.get('event_id'));const r=await env.DB.prepare('SELECT full_name,attendee_code,email,phone,company,position,created_at FROM attendees WHERE event_id=? ORDER BY full_name').bind(id).all();return csv(['Họ tên','Mã khách','Email','Điện thoại','Công ty','Chức danh','Ngày tạo'],r.results.map(x=>[x.full_name,x.attendee_code,x.email,x.phone,x.company,x.position,x.created_at]),'attendees.csv')}
    if(p==='/api/admin/checkins'&&method==='GET'){const id=Number(u.searchParams.get('event_id'));const r=await env.DB.prepare('SELECT id,full_name,email,company,checkin_time,machine,gmail,source,result FROM checkins WHERE event_id=? ORDER BY id DESC LIMIT 2000').bind(id).all();return json(r.results)}
    if(p==='/api/admin/checkins/export'&&method==='GET'){const id=Number(u.searchParams.get('event_id'));const r=await env.DB.prepare('SELECT full_name,email,company,checkin_time,machine,gmail,source,result FROM checkins WHERE event_id=? ORDER BY id DESC').bind(id).all();return csv(['Họ tên','Email','Công ty','Thời gian','Máy','Gmail','Nguồn','Kết quả'],r.results.map(x=>[x.full_name,x.email,x.company,x.checkin_time,x.machine,x.gmail,x.source,x.result]),'checkins.csv')}
    if(p==='/api/admin/audit'&&method==='GET'){const lim=Math.min(500,Math.max(1,Number(u.searchParams.get('limit'))||100));return json((await env.DB.prepare('SELECT id,admin,action,detail,created_at FROM audit_logs ORDER BY id DESC LIMIT ?').bind(lim).all()).results)}
    if(p==='/api/admin/sync/run'&&method==='POST'){return json({ok:true,...await drainOutbox(env,200)})}
    if(p==='/api/admin/sync/status'&&method==='GET'){const r=await env.DB.prepare("SELECT status,COUNT(*) count FROM sync_outbox GROUP BY status").all();return json(r.results)}
    return json({error:'API not found'},404);
  }
  if(p==='/health'){let db=true;if(u.searchParams.get('deep')==='1'){try{await env.DB.prepare('SELECT 1').first()}catch(e){db=false}}return json({ok:db,app:'HACHIHI EVENT CHECK-IN',version:'3.0',time:now()},db?200:503)}
  return html(APP);
}
function csv(headers,rows,filename){const cell=v=>'"'+String(v??'').replace(/"/g,'""')+'"';const body='\uFEFF'+[headers,...rows].map(r=>r.map(cell).join(',')).join('\r\n');return new Response(body,{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="${filename}"`,'cache-control':'no-store'}})}
