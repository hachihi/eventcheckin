# Hướng dẫn triển khai HACHIHI EVENT CHECK-IN v3 — từng bước

Cách làm: **GitHub → Cloudflare tự lấy code và deploy**. Không cần cài phần mềm trên máy.
Thời gian: khoảng 45–60 phút lần đầu. **Làm xong hết rồi mới nối máy chấm công thật; luôn thử với sự kiện thử.**

Bạn cần: tài khoản GitHub, tài khoản Cloudflare, tài khoản Google (để dùng Sheets/Drive).

Quy ước: `<…>` là chỗ bạn thay bằng giá trị của mình. Tên nút trên giao diện Cloudflare/Google có thể khác đôi chút so với mô tả.

---

## PHẦN 1 — Đưa mã lên GitHub

1. Đăng nhập GitHub → **New repository**. Đặt tên (ví dụ `hachihi-event-checkin`), chọn **Private**, tạo.
2. Giải nén file zip. Vào **bên trong** thư mục `HACHIHI_EVENT_CHECKIN_v3`.
3. Trong repo chọn **Add file → Upload files**, kéo toàn bộ **nội dung bên trong** thư mục đó vào (để `wrangler.toml` nằm ngay ở gốc repo, không nằm trong thư mục con). Bấm **Commit changes**.
4. Kiểm tra: ở trang chính của repo phải thấy ngay `wrangler.toml`, `src/`, `migrations/`, `apps-script/`.

> Không đưa file `.dev.vars` lên GitHub (chứa khóa thật). Bản zip không có file này.

## PHẦN 2 — Tạo cơ sở dữ liệu D1

1. Cloudflare Dashboard → **Storage & databases → D1 SQLite Database → Create**.
2. Đặt tên: `hachihi-event-checkin-db`. Tạo.
3. Mở database vừa tạo, **sao chép `Database ID`** (chuỗi dạng `xxxxxxxx-xxxx-...`).
4. Về GitHub, mở file `wrangler.toml` → biểu tượng bút chì (Edit) → thay `REPLACE_WITH_NEW_D1_DATABASE_ID` bằng ID vừa sao chép → **Commit changes**.
5. Cùng file đó, kiểm tra dòng `name = "eventcheckin"`. Tên này **phải trùng tên Worker** bạn sẽ tạo ở Phần 3. Nếu muốn đặt tên khác, sửa dòng này cho khớp.

> Không cần tạo R2. Ảnh lưu trên Google Drive (Phần 5).

## PHẦN 3 — Tạo Worker từ GitHub

1. Cloudflare → **Workers & Pages → Create → Import a repository** (hoặc *Connect to Git*).
2. Cho phép Cloudflare truy cập GitHub, chọn repo vừa tạo.
3. Tên Worker: nhập đúng như `name` trong `wrangler.toml` (`eventcheckin`). Lệnh deploy: `npx wrangler deploy`. Nhánh: `main`.
4. Bấm **Save and Deploy**, đợi build xong.
5. Mở **Worker → Settings → Domains & Routes**: sẽ thấy địa chỉ `https://eventcheckin.<tên-tài-khoản>.workers.dev`. Đây là địa chỉ hệ thống của bạn, gọi là `<WORKER_URL>` ở các bước sau.

Lúc này mở `<WORKER_URL>` sẽ báo "Missing SESSION_SECRET" — đúng, vì chưa đặt khóa (Phần 4).

## PHẦN 4 — Đặt khóa bí mật

1. Worker → **Settings → Variables and Secrets → Add**.
2. Thêm lần lượt, mỗi cái chọn loại **Secret** (không chọn Text):

| Tên | Giá trị |
|---|---|
| `SESSION_SECRET` | chuỗi ngẫu nhiên ≥ 40 ký tự |
| `ADMIN_USERNAME` | tên đăng nhập admin |
| `ADMIN_PASSWORD` | mật khẩu mạnh |
| `MACHINE_API_KEY` | chuỗi ngẫu nhiên cho máy chấm công (khác các khóa khác) |

3. Bấm **Deploy** để khóa có hiệu lực.
4. Mở `<WORKER_URL>/health?deep=1` → phải thấy `"ok":true`.

Cơ sở dữ liệu tự tạo bảng ở lần truy cập đầu tiên. Nếu bạn có máy cài Node.js, nên chạy thêm để áp migration chuẩn: `npx wrangler d1 migrations apply hachihi-event-checkin-db --remote`.

## PHẦN 5 — Google Sheets và Google Drive (Apps Script)

Bỏ qua phần này nếu chỉ cần check-in cơ bản (khi đó không có ảnh và không có bản sao Sheet).

