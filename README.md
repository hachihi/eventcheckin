# HACHIHI EVENT CHECK-IN — v3

> **v3** (11/2026): sửa 2 lỗi chặn hoàn toàn của v2 (giao diện lỗi cú pháp; URL `/checkin` của máy không được route), check-in nguyên tử + chống gửi lại, index đúng, sync Sheets theo lô, LED chịu tải. **Đọc `AUDIT_REPORT.md`** (bằng chứng, giới hạn, triển khai/rollback). Bộ kiểm thử: `bench/` (`npm run test:functional`, `bench/k6-mixed.js`, `bench/explain-plan.py`).
>
> **Nâng cấp từ v2:** (1) cập nhật `apps-script/Code.gs` trước; (2) `wrangler d1 migrations apply … --remote` (có `0003`); (3) `wrangler deploy`. Cron nay chạy **mỗi phút** (outbox Sheets theo lô; mỗi nguồn Sheet vẫn nhập lại mỗi 5 phút).

(Phần dưới là tài liệu gốc v1/v2, giữ nguyên.)

# HACHIHI EVENT CHECK-IN — v1 foundation

A separate Cloudflare Worker application derived conceptually from the existing Hachihi attendance Worker. It does **not** share its Worker name, D1 database, R2 bucket, routes, or tables.

## Confirmed product choices

- Multi-event: one Worker + one D1 can serve multiple event slugs.
- Walk-in: guests can register/check in at the venue; Google Identity check-in is also available.
- Dual display: `/e/<slug>/checkin` for the desk and `/e/<slug>/display` for the LED screen.
- Photos: R2 stores uploaded guest photos and supported machine Base64 photos. Google Drive originals remain in Drive; Apps Script can copy a form-uploaded photo into R2.
- D1 is the source of truth. A durable `sync_outbox` queue sends check-in records to Google Sheets and retries failed deliveries.
- Admin login is separate from Google guest sign-in.

## Files

- `src/worker.js` — Worker and embedded responsive UI.
- `migrations/0001_init.sql` — D1 schema.
- `wrangler.toml` — Worker, D1, R2 and retry cron bindings.
- `apps-script/Code.gs` — Google Sheets receiver + Google Forms submit bridge.
- `sample-attendees.csv` — import template.

## 1. Create independent Cloudflare resources

Run from this folder with Wrangler installed and authenticated:

```bash
npx wrangler d1 create hachihi-event-checkin-db
npx wrangler r2 bucket create hachihi-event-photos
```

Copy the D1 `database_id` returned by Wrangler into `wrangler.toml`, replacing `REPLACE_WITH_NEW_D1_DATABASE_ID`. After deployment, replace `PUBLIC_BASE_URL` with the exact HTTPS Worker URL so Google Sheets receives absolute R2 photo links.

Apply the schema:

```bash
npx wrangler d1 migrations apply hachihi-event-checkin-db --remote
```

Create Worker secrets. Use long random values; do not commit them to GitHub:

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put MACHINE_API_KEY
npx wrangler secret put APPS_SCRIPT_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put APPS_SCRIPT_URL
```

`GOOGLE_CLIENT_ID`, `APPS_SCRIPT_URL`, and the Apps Script integration can be omitted until those features are configured. `SESSION_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `MACHINE_API_KEY` should be configured before production. `ADMIN_PASSWORD` is used only to bootstrap the first admin when the `admins` table is empty; change it in a password manager and do not reuse the attendance app password.

Deploy:

```bash
npx wrangler deploy
```

The Worker creates/ensures its tables on its first request as well as supporting the SQL migration. The migration is the preferred explicit setup path. The `sheet_sources` table is included for direct Google Sheets connections. If upgrading an already-deployed v1 database, run `npx wrangler d1 migrations apply hachihi-event-checkin-db --remote` again before deploying this version; migration `0002_google_sheets_sources.sql` creates the connection registry.

## 2. Create the first event

Open the Worker URL. Sign in using the `ADMIN_USERNAME` and `ADMIN_PASSWORD` secrets. Go to **Sự kiện**, create an event and choose a unique slug, e.g. `hoi-nghi-khach-hang-2026`.

The resulting pages are:

```text
https://YOUR-WORKER.workers.dev/admin
https://YOUR-WORKER.workers.dev/e/hoi-nghi-khach-hang-2026/checkin
https://YOUR-WORKER.workers.dev/e/hoi-nghi-khach-hang-2026/display
```

