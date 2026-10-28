# Triển khai Comic Translator lên Google Cloud Run

API FastAPI chạy trên Cloud Run. Tiện ích Chrome/Edge vẫn chạy trong trình duyệt và gọi API qua HTTPS. Hướng dẫn này dành cho một người hoặc nhóm nhỏ tin cậy; khóa truy cập API là khóa dùng chung, không phải tài khoản người dùng.

## 1. Chuẩn bị

- Có dự án Google Cloud đã bật billing và cài [Google Cloud CLI](https://cloud.google.com/sdk/docs/install).
- Có Gemini API key hoạt động. Dùng khóa này cho Secret Manager, không đưa vào tiện ích hoặc Git.
- Có quyền triển khai Cloud Run, tạo service account, secret và cấp quyền IAM trong dự án.
- Chọn vùng, ví dụ `asia-southeast1` (Singapore).

Trong PowerShell, thay mã dự án thực tế:

```powershell
$projectId = "YOUR_PROJECT_ID"
$region = "asia-southeast1"
$service = "comic-translator-api"
$serviceAccount = "comic-translator-run@$projectId.iam.gserviceaccount.com"
gcloud auth login
gcloud config set project $projectId
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
gcloud iam service-accounts create comic-translator-run --display-name "Comic Translator Cloud Run"
```

Nếu service account đã tồn tại, bỏ qua lệnh tạo. Cloud Build/Artifact Registry có thể cần một lần cấu hình hoặc cấp quyền bổ sung theo chính sách dự án.

## 2. Tạo hai secret

Trong [Secret Manager](https://console.cloud.google.com/security/secret-manager), tạo:

| Tên | Giá trị |
| --- | --- |
| `gemini-api-key` | Gemini API key của bạn |
| `comic-api-token` | Chuỗi ngẫu nhiên ít nhất 32 byte, tạo bằng lệnh dưới |

```powershell
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Giữ riêng giá trị `comic-api-token` để nhập vào tiện ích. Không ghi khóa vào lệnh `gcloud`, file `.env` được commit, hoặc mã nguồn. Cấp service account quyền đọc đúng hai secret:

```powershell
gcloud secrets add-iam-policy-binding gemini-api-key --member "serviceAccount:$serviceAccount" --role roles/secretmanager.secretAccessor
gcloud secrets add-iam-policy-binding comic-api-token --member "serviceAccount:$serviceAccount" --role roles/secretmanager.secretAccessor
```

## 3. Triển khai API

Chạy từ thư mục gốc repository. `apps/api/Dockerfile` khởi chạy Uvicorn trên cổng do Cloud Run cấp; `.gcloudignore` và `.dockerignore` loại `.env` khỏi bản dựng.

```powershell
gcloud run deploy $service `
  --source apps/api `
  --region $region `
  --service-account $serviceAccount `
  --allow-unauthenticated `
  --set-secrets "GEMINI_API_KEY=gemini-api-key:1,API_ACCESS_TOKEN=comic-api-token:1" `
  --set-env-vars "GEMINI_MODEL=gemini-3.5-flash-lite,GEMINI_TIMEOUT_SECONDS=45" `
  --memory 1Gi `
  --concurrency 10 `
  --max-instances 1 `
  --timeout 180
```

`--allow-unauthenticated` cho trình duyệt gọi URL Cloud Run trực tiếp; endpoint dịch vẫn kiểm tra header `x-api-key`. Cloud Run sẽ từ chối dịch nếu thiếu `API_ACCESS_TOKEN`. Không dùng cách này cho dịch vụ công cộng hoặc nhiều người dùng không tin cậy: khóa chung trong tiện ích có thể bị trích xuất, và bộ giới hạn tốc độ hiện chỉ nằm trong bộ nhớ của mỗi instance.

Lấy URL và kiểm tra sức khỏe:

```powershell
$apiUrl = gcloud run services describe $service --region $region --format "value(status.url)"
Invoke-RestMethod "$apiUrl/health"
```

Kết quả cần có `status: ok`. `/health` không gọi Gemini; thử dịch thật bằng tiện ích để kiểm tra khóa Gemini và model.

## 4. Kết nối tiện ích

```powershell
npm install
npm run build
```

Tại `chrome://extensions`, bật **Developer mode**, chọn **Load unpacked**, mở `.output/chrome-mv3`. Trong popup, mục **KẾT NỐI API**:

1. Dán URL `$apiUrl` vào **URL backend**.
2. Dán giá trị `comic-api-token` vào **Khóa truy cập API**.
3. Bấm **Lưu kết nối** và chấp thuận quyền truy cập host Cloud Run.
4. Cấp quyền ảnh của trang truyện, bật dịch và tải lại trang.

Tiện ích lưu URL và khóa truy cập trong `chrome.storage.local` trên máy người dùng. Không chia sẻ bản cài đặt hoặc hồ sơ trình duyệt đã lưu khóa. Nếu đổi URL hoặc token, bấm **Lưu kết nối** lại; bấm **Xóa cache** khi muốn dịch lại ảnh cũ.

## 5. Cập nhật và xử lý lỗi

- Sau khi đổi mã API, chạy lại lệnh `gcloud run deploy` ở bước 3.
- Sau khi đổi mã tiện ích, chạy `npm run build` rồi bấm **Reload** tại `chrome://extensions`.
- Nếu nhận `401`, kiểm tra token trong popup khớp phiên bản Secret Manager đã gắn với Cloud Run.
- Nếu nhận `503 missing_api_token`, cấu hình lại secret `API_ACCESS_TOKEN` cho service.
- Nếu nhận `502 model_unavailable`, chọn một model Gemini mà API key được phép dùng và cập nhật `GEMINI_MODEL` khi deploy.
- Xem log: `gcloud run services logs read $service --region $region --limit 50`.
- Secret gắn vào biến môi trường theo số phiên bản; khi xoay khóa, thêm phiên bản mới rồi deploy lại với số phiên bản mới. Cập nhật khóa truy cập trong popup.

Cloud Run, Cloud Build, Artifact Registry, Secret Manager và Gemini có thể phát sinh phí. Xem [giá Cloud Run](https://cloud.google.com/run/pricing) và [giá Gemini API](https://ai.google.dev/gemini-api/docs/pricing) trước khi triển khai.
