# HACHIHI EVENT CHECK-IN v3 — Hướng dẫn triển khai nhanh

Hệ thống độc lập hoàn toàn với Worker chấm công cũ (Worker, D1, R2 riêng).

## A. Cài mới (làm theo thứ tự)
1. `npm install`
2. `npx wrangler d1 create hachihi-event-checkin-db` → dán `database_id` vào `wrangler.toml`
3. *(Bỏ qua R2 — không cần.)* Ảnh được lưu trong **Google Drive** qua Apps Script (xem mục E)
4. `npx wrangler d1 migrations apply hachihi-event-checkin-db --remote` (áp 0001 → 0003)
5. Tạo secret: `SESSION_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `MACHINE_API_KEY` (bắt buộc); `APPS_SCRIPT_SECRET`, `APPS_SCRIPT_URL`, `GOOGLE_CLIENT_ID` (nếu dùng Sheets / Google login)
6. `npx wrangler deploy`, rồi điền `PUBLIC_BASE_URL` = địa chỉ Worker và deploy lại
7. Làm đủ danh sách kiểm tra ở README mục 8 trên **sự kiện thử** trước khi nối máy thật

## B. Nâng cấp từ v2
1. Sao lưu: `npx wrangler d1 export hachihi-event-checkin-db --remote --output backup.sql`
2. **Cập nhật Apps Script (`apps-script/Code.gs`) trước**, deploy lại Web App
3. Áp migration 0003, rồi `npx wrangler deploy`
4. Hoàn tác: `npx wrangler rollback` (schema v3 tương thích ngược)

## C. Cấu hình máy nhận diện khuôn mặt
`POST https://<worker>/checkin?key=<MACHINE_API_KEY>&event=<slug-sự-kiện>` — JSON gồm `MachineBoxId`, `EmployeeCode` (khớp "Mã khách"), `EmployeeName`, `CheckinTime`.
Máy cần: gửi `CheckinTime` ổn định khi gửi lại, và coi HTTP 200 (kể cả `duplicate:true`) là thành công.

## E. Ảnh khách lưu trên Google Drive (thay R2)
- Cần cấu hình Apps Script (`APPS_SCRIPT_URL`, `APPS_SCRIPT_SECRET`). Deploy lại Web App và **cấp quyền Drive** khi Google hỏi (lần đầu).
- Ảnh tự lưu vào thư mục Drive "HACHIHI Event Photos" (hoặc đặt `DRIVE_FOLDER_ID` trong Script Properties), chia sẻ dạng "ai có liên kết được xem".
- Ảnh từ Google Form: dùng trực tiếp file đã có trong Drive. Cột ảnh trong Google Sheet có thể là link Drive.
- Ảnh từ máy chấm công được tải lên **sau** khi check-in (không làm chậm), nên màn hình LED có thể hiện chữ cái đầu trước khi ảnh sẵn sàng.
- Không có Apps Script: check-in vẫn chạy, chỉ không có ảnh.
- Giới hạn của Google Drive/Apps Script (dung lượng, số lượt gọi mỗi ngày) tôi chưa kiểm tra — thử với số khách thực tế trước sự kiện.

## D. Khuyến nghị vận hành
- Sự kiện trên ~5.000 khách hoặc bật Google Sheets: dùng **Workers Paid** (gói Free giới hạn 100.000 lượt ghi/ngày và sẽ từ chối truy vấn khi vượt).
- Bật Cloudflare WAF rate-limit cho `/api/public/checkin/*` và `/api/google/checkin/*`.
- Không công khai Google Sheet chứa dữ liệu cá nhân; ưu tiên Apps Script (README mục 4).
- Kiểm thử tải trên staging trước sự kiện lớn: `bench/k6-mixed.js`.

Chi tiết kỹ thuật, bằng chứng đo và các giới hạn đã biết: `AUDIT_REPORT.md`.
