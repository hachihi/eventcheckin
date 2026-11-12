# HACHIHI EVENT CHECK-IN v3 — Hướng dẫn triển khai nhanh

Hệ thống độc lập hoàn toàn với Worker chấm công cũ (Worker, D1, R2 riêng).

## A. Cài mới (làm theo thứ tự)
1. `npm install`
2. `npx wrangler d1 create hachihi-event-checkin-db` → dán `database_id` vào `wrangler.toml`
3. `npx wrangler r2 bucket create hachihi-event-photos`
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

## D. Khuyến nghị vận hành
- Sự kiện trên ~5.000 khách hoặc bật Google Sheets: dùng **Workers Paid** (gói Free giới hạn 100.000 lượt ghi/ngày và sẽ từ chối truy vấn khi vượt).
- Bật Cloudflare WAF rate-limit cho `/api/public/checkin/*` và `/api/google/checkin/*`.
- Không công khai Google Sheet chứa dữ liệu cá nhân; ưu tiên Apps Script (README mục 4).
- Kiểm thử tải trên staging trước sự kiện lớn: `bench/k6-mixed.js`.

Chi tiết kỹ thuật, bằng chứng đo và các giới hạn đã biết: `AUDIT_REPORT.md`.
