# Reproduces the EXPLAIN QUERY PLAN / timing comparison on plain SQLite (same engine as D1). Usage: python3 explain-plan.py 100000 1000000
# NOTE: pure SQLite timings (no network, no D1 queueing) - they prove index/plan effects, not Cloudflare latency.
import sqlite3, time, random, os, sys
N_ATT=int(sys.argv[1]) if len(sys.argv)>1 else 100000
N_CHK=int(sys.argv[2]) if len(sys.argv)>2 else 1000000
EV=10
db='bench.db'
if os.path.exists(db): os.remove(db)
c=sqlite3.connect(db); c.row_factory=None
schema=open('../migrations/0001_init.sql').read()
c.executescript(schema)
c.execute("PRAGMA synchronous=OFF"); c.execute("PRAGMA journal_mode=MEMORY")
for i in range(1,EV+1):
    c.execute("INSERT INTO events(slug,name,created_at,allow_repeat) VALUES(?,?,?,0)",(f'ev{i}',f'Event {i}','2026-01-01'))
per=N_ATT//EV
c.executemany("INSERT INTO attendees(event_id,full_name,attendee_code,email,company,created_at) VALUES(?,?,?,?,?,?)",
  ((e,f'Guest {e}-{i}',f'C{e}-{i}',f'g{e}_{i}@x.com','Co','2026-01-01') for e in range(1,EV+1) for i in range(per)))
# checkins: each attendee checked in once (until N_CHK), rest as repeat scans
rows=[]
aid=1
for k in range(N_CHK):
    a=(k%N_ATT)+1; e=((a-1)//per)+1
    rows.append((e,a,f'Guest','2026-01-01 10:00:00','machine','machine'))
c.executemany("INSERT INTO checkins(event_id,attendee_id,full_name,checkin_time,machine,source) VALUES(?,?,?,?,?,?)",rows)
c.commit()
print('seeded',N_ATT,'attendees',N_CHK,'checkins')
def t(label,sql,args=(),n=20):
    s=time.perf_counter()
    for _ in range(n): c.execute(sql,args).fetchall()
    ms=(time.perf_counter()-s)*1000/n
    plan=' | '.join(r[3] for r in c.execute('EXPLAIN QUERY PLAN '+sql,args))
    print(f'{label:34s} {ms:9.3f} ms  {plan}')
def suite(tag):
    print('==',tag)
    A=per//2+1  # attendee id in event 1
    t('dup-check (event,attendee)','SELECT id,checkin_time FROM checkins WHERE event_id=? AND attendee_id=? ORDER BY id DESC LIMIT 1',(1,A+ (EV-1)*0),5)
    t('dup-check worst (not checked in)','SELECT id,checkin_time FROM checkins WHERE event_id=? AND attendee_id=? ORDER BY id DESC LIMIT 1',(1,10**9),3)
    t('LED poll id>since','SELECT id,full_name,company,photo_url,checkin_time FROM checkins WHERE event_id=? AND id>? AND result=\'success\' ORDER BY id LIMIT 8',(1,500000))
    t('summary distinct attendees','SELECT COUNT(DISTINCT attendee_id) FROM checkins WHERE event_id=? AND result=\'success\'',(1,),3)
    t('machine lookup code OR email','SELECT * FROM attendees WHERE event_id=? AND (attendee_code=? OR email=?)',(1,'C1-500','c1-500'))
    t('machine lookup code only','SELECT * FROM attendees WHERE event_id=? AND attendee_code=?',(1,'C1-500'))
    t('admin list w/ EXISTS (LIMIT 5000)','SELECT a.id,a.full_name,EXISTS(SELECT 1 FROM checkins c WHERE c.event_id=a.event_id AND c.attendee_id=a.id) ci FROM attendees a WHERE a.event_id=? ORDER BY a.full_name LIMIT 5000',(1,),1)
suite('BEFORE (schema v2 indexes)')
c.executescript("""
CREATE INDEX IF NOT EXISTS idx_checkins_event_attendee ON checkins(event_id,attendee_id,id);
DROP INDEX IF EXISTS idx_checkins_event_time;
DROP INDEX IF EXISTS idx_attendees_event_email;
""")
c.execute('ANALYZE'); c.commit()
suite('AFTER (v3: idx_checkins_event_attendee, drop 2 unused)')