1. Tạo (hoặc mở) một Google Sheet. Vào **Extensions → Apps Script**.
2. Xóa mã mẫu, dán toàn bộ nội dung file `apps-script/Code.gs`. Lưu.
3. **Project Settings (bánh răng) → Script Properties → Add**:

| Tên | Giá trị |
|---|---|
| `INTEGRATION_SECRET` | một chuỗi ngẫu nhiên dài (ghi lại, dùng ở bước 6) |
| `DRIVE_FOLDER_ID` | (tùy chọn) ID thư mục Drive lưu ảnh; bỏ trống thì script tự tạo thư mục "HACHIHI Event Photos" |
| `WORKER_URL`, `EVENT_SLUG` | chỉ cần nếu dùng Google Form đăng ký: `<WORKER_URL>` và mã URL sự kiện |
| `SPREADSHEET_ID` | chỉ cần nếu script **không** nằm trong Sheet (tạo riêng ở script.google.com) |

4. **Deploy → New deployment → Web app**: *Execute as* = **Me**, *Who has access* = **Anyone**. Deploy, cấp quyền Sheets và Drive khi Google hỏi.
5. Sao chép **Web app URL** (dạng `https://script.google.com/macros/s/.../exec`).
6. Quay lại Cloudflare → Worker → Settings → Variables and Secrets, thêm 2 **Secret**:

| Tên | Giá trị |
|---|---|
| `APPS_SCRIPT_URL` | Web app URL ở bước 5 |
| `APPS_SCRIPT_SECRET` | **đúng chuỗi** `INTEGRATION_SECRET` ở bước 3 |

7. **Deploy** lại Worker.

> Mỗi lần sửa `Code.gs`, phải vào *Deploy → Manage deployments* và chọn phiên bản mới, nếu không đường link vẫn chạy mã cũ.
> "Anyone" là bắt buộc vì Worker gọi vào không có đăng nhập Google; an toàn nhờ chuỗi bí mật.

## PHẦN 6 — Tạo sự kiện thử và nhập khách

1. Mở `<WORKER_URL>/admin`, đăng nhập bằng tài khoản ở Phần 4.
2. Mục **Tạo / cập nhật sự kiện**: nhập tên và **mã URL** (ví dụ `thu-nghiem-2026`, chữ thường, không dấu). Bật cho phép khách tại chỗ nếu cần.
3. Nhập danh sách khách, chọn một cách:
   - **CSV:** dùng file mẫu `sample-attendees.csv` (cột: Họ tên, Mã khách, Email, Điện thoại, Công ty, Chức danh), nhập ở tab Khách tham dự.
   - **Google Sheets:** mục *Kết nối Google Sheets*, dán link Sheet. Sheet phải chia sẻ "Người có đường liên kết – Người xem" (cân nhắc dữ liệu cá nhân) hoặc Publish to web. Hệ thống tự cập nhật mỗi 5 phút.
4. Mỗi khách cần **email hoặc mã khách**.

Các địa chỉ của sự kiện:
- Quầy check-in: `<WORKER_URL>/e/<mã-url>/checkin`
- Màn hình LED: `<WORKER_URL>/e/<mã-url>/display` (nhấn `F` để toàn màn hình)

## PHẦN 7 — Kiểm tra trước khi nối máy thật

Chạy trong terminal (thay giá trị thật). `Mã khách` là một mã có trong danh sách khách:

```
curl -X POST "<WORKER_URL>/checkin?key=<MACHINE_API_KEY>&event=<mã-url>" \
  -H "content-type: application/json" \
  -d '{"MachineBoxId":"TEST1","EmployeeCode":"<Mã khách>","EmployeeName":"Test","CheckinTime":"2026-11-12 09:00:00"}'
```

Kỳ vọng:
1. Lần đầu: `"success":true`. Màn hình LED hiện tên khách.
2. Gửi lại đúng lệnh đó: `"duplicate":true` (HTTP 200).
3. Đổi `key=` thành giá trị sai: `401`.
4. Tab **Lịch sử check-in** trong admin có 1 dòng; tab Tổng quan tăng 1.
5. Nếu bật Sheets: sau tối đa ~1 phút, tab `Checkins` trong Google Sheet có dòng mới.
6. Nếu bật Drive: thử check-in kèm ảnh, thư mục Drive có file mới.
7. Xuất CSV khách và lịch sử, kiểm tra nội dung.

## PHẦN 8 — Nối máy nhận diện khuôn mặt

Cấu hình máy gửi dữ liệu theo:

```
POST <WORKER_URL>/checkin?key=<MACHINE_API_KEY>&event=<mã-url>
```

