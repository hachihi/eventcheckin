// Mixed-load benchmark (scenario E): device check-ins + LED screens + admin dashboard.
// Run against a STAGING Worker + STAGING D1 only (never the production event):
//   k6 run -e BASE=https://staging.workers.dev -e KEY=<MACHINE_API_KEY> -e EVENT=<slug> -e GUESTS=10000 -e RATE=100 -e SCREENS=10 -e DURATION=10m k6-mixed.js
// Seed first: python3 seed.py --guests 10000 --events 1 > seed.sql ; wrangler d1 execute <staging-db> --remote --file seed.sql
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Counter } from 'k6/metrics';
const BASE = __ENV.BASE, KEY = __ENV.KEY, EVENT = __ENV.EVENT || 'bench-1';
const GUESTS = +__ENV.GUESTS || 10000, RATE = +__ENV.RATE || 50, SCREENS = +__ENV.SCREENS || 5, DUR = __ENV.DURATION || '5m';
const tCheckin = new Trend('checkin_ms', true), tLed = new Trend('led_ms', true), dupes = new Counter('duplicate_responses'), okc = new Counter('checkin_success');
export const options = {
  scenarios: {
    devices: { executor: 'constant-arrival-rate', rate: RATE, timeUnit: '1s', duration: DUR, preAllocatedVUs: Math.max(50, RATE), maxVUs: RATE * 5, exec: 'device' },
    led:     { executor: 'constant-vus', vus: SCREENS, duration: DUR, exec: 'led' },
    admin:   { executor: 'constant-vus', vus: 1, duration: DUR, exec: 'admin' },
  },
  thresholds: {   // acceptance targets from the brief (design goals, not measured facts)
    'checkin_ms': ['p(95)<500', 'p(99)<1000'],
    'led_ms': ['p(95)<300'],
    'http_req_failed': ['rate<0.001'],
  },
};
export function device() {
  const n = Math.floor(Math.random() * GUESTS);              // random guest; ~25% are deliberate re-sends to exercise idempotency
  const ts = new Date().toISOString().slice(0, 19) + '#' + (Math.random() < 0.25 ? 'fixed' : Math.random());
  const r = http.post(`${BASE}/checkin?key=${KEY}&event=${EVENT}`, JSON.stringify({ MachineBoxId: 'K6-' + (__VU % 20), EmployeeCode: 'B' + n, EmployeeName: 'Guest ' + n, CheckinTime: ts }), { headers: { 'content-type': 'application/json' } });
  tCheckin.add(r.timings.duration);
  check(r, { 'device 200': x => x.status === 200 });
  if (r.status === 200) { const b = r.json(); if (b.success) okc.add(1); else if (b.duplicate) dupes.add(1); }
}
let cursor = 0;
export function led() {
  const r = http.get(`${BASE}/api/public/display/${EVENT}?since=${cursor}&init=${cursor ? 0 : 1}`);
  tLed.add(r.timings.duration);
  check(r, { 'led 200': x => x.status === 200 });
  if (r.status === 200) { const b = r.json(); if (b.cursor != null) cursor = Math.max(cursor, b.cursor); (b.items || []).forEach(i => cursor = Math.max(cursor, i.id)); }
  sleepJitter(2.5);
}
export function admin() {
  // set ADMIN_COOKIE (hch_event=...) from a browser login to include dashboard polling
  if (__ENV.ADMIN_COOKIE) http.get(`${BASE}/api/admin/events`, { headers: { cookie: __ENV.ADMIN_COOKIE } });
  sleepJitter(15);
}
import { sleep } from 'k6';
function sleepJitter(s) { sleep(s + Math.random() * 0.3); }
