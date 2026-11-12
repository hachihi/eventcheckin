# HACHIHI EVENT CHECK-IN — Báo cáo audit & nâng cấp v3

Phạm vi: mã nguồn `HACHIHI_EVENT_CHECKIN_v2_GOOGLE_SHEETS.zip` (Worker 308 dòng, 3 migration SQL, Apps Script).
Ngày: 11/11/2026. **Không đụng tới Worker chấm công cũ** — v3 vẫn là Worker/D1/R2 độc lập.

> **Đọc trước:** báo cáo này tách bạch 3 loại thông tin: **[ĐÃ ĐO]** (chạy thật trong sandbox), **[ĐỌC MÃ]** (kết luận từ đọc mã, chưa tái hiện được), **[ƯỚC TÍNH / CHƯA ĐO]**. Việc tải thật lên Cloudflare (P50/P95/P99 ở 1.000–3.000 request) và so sánh Supabase **chưa thực hiện** vì cần staging Cloudflare/Supabase của bạn; bộ công cụ để chạy đã có trong `bench/`.

---
## 1. Lỗi nghiêm trọng tìm được trong v2 (đã sửa trong v3)

| # | Mức | Phát hiện | Bằng chứng | Sửa trong v3 |
|---|---|---|---|---|
| 1 | **Chặn hoàn toàn** | Script giao diện nhúng có **lỗi cú pháp** (`'\n'` trong template literal → xuống dòng thật trong `parseCsv`). Trình duyệt không chạy được toàn bộ script ⇒ trang admin, quầy check-in và màn hình LED đều không hoạt động. | [ĐÃ ĐO] `node --check` trên script trích từ bản gốc → `SyntaxError`; bản v3 → OK | Đổi thành `'\\n'`; thêm bước kiểm tra cú pháp UI |
| 2 | **Chặn hoàn toàn** | URL máy chấm công trong README (`POST /checkin?key=…`) **không được route** (route nằm trong khối `/api/`). Worker trả trang HTML **HTTP 200** ⇒ máy tưởng thành công nhưng **không có check-in nào được ghi**. Chỉ `/api/device/checkin` hoạt động. | [ĐÃ ĐO] `curl -X POST /checkin` trên bản gốc → `200 text/html` | Route `POST /` và `POST /checkin` ra ngoài khối `/api/` |
| 3 | Cao | Sync Google Sheets & import CSV chạy **1–2 truy vấn D1 cho mỗi dòng**. Giới hạn chính thức: **50 truy vấn/lần gọi Worker (Free), 1.000 (Paid)**. ⇒ Sheet > ~25–500 dòng hoặc CSV > ~1.000 dòng sẽ **dừng giữa chừng**. Nhập 5.000 khách = ~5.000–10.000 truy vấn. | [ĐỌC MÃ] + giới hạn tại developers.cloudflare.com/d1/platform/limits | Upsert theo lô (`DB.batch`, 200 câu/lô): 5.000 dòng ≈ 25 lần gọi |
| 4 | Cao | Dòng Sheet **không có email** bị **chèn lại mỗi 5 phút** (không có khóa xung đột) ⇒ danh sách khách phình trùng liên tục. | [ĐỌC MÃ] | Dòng phải có email hoặc mã khách; có `NOT EXISTS` |
| 5 | Cao | Kiểm tra trùng check-in là *SELECT rồi INSERT* (không nguyên tử) và không có ràng buộc duy nhất ⇒ hai request đồng thời (thiết bị gửi lại, 2 máy quét cùng người) **có thể cùng ghi**. | [ĐỌC MÃ] — **không tái hiện được** trên workerd cục bộ (chạy 1.200 request đồng thời cho 300 khách trên v2: 0 trùng) nên chưa thể nói đã xảy ra thực tế | `INSERT … SELECT … WHERE NOT EXISTS` + khóa idempotency + unique index — loại bỏ về cấu trúc |
| 6 | Cao | Thiếu index `checkins(event_id, attendee_id)`: kiểm tra trùng và cột "Đã đến" của danh sách admin **quét toàn bộ check-in của sự kiện**. | [ĐÃ ĐO] bảng bên dưới | Thêm `idx_checkins_event_attendee` |
| 7 | Trung bình | Khách chưa đăng ký quét bằng máy, không có mã ⇒ **mỗi lần quét tạo 1 khách mới** (NULL không vi phạm `UNIQUE(event_id,email)`). | [ĐỌC MÃ] | Mã tự sinh `AUTO-…` + unique index riêng |
| 8 | Trung bình | Mỗi check-in gọi Apps Script riêng trong `waitUntil`. 1.000 check-in dồn ⇒ 1.000 lượt gọi tới Apps Script (có hạn mức/đồng thời) ⇒ hàng loạt lỗi rồi retry. Apps Script không idempotent ⇒ retry sau lỗi mất phản hồi **ghi dòng Sheet trùng**. | [ĐỌC MÃ] | Cron mỗi phút gửi **theo lô 100 dòng**; Apps Script khóa + khử trùng theo `checkin_id`; trạng thái `dead` sau 25 lần |
| 9 | Trung bình | Thiết bị gửi lại → 409. Nhiều máy coi non-2xx là lỗi và **thử lại liên tục**. Ảnh Base64 vẫn bị ghi lên R2 trước khi phát hiện trùng (rác R2 + phí ghi). | [ĐỌC MÃ] | Trùng/retry trả **HTTP 200 + `duplicate:true`**, kiểm tra trùng **trước** khi xử lý ảnh |
| 10 | Trung bình | Lỗi hiển thị: check-in trùng trả 409 không có `error` ⇒ giao diện chỉ hiện "Có lỗi xảy ra". | [ĐỌC MÃ] | Thông báo "Bạn đã check-in lúc …" |
| 11 | Trung bình | LED: hiển thị mỗi khách cố định 6,5 s, mỗi lần lấy tối đa 8 ⇒ **tối đa ~9 khách/phút**; hàng đợi dồn trễ hàng phút khi đông. Polling bằng `setInterval` (có thể chồng nhau), không backoff khi mất mạng. | [ĐỌC MÃ] | Thời gian hiển thị thích ứng (6,5 s → 3 s → 1,5 s theo độ dài hàng đợi), polling tự lên lịch + jitter + backoff, chỉ báo LIVE/MẤT KẾT NỐI, giữ màn hình sáng, F/double-click = toàn màn hình, ảnh lỗi → chữ cái đầu |
| 12 | Trung bình | `init()` chạy ~14 câu DDL ở mỗi isolate khởi động nguội. | [ĐỌC MÃ] | 1 lần `batch` kiểm tra; chỉ tạo schema khi thiếu |
| 13 | Thấp–TB | Không chống dò mật khẩu admin; so sánh khóa thiết bị không constant-time; không có nhật ký thao tác quản trị; không khóa/mở sự kiện từ giao diện; ảnh walk-in tải nguyên bản (≤6 MB) lên LED. | [ĐỌC MÃ] | Khóa 8 lần sai/tài khoản/15 phút (IP: 40 — vì cả hội trường dùng chung IP); `safeEq`; bảng `audit_logs`; nút Khóa/Mở sự kiện; thu nhỏ ảnh ≤900 px phía trình duyệt |