JSON gồm: `MachineBoxId`, `EmployeeCode` (khớp "Mã khách"), `EmployeeName`, `CheckinTime`, và tùy chọn `Base64Image`.

Cần xác nhận với máy thật:
- Máy gửi `CheckinTime` **giống nhau khi gửi lại** cùng một lần quét (đây là khóa chống trùng).
- Máy coi **HTTP 200 là thành công**, kể cả khi `duplicate:true`.
- `EmployeeCode` trên máy khớp "Mã khách" trong danh sách.

## PHẦN 9 — Xem nhật ký khi vận hành

- Cloudflare → Worker → **Observability / Logs** (đã bật). Lọc theo từ khóa: `checkin`, `device_unauthorized`, `login_fail`, `outbox_error`, `sheet_sync_error`, `drive_upload_error`, `error`.
- Xem trực tiếp (máy có Node.js): `npx wrangler tail eventcheckin --format pretty`.
- Nhật ký thao tác quản trị: `<WORKER_URL>/api/admin/audit` (sau khi đăng nhập admin).
- Hàng đợi Sheets: `<WORKER_URL>/api/admin/sync/status`.
- Log không chứa khóa, mật khẩu, email, ảnh hay query string.

## PHẦN 10 — Trước ngày sự kiện

- [ ] Sự kiện trên ~5.000 khách hoặc bật Sheets: nâng **Workers Paid** (gói Free giới hạn 100.000 lượt ghi/ngày và từ chối truy vấn khi vượt).
- [ ] Bật rate-limit trong Cloudflare **Security → WAF** cho `/api/public/checkin/*` và `/api/google/checkin/*`.
- [ ] Sao lưu: `npx wrangler d1 export hachihi-event-checkin-db --remote --output backup.sql`.
- [ ] Chạy thử đủ Phần 7 với **máy thật** và **số khách thật**.
- [ ] (Khuyến nghị) Chạy `bench/k6-mixed.js` trên môi trường thử để đo tải thực tế.
- [ ] Chuẩn bị màn hình LED: mở link display, nhấn `F`, tắt chế độ ngủ của máy.

## Nâng cấp từ v2

1. **Cập nhật Apps Script (`Code.gs`) trước** và deploy lại Web app. Nếu sai thứ tự, mỗi lô check-in ghi một dòng trống vào Sheet.
2. Sao lưu D1 (lệnh ở Phần 10).
3. Commit mã mới lên GitHub; Cloudflare tự deploy. Áp migration `0003` nếu có thể.
4. Quay lại bản cũ khi cần: Worker → Deployments → chọn phiên bản trước → Rollback. Cấu trúc v3 tương thích ngược.

## Xử lý sự cố

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| `Missing SESSION_SECRET` | Biến thêm dạng Text, hoặc chưa deploy lại | Thêm lại dạng **Secret**, bấm Deploy |
| Error 1031 `Invalid Workers Preview configuration` | Lỗi hạ tầng workers.dev / bản deploy hỏng | Kiểm tra Deployments/Builds; Settings → Domains & Routes bật lại workers.dev; đảm bảo `name` trong `wrangler.toml` trùng tên Worker; deploy lại |
| Build lỗi về D1 / `database_id` | `database_id` sai hoặc còn chữ `REPLACE_WITH…` | Sửa `wrangler.toml` đúng ID, commit |
| Máy quét nhưng không có check-in | Sai `key`, sai `event` (mã URL), `EmployeeCode` không khớp | Xem log `device_unauthorized` / `checkin` (`rejected_unregistered`) |
| Máy gửi lại liên tục | Máy coi HTTP 200 là lỗi | Cấu hình máy chấp nhận 200 |
| Sheet không có dòng mới | `APPS_SCRIPT_URL`/`SECRET` sai, hoặc Apps Script chưa deploy bản mới | Xem `/api/admin/sync/status` và log `outbox_error`; secret hai bên phải giống nhau |
| `unauthorized` từ Apps Script | `INTEGRATION_SECRET` ≠ `APPS_SCRIPT_SECRET` | Đặt lại cho cùng giá trị |
| LED hiện chữ cái thay vì ảnh | Ảnh Drive chưa tải xong, hoặc chưa cấu hình Apps Script | Chờ vài giây; kiểm tra Phần 5 và log `drive_upload_error` |
| Đăng nhập bị khóa (429) | Nhập sai ≥ 8 lần trong 15 phút | Đợi 15 phút rồi thử lại |
| Check-in dừng giữa chừng trên gói Free | Vượt hạn mức D1 trong ngày | Nâng Workers Paid |

Nếu vẫn lỗi, gửi cho đội kỹ thuật: dòng lỗi, ảnh chụp tab Deployments/Builds, và các dòng log liên quan.
