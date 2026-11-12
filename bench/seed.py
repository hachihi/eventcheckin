#!/usr/bin/env python3
"""Generate SQL to seed a STAGING D1 database. Usage: python3 seed.py --guests 100000 --events 10 --checkins 0 > seed.sql
Then: npx wrangler d1 execute <staging-db> --remote --file seed.sql   (split with --chunk for very large sets)
Guest codes are B0..B{N-1} (matches k6-mixed.js). Photos are NOT seeded (use R2 separately)."""
import argparse
ap=argparse.ArgumentParser();ap.add_argument('--guests',type=int,default=10000);ap.add_argument('--events',type=int,default=1);ap.add_argument('--checkins',type=int,default=0)
a=ap.parse_args();T="'2026-01-01 00:00:00'"
for e in range(1,a.events+1):
    print(f"INSERT OR IGNORE INTO events(slug,name,created_at,allow_walkin,allow_repeat) VALUES('bench-{e}','Bench {e}',{T},0,0);")
per=a.guests//a.events
for e in range(1,a.events+1):
    for s in range(0,per,500):
        vals=",".join(f"((SELECT id FROM events WHERE slug='bench-{e}'),'Guest {i}','B{i}','b{i}@bench.test','Bench Co',{T})" for i in range(s,min(per,s+500)))
        print(f"INSERT INTO attendees(event_id,full_name,attendee_code,email,company,created_at) VALUES {vals};")
if a.checkins:
    print(f"-- synthetic history rows (for table-size tests)")
    for s in range(0,a.checkins,500):
        vals=",".join(f"((SELECT id FROM events WHERE slug='bench-1'),NULL,'Hist {i}','2026-01-01 10:00:00','hist','machine','success')" for i in range(s,min(a.checkins,s+500)))
        print(f"INSERT INTO checkins(event_id,attendee_id,full_name,checkin_time,machine,source,result) VALUES {vals};")