Open the display URL on the LED/TV browser and press F11 for fullscreen. Keep the display URL private to the venue; it exposes only the event name, guest name, company and guest photo needed for welcome display.

## 3. Configure Google Identity (optional Gmail check-in)

1. Create an OAuth 2.0 Web client in Google Cloud Console.
2. Add the Worker hostname to **Authorized JavaScript origins**.
3. Set `GOOGLE_CLIENT_ID` to the client ID (not the client secret).
4. Redeploy or update the Worker secret.

The check-in page will show the Google sign-in button when this variable is present. Google credential verification is performed by the Worker, including signature, issuer, audience, expiry, email verification and nonce validation.

## 4. Google Forms → Apps Script → Worker → R2/D1

Create a Google Form with these suggested questions (use these labels or update the aliases in `onFormSubmit`):

- Họ và tên (required)
- Email
- Số điện thoại
- Công ty
- Chức danh
- Mã khách
- Ảnh chân dung (file upload, optional)

Link the Form to a Google Sheet. Open **Extensions → Apps Script**, paste `apps-script/Code.gs`, and set Script Properties:

| Property | Value |
|---|---|
| `WORKER_URL` | Worker base URL, no trailing slash |
| `EVENT_SLUG` | Exact event slug |
| `INTEGRATION_SECRET` | Same random secret as Worker `APPS_SCRIPT_SECRET` |
| `SPREADSHEET_ID` | Response spreadsheet ID |
| `CHECKIN_SHEET` | `Checkins` (optional) |

Deploy the Apps Script as a Web App (execute as you, access available to anyone) and set its deployment URL as Worker secret `APPS_SCRIPT_URL`. The shared secret authenticates Worker-to-Sheets delivery.

Run `installFormSubmitTrigger()` once from Apps Script editor and authorize it. On each form submission, Apps Script reads the uploaded Drive image, sends the image bytes to the Worker integration endpoint, and the Worker stores the photo in R2 while upserting the attendee in D1. The original file remains in Drive.

The same Apps Script Web App receives successful check-ins from the Worker and appends them to the `Checkins` tab. Failed deliveries stay in `sync_outbox`; the Worker cron retries pending records.


## 4A. Connect trực tiếp Google Sheets (không cần upload CSV)

Trong trang **Quản trị → Khách tham dự**, dán URL của tab Google Sheet đang nhận câu trả lời từ Google Form vào ô **Kết nối Google Sheets**. URL có thể chứa `gid=...` để chọn đúng tab. Bấm **Kết nối & nhập dữ liệu** để nhập ngay; Worker sẽ tự đọc lại Sheet mỗi 5 phút theo Cron. Có thể bấm **Đồng bộ ngay** bất cứ lúc nào.

Các cột được tự nhận diện theo tên phổ biến: `Họ và tên`, `Email`, `Số điện thoại`, `Công ty`, `Chức danh`, `Mã khách`, `Ảnh chân dung`. Cột tên khách là bắt buộc. Email được dùng làm khóa cập nhật; nếu email đã tồn tại, thông tin sẽ được cập nhật thay vì tạo khách trùng. Sheet gốc chỉ được đọc, Worker không ghi ngược vào Sheet.

**Quyền truy cập:** chế độ đọc trực tiếp bằng URL CSV yêu cầu Google Sheet được chia sẻ **Bất kỳ ai có đường liên kết – Người xem** hoặc Publish to web. Điều này có thể làm lộ dữ liệu đăng ký (email/điện thoại); chỉ dùng với Sheet đã được chủ dữ liệu cho phép công khai. Nếu dữ liệu khách cần riêng tư, không bật chia sẻ công khai: hãy dùng Apps Script `onFormSubmit` ở mục 4 để đẩy từng bản đăng ký sang Worker bằng `INTEGRATION_SECRET`; trigger này không cần công khai Sheet.

**Đăng ký không đồng nghĩa đã check-in:** khi Form gửi thành công, khách tự động được thêm vào danh sách khách mời và sẵn sàng để đối chiếu. Trạng thái chỉ chuyển thành **Đã đến** khi khách thực sự có mặt và quét/nhận diện qua thiết bị, đăng nhập Google tại quầy hoặc được nhân viên xác nhận check-in. Không nên tự đánh dấu khách là đã đến chỉ vì họ gửi Form.

