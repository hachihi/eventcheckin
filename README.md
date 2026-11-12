# HACHIHI EVENT CHECK-IN v3

Hệ thống check-in sự kiện: nhận dữ liệu từ **máy nhận diện khuôn mặt**, hiển thị khách vừa đến trên **màn hình LED**, quản lý danh sách khách và đồng bộ với **Google Sheets / Google Forms / Google Drive**.

Chạy trên Cloudflare Worker + D1, **không cần R2, không cần máy chủ riêng**. Hoàn toàn độc lập với Worker chấm công cũ.

> Hướng dẫn cài đặt từng bước: **[HUONG_DAN_TRIEN_KHAI.md](HUONG_DAN_TRIEN_KHAI.md)**
> Báo cáo audit, số liệu đo và giới hạn đã biết: **[AUDIT_REPORT.md](AUDIT_REPORT.md)**

## Chức năng

| Thành phần | Mô tả |
|---|---|
| Trang quản trị `/admin` | Tạo sự kiện, nhập/xuất CSV, kết nối Google Sheets, xem thống kê và lịch sử, khóa/mở sự kiện |
| Quầy check-in `/e/<slug>/checkin` | Khách tự đăng ký tại chỗ (có thể kèm ảnh), hoặc đăng nhập Google |
| Màn hình LED `/e/<slug>/display` | Hiện khách vừa check-in; tự tăng tốc khi đông; nhấn `F` hoặc nhấp đúp để toàn màn hình |
| API máy chấm công | `POST /checkin?key=…&event=<slug>` |
| Google Sheets | Nhận danh sách khách và ghi lại lịch sử check-in (trễ tối đa khoảng 1 phút) |
| Google Drive | Lưu ảnh khách (qua Apps Script) |
| Nhật ký | Log JSON trong Cloudflare Observability, nhật ký thao tác quản trị tại `/api/admin/audit` |

## Điểm đáng tin cậy của v3

- Check-in **nguyên tử và chống gửi lại**: máy gửi lại cùng một sự kiện không tạo bản ghi thứ hai.
- Khách trùng trả HTTP 200 kèm `"duplicate":true` để máy không thử lại liên tục.
- Sự kiện cho phép check-in lặp có thời gian chờ chống quét lặp (mặc định 30 giây, biến `REPEAT_COOLDOWN_SEC`).
- Dữ liệu tách riêng theo sự kiện; LED chỉ tải bản ghi mới, không tải lại lịch sử.
- Đồng bộ Sheets chạy nền theo lô, không làm chậm check-in.
- Chống dò mật khẩu admin; nhật ký không chứa khóa, mật khẩu, email hay ảnh.

## Cấu trúc thư mục

```
src/worker.js                      Worker (API + giao diện)
migrations/                        0001–0003: bảng, index, ràng buộc chống trùng
apps-script/Code.gs                Cầu nối Google Sheets / Forms / Drive
wrangler.toml                      Cấu hình Cloudflare (D1, cron, biến)
sample-attendees.csv               Mẫu danh sách khách
bench/                             Kiểm thử chức năng, tải (k6), phân tích truy vấn
HUONG_DAN_TRIEN_KHAI.md            Hướng dẫn triển khai chi tiết
AUDIT_REPORT.md                    Báo cáo audit
```

## Biến cấu hình

**Secret (bắt buộc)** — đặt trong Cloudflare, loại *Secret*:

| Tên | Ý nghĩa |
|---|---|
| `SESSION_SECRET` | Chuỗi ngẫu nhiên dài (≥ 40 ký tự) để ký phiên đăng nhập |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Tài khoản quản trị đầu tiên |
| `MACHINE_API_KEY` | Khóa cho máy chấm công |

**Secret (tùy chọn)**

| Tên | Khi nào cần |
|---|---|
| `APPS_SCRIPT_URL` | Link Web app Apps Script — cần khi dùng Sheets hoặc lưu ảnh Drive |
| `APPS_SCRIPT_SECRET` | **Cùng giá trị** với `INTEGRATION_SECRET` bên Apps Script |
| `GOOGLE_CLIENT_ID` | Khi muốn khách check-in bằng tài khoản Google |

**Biến thường** (trong `wrangler.toml`): `PUBLIC_BASE_URL`, `DEFAULT_EVENT_SLUG`, `REPEAT_COOLDOWN_SEC`.

> Phải là loại **Secret**. Biến loại Text nhập trên giao diện sẽ bị xóa mỗi lần deploy từ Git (lỗi "Missing SESSION_SECRET").

## Cột trong file CSV khách

`Họ tên, Mã khách, Email, Điện thoại, Công ty, Chức danh` (xem `sample-attendees.csv`). Mỗi khách cần **email hoặc mã khách**. Mã khách trên máy chấm công (`EmployeeCode`) phải khớp cột "Mã khách".

## Giới hạn cần biết

- Gói Cloudflare **Free** giới hạn 100.000 lượt ghi/ngày cho D1 và từ chối truy vấn khi vượt. Sự kiện trên ~5.000 khách hoặc có bật Sheets nên dùng **Workers Paid**.
- Chưa đo tải trên Cloudflare thật; chưa thử với máy chấm công, Apps Script và Drive thật. Xem mục 8 của `AUDIT_REPORT.md`.
- Ảnh từ máy chấm công chưa được thu nhỏ phía server và được tải lên Drive sau khi check-in.
- Google Drive/Apps Script có hạn mức riêng của Google — thử với số khách thực tế trước sự kiện.