## 2. Bằng chứng truy vấn — [ĐÃ ĐO] SQLite thuần (cùng engine với D1), 100.000 khách / 1.000.000 check-in / 10 sự kiện

`bench/explain-plan.py`. **Đây là thời gian engine, không gồm mạng/hàng đợi D1** — chứng minh hiệu ứng index, không phải độ trễ Cloudflare.

| Truy vấn | v2 | v3 | Plan v3 |
|---|---:|---:|---|
| Kiểm tra trùng (khách chưa check-in — trường hợp xấu nhất) | 22,96 ms | **0,006 ms** | `idx_checkins_event_attendee (event_id, attendee_id)` |
| Kiểm tra trùng (khách đã check-in) | 1,02 ms | **0,027 ms** | như trên |
| Tìm khách theo `mã OR email` | 1,27 ms | **0,012 ms** | `MULTI-INDEX OR` |
| Danh sách admin có cột "Đã đến" (5.000 dòng) | **1.193 ms** | **5,3 ms** | covering index |
| LED `id > since` | 0,016 ms | 0,013 ms | đã tối ưu sẵn (`event_id, id`) |
| Đếm khách đã đến (distinct) | 23,4 ms | 25,8 ms | không đổi — chỉ chạy ở trang admin, chấp nhận được |

