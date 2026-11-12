// Functional / concurrency test. Usage: BASE=http://localhost:8799 ADMIN_USER=admin ADMIN_PASS=... KEY=devkey node functional-test.mjs
const BASE=process.env.BASE||'http://localhost:8799',KEY=process.env.KEY||'devkey123';
const U=process.env.ADMIN_USER||'admin',PW=process.env.ADMIN_PASS||'Test-Pass-123';
let cookie='';const results=[];
const ok=(name,cond,info='')=>{results.push([cond,name,info]);console.log((cond?'PASS ':'FAIL ')+name+(info?'  — '+info:''))};
async function api(path,method='GET',body){const r=await fetch(BASE+path,{method,headers:{'content-type':'application/json',cookie},body:body?JSON.stringify(body):undefined});const sc=r.headers.get('set-cookie');if(sc)cookie=sc.split(';')[0];let j=null;try{j=await r.json()}catch{}return {status:r.status,body:j}}
const dev=(slug,code,extra={})=>fetch(BASE+'/checkin?key='+KEY+'&event='+slug,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({MachineBoxId:'M1',EmployeeCode:code,EmployeeName:'Guest '+code,...extra})}).then(async r=>({status:r.status,body:await r.json()}));
const pct=(a,p)=>a.sort((x,y)=>x-y)[Math.min(a.length-1,Math.floor(a.length*p))];
const run=async(n,fn)=>{const lat=[];const out=await Promise.all(Array.from({length:n},async(_,i)=>{const t=performance.now();try{const r=await fn(i);lat.push(performance.now()-t);return r}catch(e){lat.push(performance.now()-t);return {status:0,error:String(e)}}}));return {out,lat}};
const login=await api('/api/admin/login','POST',{username:U,password:PW});ok('admin login',login.status===200);
const tag=Date.now().toString(36);
const mk=async(name,repeat)=>{name=name.toLowerCase();await api('/api/admin/events','POST',{name,slug:name+'-'+tag,allow_walkin:true,allow_repeat:repeat});const ev=(await api('/api/admin/events')).body.find(e=>e.slug===name+'-'+tag);return ev};
const evA=await mk('evA',false),evB=await mk('evB',false),evR=await mk('evR',true);
const N=300;
const rows=Array.from({length:N},(_,i)=>({full_name:'Khach '+i,email:`k${i}@a.com`,attendee_code:'A'+i}));
const imp=await api('/api/admin/attendees/import','POST',{event_id:evA.id,rows});ok('batched CSV import '+N,imp.body.inserted===N,JSON.stringify(imp.body));
const imp2=await api('/api/admin/attendees/import','POST',{event_id:evA.id,rows});ok('re-import is additive (0 inserted)',imp2.body.inserted===0&&imp2.body.skipped===N,JSON.stringify(imp2.body));
await api('/api/admin/attendees/import','POST',{event_id:evB.id,rows:rows.slice(0,50).map(r=>({...r,full_name:'B '+r.full_name}))});
// A: each guest hits the endpoint 4 times simultaneously (device retry storm) = 4*N concurrent requests
const A=await run(N*4,i=>dev(evA.slug,'A'+(i%N),{CheckinTime:'2026-11-11 10:00:'+String(i%N).padStart(3,'0')}));
const okc=A.out.filter(r=>r.status===200&&r.body.success).length,dup=A.out.filter(r=>r.body&&r.body.duplicate).length,bad=A.out.filter(r=>![200].includes(r.status)).length;
ok('A: '+N*4+' concurrent device requests -> exactly '+N+' successes',okc===N,`success=${okc} duplicate=${dup} http-errors=${bad}`);
const sum=(await api(`/api/admin/events/${evA.id}/summary`)).body;
ok('A: checked_in == '+N+' (no loss, no double)',sum.checked_in===N&&sum.registered===N,JSON.stringify({reg:sum.registered,in:sum.checked_in}));
const ch=(await api('/api/admin/checkins?event_id='+evA.id)).body;ok('A: checkin rows == '+N,ch.length===N,'rows='+ch.length);
console.log(`   latency (local workerd, not production): p50=${pct(A.lat,.5).toFixed(0)}ms p95=${pct(A.lat,.95).toFixed(0)}ms p99=${pct(A.lat,.99).toFixed(0)}ms max=${Math.max(...A.lat).toFixed(0)}ms`);
// retry with same device timestamp => idempotent 200 duplicate, not an error
const r1=await dev(evA.slug,'A1',{CheckinTime:'2026-11-11 10:00:001'});ok('A: retry returns HTTP 200 + duplicate:true (device stops retrying)',r1.status===200&&r1.body.duplicate===true);
// isolation
const rb=await dev(evB.slug,'A1');ok('D: same code in other event checks in independently',rb.status===200&&rb.body.success===true);
const sumB=(await api(`/api/admin/events/${evB.id}/summary`)).body;ok('D: event B count isolated (1 of 50)',sumB.checked_in===1&&sumB.registered===50,JSON.stringify(sumB));
// unknown face, no code: repeated scans must not create new guests each time
const u=await run(20,()=>dev(evB.slug,'',{EmployeeName:'Khach la',MachineBoxId:'M9'}));
ok('walk-in unknown face x20 -> 1 guest, 1 check-in',u.out.filter(r=>r.body.success).length===1);
// repeat-allowed event: cooldown
await api('/api/admin/attendees/import','POST',{event_id:evR.id,rows:[{full_name:'R1',attendee_code:'R1',email:'r1@a.com'}]});
const rr=await run(10,()=>dev(evR.slug,'R1'));ok('repeat event: 10 rapid re-detections -> 1 check-in (cooldown)',rr.out.filter(r=>r.body.success).length===1);
// LED incremental
const led0=(await (await fetch(BASE+'/api/public/display/'+evA.slug+'?since=0&init=1')).json());
await dev(evA.slug,'newguest-'+tag);
await new Promise(r=>setTimeout(r,1100));
const led1=(await (await fetch(BASE+'/api/public/display/'+evA.slug+'?since='+led0.cursor+'&init=0')).json());
ok('LED: only records newer than cursor',led1.items.length===1&&led1.items[0].id>led0.cursor,JSON.stringify(led1.items.map(i=>i.id)));
const led=await run(500,()=>fetch(BASE+'/api/public/display/'+evA.slug+'?since='+led0.cursor+'&init=0').then(async r=>({status:r.status,body:await r.json()})));
ok('LED: 500 concurrent screens all 200',led.out.every(r=>r.status===200),`p95=${pct(led.lat,.95).toFixed(0)}ms`);
// security
const bad1=await fetch(BASE+'/checkin?key=wrong&event='+evA.slug,{method:'POST',body:'{}'});ok('device without valid key -> 401',bad1.status===401);
let lock=0;for(let i=0;i<10;i++){const r=await fetch(BASE+'/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'nobody'+tag,password:'x'})});if(r.status===429)lock++}
ok('login brute-force throttled (429 after 8 failures)',lock>=1,'429s='+lock);
// lock event
await api(`/api/admin/events/${evR.id}/update`,'POST',{active:0});const lk=await dev(evR.slug,'R1');ok('locked event rejects device check-in (404)',lk.status===404,'status='+lk.status);
// pagination/search
const s=(await api(`/api/admin/attendees?event_id=${evA.id}&limit=5&q=Khach%2029`)).body;ok('admin attendee search+limit',Array.isArray(s)&&s.length>0&&s.length<=5,'rows='+s.length);
const failed=results.filter(r=>!r[0]);console.log(`\n${results.length-failed.length}/${results.length} passed`);process.exit(failed.length?1:0);
