# Comic Translator

A WXT/React Manifest V3 extension that detects visible comic images after scrolling stops, sends image bytes to a local FastAPI service, and places Gemini translations over detected text. The interface defaults to Vietnamese.

For Google Cloud Run deployment and extension setup, see [docs/google-cloud-run.md](docs/google-cloud-run.md).

## Requirements

- Node.js 20.19+ and npm
- Python 3.11+ (3.12 or 3.13 recommended)
- Chrome or Edge
- A Gemini API key

## Windows setup

From PowerShell in the project root:

```powershell
npm install
Copy-Item apps/api/.env.example apps/api/.env
```

Edit `apps/api/.env` and set `GEMINI_API_KEY`. The API loads this file automatically. Then start the backend:

```powershell
cd apps/api
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Use your installed Python version in place of `-3.12`. The API health check is `http://127.0.0.1:8000/health`.

In another PowerShell window at the project root:

```powershell
npm run build
```

Open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose `.output/chrome-mv3`. Open a comic page, click the extension, choose languages, click **Cấp quyền ảnh**, enable automatic translation, and refresh the page. The permission action requests access to image origins detected on the active page. If an image is later loaded from a new CDN, open the popup and grant its origin. Only enable the extension on sites you trust: images on enabled pages are transmitted to the local backend and Gemini.

`npm run dev` starts WXT's development browser. If WXT cannot find Chrome, use the manual build/load process above.

## How it works

- `entrypoints/content.ts` tracks images with IntersectionObserver and MutationObserver. A scroll resets the timer; eligible visible images are processed after 1,200 ms by default. Results are ignored if the image URL changes or settings change.
- `entrypoints/background.ts` checks optional host permission, downloads HTTP images, or accepts a bounded JPEG capture for `blob:` images and inaccessible image hosts. It uploads multipart bytes to FastAPI, validates the response, and limits work to two concurrent requests.
- `apps/api/app/main.py` validates and normalizes uploads, asks Gemini to find and translate text, and validates normalized regions with Pydantic. A malformed text box is skipped without discarding valid boxes; the backend logs the rejected coordinates. No remote URL is accepted by the backend.
- `lib/overlay.ts` renders isolated Shadow DOM overlays with Clean Bubble, Subtle Overlay and Hover Translation modes. The layout uses `bubbleBBox` when Gemini finds a speech bubble, keeps `textBBox` separate, and computes a safe `renderBBox`. Text is measured before placement; long text becomes a small expandable marker. Hover or focus a translation to reveal original text.
- `lib/cache.ts` keeps a memory cache plus an IndexedDB cache for 30 days, capped at 300 entries. Cache keys include an image URL or captured-content hash, languages, model and pipeline version.

## Checks

```powershell
npm run typecheck
npm run lint
npm run build
cd apps/api
.\.venv\Scripts\Activate.ps1
pytest -q
```

For a manual test, use a page with a single image, several images, and a long Webtoon. Confirm that short scroll pauses do not trigger requests, a pause longer than 1,200 ms does, resizing keeps overlays aligned, language changes replace old overlays, repeated scrolling uses the cache, and protected/unsupported images produce console messages. The backend can be tested without a Gemini key using the mocked API test; live translation requires credentials.

If Gemini fails, run `python scripts/check_gemini.py` from `apps/api` to see the provider status without printing your key. Run `python scripts/check_pipeline.py` to test image translation with a small synthetic comic bubble. The default model is `gemini-3.5-flash-lite`; change `GEMINI_MODEL` in `.env` if your project needs another available model, then restart FastAPI.

## Current limitations

- Gemini bounding boxes are approximate. For best placement, the backend should eventually replace Gemini's estimated `bubbleBBox` with a dedicated bubble detector while retaining `textBBox` from OCR. Old cached responses without `bubbleBBox` use a tight text-only fallback.
- Some authenticated or anti-hotlinking hosts reject extension downloads. The extension tries capturing pixels from the displayed image; browsers can block this for cross-origin images without CORS permission.
- For downloaded HTTP images, cache identity uses the resolved URL, so changed content at the same URL may reuse an old translation until cache expiry or manual clearing. Captured images use a content hash.
- The backend uses an in-process per-IP rate limit. Cloud Run deployment adds a shared API token and HTTPS, but public multi-user use still needs per-user authentication and persistent rate limiting.
- The extension handles `<img>` elements. CSS background images, canvas readers and PDF pages are outside this MVP.