Index bỏ đi (chi phí ghi, không truy vấn nào dùng): `idx_checkins_event_time`, `idx_attendees_event_email` (trùng với `UNIQUE(event_id,email)`). D1 tính phí theo *rows written* gồm cả ghi index.

## 3. Kiểm thử chức năng & đồng thời — [ĐÃ ĐO] Worker + D1 chạy cục bộ (`wrangler dev`), `bench/functional-test.mjs`

17/17 đạt, lặp 3 lần liên tiếp, cả khi schema đến từ migration lẫn từ fallback tự tạo. Gồm:

- 1.200 request đồng thời cho 300 khách (mỗi người gửi 4 lần) → **đúng 300 check-in, 900 phản hồi `duplicate`, 0 lỗi HTTP, 0 mất, 0 trùng**.
- Import 300 khách theo lô; import lại → 0 chèn thêm.
- Retry cùng `CheckinTime` → HTTP 200 + `duplicate:true`.
- 2 sự kiện cùng mã khách → độc lập, thống kê theo sự kiện đúng.
- 20 lượt quét đồng thời khuôn mặt lạ không mã → 1 khách, 1 check-in. *(Test này đã bắt được một race thật trong bản nháp v3 → thêm unique index `AUTO-%`.)*
- Sự kiện `allow_repeat`: 10 lần phát hiện liên tiếp → 1 check-in (cooldown 30 s).
- LED: chỉ trả bản ghi mới hơn con trỏ; 500 màn hình đồng thời đều 200.
- Khóa thiết bị sai → 401; dò mật khẩu → 429; sự kiện đã khóa → 404.
- Outbox → Apps Script giả: lỗi lần đầu → các dòng bị hoãn có backoff, các lô còn lại gửi được; gửi lại đủ 216/216, không trùng.

**Cảnh báo:** độ trễ đo cục bộ (P50 ≈ 8,5 s cho 1.200 request cùng lúc) là do workerd/SQLite cục bộ xử lý tuần tự trên một máy; **không dùng làm số liệu Cloudflare**.

## 4. Trả lời 10 câu hỏi mục XII — nói rõ cái gì đã/chưa trả lời được

1. **D1 có đáp ứng 1.000 khách đồng thời?** *Chưa đo trên Cloudflare.* Suy luận (không phải số đo): tài liệu D1 nêu truy vấn ~1 ms ⇒ ~1.000 truy vấn/giây/DB, ghi mất "vài ms". Một check-in v3 = 1 batch (2 câu). Thực tế 1.000 khách đến *trong cùng một giây* không xảy ra: cổng quét/khuôn mặt giới hạn thông lượng; 3.000 khách trong 15 phút ≈ 3,3/giây, đỉnh ×10 ≈ 33/giây — thấp xa trần lý thuyết. **Phải chạy `bench/k6-mixed.js` trên staging để xác nhận.**
2. **3.000 đồng thời?** Như trên — chưa đo.
3. **Điểm nghẽn:** trong v2 là *truy vấn* (thiếu index, vòng lặp từng dòng, vượt giới hạn số truy vấn/lần gọi), *thiết kế polling LED* (hàng đợi) và *gọi Apps Script từng check-in* — không phải bản thân D1. R2: chưa là điểm nghẽn; ảnh máy Base64 vẫn chưa resize phía server.
4. **Nếu giữ D1 cần gì:** đã làm: index, upsert theo lô, idempotency, outbox theo lô, cache vi mô LED, giảm index thừa.
5. **Supabase nhanh hơn bao nhiêu %?** *Không đo.* Không có số liệu thì không kết luận (đúng nguyên tắc của tài liệu yêu cầu).
6. **Độ trễ mạng của Supabase:** D1 truy cập qua binding trong hạ tầng Cloudflare; Supabase thêm 1 chặng mạng Worker→Postgres (và pooler) cho **mỗi** truy vấn. Một check-in v3 cần ≥2 chặng tuần tự (tìm khách, ghi). Đây là rủi ro *thiết kế*, độ lớn phụ thuộc region — cần đo.
7–8. **Chi phí / ổn định:** xem mục 5. D1 ít thành phần vận hành hơn.
9. **Mức thay đổi mã:** v3 chỉ sửa trong cùng kiến trúc (Worker.js, 1 migration, Code.gs).
10. **Đề xuất:** **giữ D1 + tối ưu (Phương án A, đã triển khai trong v3)**. Chỉ cân nhắc Supabase nếu benchmark staging sau v3 vẫn không đạt ngưỡng.