## 5. Import/export attendees

The admin page supports UTF-8 CSV import and export. Excel can open/save this CSV format. Use `sample-attendees.csv` as a template. Supported columns include:

- Họ tên / `full_name`
- Mã khách / `attendee_code`
- Email
- Điện thoại / `phone`
- Công ty / `company`
- Chức danh / `position`

Import is additive: existing duplicate emails in the same event are skipped, not overwritten. Maximum 5,000 rows per import request.

## 6. Connect the existing face-recognition terminal

The existing Worker remains untouched. Configure the terminal to send its familiar JSON payload to the new Worker URL, with the shared key and event slug:

```text
POST https://YOUR-WORKER.workers.dev/checkin?key=YOUR_MACHINE_API_KEY&event=hoi-nghi-khach-hang-2026
Content-Type: application/json
```

The Worker accepts the existing field names `MachineBoxId`, `EmployeeCode`, `EmployeeName`, `CheckinTime`, and `ImageUrl`. It also accepts optional `Email`, `Base64Image`, and `ImageMimeType`. Prefer sending an attendee code that matches the `Mã khách` / `attendee_code` field imported from the guest list. If a guest cannot be matched and walk-in is enabled, the Worker creates a guest record using the device name/code.

The device key is mandatory. The new Worker accepts either `x-device-key: YOUR_MACHINE_API_KEY` or the legacy-style `?key=YOUR_MACHINE_API_KEY` query parameter. Do not put the key in a public web page.

**v3:** `POST /checkin`, `POST /` and `POST /api/device/checkin` are all routed. A duplicate or retried scan returns HTTP 200 with `{"success":false,"duplicate":true}` so the terminal stops retrying. Include a stable `CheckinTime` in the payload: it is the idempotency key together with `MachineBoxId` and `EmployeeCode`.

**Important:** the original attendance Worker accepted unauthenticated machine POSTs if its `SECRET_KEY` variable was empty. This new Worker intentionally fails closed and always requires `MACHINE_API_KEY`.

## 7. Operational notes / current v1 boundaries

- D1 is authoritative; Sheets is a downstream reporting copy. Never treat a Sheets outage as a failed guest check-in.
- R2 stores image objects; D1 stores only R2 object keys and metadata. No Base64 image is stored in D1.
- Device `ImageUrl` and Google profile photo URLs remain external fallbacks; machine `Base64Image`, admin uploads, and Google Forms file uploads are copied into R2.
- Public display polls only incremental records (`id > last seen id`) every 2.5 seconds and shows recent guests. It does not download the complete attendee list.
- Current walk-in page supports manual guest details and optional photo; it does not yet implement a QR ticket scanner, Turnstile CAPTCHA, email OTP, or staff approval queue.
- Current admin UI creates events and manages guest lists/check-in exports; editing/deleting existing events and attendee edit/delete UI are not included in this first implementation.
- Add a Cloudflare WAF rate-limit rule for `/api/public/checkin/*` and `/api/google/checkin/*` before opening the public check-in URL widely. Restrict access to the LED display URL if the guest list is sensitive.
- The display deliberately exposes only guest name, company and photo. Do not add email/phone to its public response.
- Verify the actual face terminal payload and its HTTP method/body limit in a staging event before production. If the terminal only supports a fixed URL and cannot send the key or event slug, configure `DEFAULT_EVENT_SLUG` and `PUBLIC_BASE_URL` and a device gateway capable of adding the `x-device-key` header, or use the query-key form supported above.

## 8. Smoke test checklist

1. `/health` returns `ok: true`.
2. Admin login succeeds with bootstrap credentials.
3. Create a test event.
4. Add a guest with an attendee code and photo; verify `/media/...` returns the photo.
5. Open the check-in page, register a walk-in guest and verify success.
6. Open the LED page in another browser; verify the new guest appears without refreshing.
7. Check admin summary and export CSV.
8. Send a test device POST with the device key and `EmployeeCode` matching the guest code.
9. Verify the check-in appears in D1 and in the `Checkins` Google Sheet.
10. Temporarily break the Apps Script URL, make a check-in, restore it and verify the scheduled retry changes the outbox status to `sent`.

Do not connect the production camera until these checks pass against the new Worker and new D1 database.