## 5. Chi phí & hạn mức (D1 — nguồn chính thức, truy cập 11/11/2026)

| | Workers **Free** | Workers **Paid** |
|---|---|---|
| Rows read | 5 triệu/ngày | 25 tỷ/tháng gồm sẵn, sau đó $0,001/triệu |
| Rows written | **100.000/ngày** | 50 triệu/tháng gồm sẵn, sau đó $1,00/triệu |
| Truy vấn / lần gọi Worker | **50** | 1.000 |
| Dung lượng DB | 500 MB | 10 GB |
| Time Travel (khôi phục) | 7 ngày | 30 ngày |

**Quan trọng:** từ **01/09/2026** truy vấn D1 trên gói Free **bị từ chối** khi vượt hạn mức đọc/ghi ngày ⇒ vượt = **sự kiện dừng check-in giữa chừng**, không chỉ tính phí. Reset 00:00 UTC (= 07:00 giờ VN, tức **giữa buổi sáng sự kiện**).

Ước tính rows written (**[ƯỚC TÍNH từ schema, chưa đo `meta.rows_written`]**): đăng ký ≈ 4 dòng/khách (bảng + 3 index); check-in ≈ 4 dòng, ≈ 10 dòng nếu bật đồng bộ Sheets (outbox + index + cập nhật trạng thái).

| Quy mô | Ghi/ngày (ước tính) | Gói D1 phù hợp |
|---|---:|---|
| 1.000 khách | ~14.000 | Free đủ |
| 10.000 khách | ~140.000 | **Vượt Free (100.000)** → Paid |
| 50.000 khách | ~700.000 | Paid (nằm trong 50 triệu/tháng gồm sẵn; chi phí chủ yếu là phí nền Workers Paid) |

Khuyến nghị: **sự kiện > ~5.000 khách hoặc bật Sheets → dùng Workers Paid**. Phí nền Workers Paid, giá R2, giá/hạn mức Supabase Free/Pro: **chưa xác minh** trong báo cáo này — DEV cần đối chiếu trang giá hiện hành trước khi lập dự toán.

## 6. Phương án kiến trúc

- **A — Giữ D1 + tối ưu: ĐÃ LÀM (v3).**
- **B — D1 Read Replication:** *chưa triển khai.* Điều kiện: LED/dashboard chấp nhận dữ liệu cũ vài giây; check-in/dedupe **luôn đọc primary**. Hiện LED đã giảm tải bằng cache 1 s/isolate; chỉ nên làm nếu benchmark cho thấy đọc là điểm nghẽn. Cần xác minh độ trễ replica & giới hạn hiện hành.
- **C — Supabase:** *không khuyến nghị* khi chưa có benchmark chứng minh; kéo theo viết lại toàn bộ truy vấn, thêm pooler, thêm độ trễ mạng mỗi truy vấn, thêm 1 dịch vụ vận hành.

## 7. Triển khai & rollback

**Trước khi làm gì:** `npx wrangler d1 export hachihi-event-checkin-db --remote --output backup-$(date +%F).sql` (và nhớ Time Travel 7/30 ngày).

1. **Cập nhật Apps Script (`Code.gs`) TRƯỚC.** Bản mới nhận cả 1 dòng lẫn lô (`rows[]`). *Nếu deploy Worker v3 mà Apps Script cũ còn chạy, mỗi lô sẽ ghi 1 dòng Sheet trống.*
2. Kiểm tra mã khách trùng (nên unique theo sự kiện): `SELECT event_id,attendee_code,COUNT(*) c FROM attendees WHERE attendee_code IS NOT NULL GROUP BY 1,2 HAVING c>1;`
3. `npx wrangler d1 migrations apply hachihi-event-checkin-db --remote` (0003: thêm cột/bảng/index, bỏ 2 index thừa — **cộng thêm, không xóa dữ liệu**).
4. `npx wrangler deploy` (cron đổi sang mỗi phút; thêm biến `REPEAT_COOLDOWN_SEC`).
5. Smoke test (README §8) trên **sự kiện thử** trước khi nối máy thật.

**Rollback:** `npx wrangler rollback` (hoặc deploy lại mã v2). Schema v3 tương thích ngược (cột `idem_key`, `ok`, `content_hash` có thể NULL; v2 không dùng). Code.gs mới tương thích cả Worker v2. Không cần hoàn tác migration.

## 8. Chưa làm / việc còn lại (trung thực)

1. **Benchmark thật trên Cloudflare** (10 → 3.000 đồng thời; 30 phút/2 giờ/6 giờ; mixed load) và **so sánh Supabase** — chạy `bench/k6-mixed.js` trên staging; k6 chưa được chạy ở đây.
2. **Cần thử với máy thật:** (a) máy có gửi `CheckinTime` ổn định khi gửi lại không (idempotency dựa vào đó; nếu không, chỉ còn lớp chống trùng theo khách/cooldown); (b) máy chấp nhận HTTP 200 + `duplicate:true`.
3. **Ảnh máy (Base64) chưa resize phía server** — cần Cloudflare Images/Image Resizing hoặc giới hạn kích thước ở máy; hiện LED tải ảnh nguyên bản cho khách đăng ký bởi máy.
4. Rate-limit cho `/api/public/checkin/*`, `/api/google/checkin/*` (WAF/Turnstile) — cấu hình ở Cloudflare, chưa nằm trong mã.
5. URL LED công khai theo slug: nên thêm token nếu danh sách nhạy cảm.
6. Chưa có sửa/xóa khách, chính sách lưu trữ/xóa dữ liệu cá nhân, export > vài chục nghìn dòng dạng streaming.
7. `PBKDF2 150.000 vòng` khi đăng nhập có thể tốn CPU trên gói Free (giới hạn CPU/lần gọi) — chưa kiểm chứng.
8. Mã khách chưa bắt buộc duy nhất theo sự kiện (chỉ mã `AUTO-…`), để không làm hỏng dữ liệu hiện có.

## 9. Thay đổi hành vi cần biết

- Máy chấm công nhận **HTTP 200 + `duplicate:true`** (v2: 409) khi check-in trùng/gửi lại.
- Google Sheets cập nhật **trễ tối đa ~1 phút** (v2: gần tức thời) — đổi lấy việc không dội Apps Script lúc đông.
- Sync Sheet bỏ qua dòng không có email lẫn mã khách; không ghi lại khi nội dung Sheet không đổi.
- Hết sự kiện `allow_repeat`: nhiều lần phát hiện trong 30 s chỉ tính 1.

## 10. Bản đóng gói cuối — lưu ảnh bằng Google Drive (không dùng R2)
R2 là tùy chọn (khai báo binding thì dùng). Mặc định ảnh lưu Google Drive qua Apps Script (khóa ảnh dạng `drive:<id>`). [ĐÃ ĐO] cục bộ với Apps Script giả: 17/17 test chức năng đạt không có R2; ảnh từ máy và từ quầy walk-in đều ra URL Drive trên LED. [CHƯA KIỂM TRA] Drive/Apps Script thật, hạn mức Drive & Apps Script, và việc trình duyệt tải ảnh `drive.google.com/thumbnail` ổn định ở quy mô lớn.
