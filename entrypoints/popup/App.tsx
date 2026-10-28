import { useEffect, useState } from "react";
import { defaults, getSettings, saveSettings } from "../../lib/settings";
import type { Settings } from "../../types";

const languages = [
  ["auto", "Tự nhận diện"],
  ["ja", "Tiếng Nhật"],
  ["ko", "Tiếng Hàn"],
  ["zh", "Tiếng Trung"],
  ["en", "Tiếng Anh"],
  ["vi", "Tiếng Việt"],
  ["fr", "Tiếng Pháp"],
  ["es", "Tiếng Tây Ban Nha"],
  ["de", "Tiếng Đức"],
  ["th", "Tiếng Thái"],
  ["id", "Tiếng Indonesia"],
];
export function App() {
  const [settings, setSettings] = useState<Settings>(defaults);
  const [apiUrl, setApiUrl] = useState(defaults.apiBaseUrl);
  const [apiToken, setApiToken] = useState("");
  const [site, setSite] = useState("");
  const [origins, setOrigins] = useState<string[]>([]);
  const [status, setStatus] = useState("Sẵn sàng");
  useEffect(() => {
    getSettings().then((saved) => {
      setSettings(saved);
      setApiUrl(saved.apiBaseUrl);
      setApiToken(saved.apiAccessToken);
    });
    const interval = setInterval(() => {
      chrome.runtime.sendMessage({ type: "STATUS" }, (response) => {
        if (
          !chrome.runtime.lastError &&
          response?.ok &&
          response.active + response.queued > 0
        )
          setStatus(
            `Đang dịch ${response.active} ảnh · Chờ ${response.queued}`,
          );
      });
    }, 1000);
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs[0]?.url;
      if (!url) return;
      try {
        setSite(new URL(url).hostname);
      } catch {
        /* browser internal page */
      }
      if (!tabs[0]?.id) return;
      chrome.scripting?.executeScript?.(
        {
          target: { tabId: tabs[0].id },
          func: () =>
            [
              ...new Set(
                [...document.images]
                  .map((i) => {
                    try {
                      return new URL(i.currentSrc || i.src).origin;
                    } catch {
                      return "";
                    }
                  })
                  .filter(Boolean),
              ),
            ].slice(0, 20),
        },
        (result) => {
          if (!chrome.runtime.lastError && result?.[0]?.result)
            setOrigins(result[0].result as string[]);
        },
      );
    });
    return () => clearInterval(interval);
  }, []);
  async function update(patch: Partial<Settings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    await saveSettings(next);
  }
  async function grant() {
    if (!origins.length && !site) {
      setStatus("Không tìm thấy địa chỉ ảnh trên trang.");
      return;
    }
    const requested = [
      ...new Set(
        [...origins, `https://${site}`, `http://${site}`].filter((origin) =>
          /^https?:\/\//.test(origin),
        ),
      ),
    ].map((origin) => `${origin}/*`);
    try {
      const granted = await chrome.permissions.request({ origins: requested });
      setStatus(
        granted
          ? "Đã cấp quyền tải ảnh. Tải lại trang để bắt đầu."
          : "Chưa cấp quyền tải ảnh.",
      );
    } catch (error) {
      setStatus(String(error));
    }
  }
  async function clear() {
    const response = await chrome.runtime.sendMessage({ type: "CLEAR_CACHE" });
    setStatus(
      response?.ok ? "Đã xóa bộ nhớ đệm." : "Không thể xóa bộ nhớ đệm.",
    );
  }
  async function saveApi() {
    let parsed: URL;
    try {
      parsed = new URL(apiUrl.trim());
      if (
        (parsed.protocol !== "https:" &&
          !(parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname))) ||
        parsed.username || parsed.password || parsed.pathname !== "/" ||
        parsed.search || parsed.hash
      ) throw new Error("URL không hợp lệ");
    } catch {
      setStatus("Nhập URL HTTPS của Cloud Run, hoặc URL localhost hợp lệ.");
      return;
    }
    const baseUrl = parsed.origin;
    try {
      const granted = await chrome.permissions.request({ origins: [`${baseUrl}/*`] });
      if (!granted) {
        setStatus("Chưa cấp quyền kết nối API.");
        return;
      }
      await update({ apiBaseUrl: baseUrl, apiAccessToken: apiToken.trim() });
      setApiUrl(baseUrl);
      setStatus("Đã lưu kết nối API.");
    } catch (error) {
      setStatus(String(error));
    }
  }
  return (
    <main>
      <header>
        <div className="logo">
          文<span>→</span>A
        </div>
        <div>
          <h1>Comic Translator</h1>
          <p>Dịch truyện ngay trên trang</p>
        </div>
      </header>
      <section className="hero">
        <div>
          <strong>Dịch tự động</strong>
          <small>{site || "Trang hiện tại"}</small>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
          />
          <span />
        </label>
      </section>
      <section>
        <div className="sectionTitle">NGÔN NGỮ</div>
        <div className="row">
          <label>
            Nguồn
            <select
              value={settings.sourceLanguage}
              onChange={(e) => update({ sourceLanguage: e.target.value })}
            >
              {languages.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <b>→</b>
          <label>
            Đích
            <select
              value={settings.targetLanguage}
              onChange={(e) => update({ targetLanguage: e.target.value })}
            >
              {languages
                .filter(([code]) => code !== "auto")
                .map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
            </select>
          </label>
        </div>
      </section>
      <section>
        <div className="sectionTitle">HIỂN THỊ</div>
        <label className="line">
          Chế độ
          <select
            value={settings.displayMode}
            onChange={(e) =>
              update({ displayMode: e.target.value as Settings["displayMode"] })
            }
          >
            <option value="clean">Bong bóng sạch</option>
            <option value="subtle">Lớp phủ nhẹ</option>
            <option value="hover">Hiện khi chạm</option>
          </select>
        </label>
        <label className="line">
          Xem chữ gốc
          <input
            type="checkbox"
            checked={settings.showOriginal}
            onChange={(e) => update({ showOriginal: e.target.checked })}
          />
        </label>
        <label className="slider">
          Độ mờ nền <span>{Math.round(settings.opacity * 100)}%</span>
          <input
            type="range"
            min="0.5"
            max="1"
            step="0.01"
            value={settings.opacity}
            onChange={(e) => update({ opacity: Number(e.target.value) })}
          />
        </label>
        <label className="slider">
          Cỡ chữ <span>{Math.round(settings.fontScale * 100)}%</span>
          <input
            type="range"
            min="0.7"
            max="1.5"
            step="0.05"
            value={settings.fontScale}
            onChange={(e) => update({ fontScale: Number(e.target.value) })}
          />
        </label>
      </section>
      <section>
        <div className="sectionTitle">TỰ ĐỘNG</div>
        <label className="line">
          Dừng cuộn (ms)
          <input
            type="number"
            min="300"
            max="5000"
            step="100"
            value={settings.debounceMs}
            onChange={(e) =>
              update({
                debounceMs: Math.min(
                  5000,
                  Math.max(300, Number(e.target.value) || 1200),
                ),
              })
            }
          />
        </label>
        <label className="line">
          Tắt trên trang này
          <input
            type="checkbox"
            checked={settings.disabledSites.includes(site) && !!site}
            disabled={!site}
            onChange={(e) =>
              update({
                disabledSites: e.target.checked
                  ? [...settings.disabledSites, site]
                  : settings.disabledSites.filter((s) => s !== site),
              })
            }
          />
        </label>
      </section>
      <section>
        <div className="sectionTitle">KẾT NỐI API</div>
        <label className="apiField">
          URL backend
          <input type="url" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://...run.app" />
        </label>
        <label className="apiField">
          Khóa truy cập API
          <input type="password" value={apiToken} onChange={(e) => setApiToken(e.target.value)} placeholder="Để trống khi chạy local" />
        </label>
        <div className="actions"><button onClick={saveApi}>Lưu kết nối</button></div>
      </section>
      <div className="actions">
        <button onClick={grant}>Cấp quyền ảnh</button>
        <button className="secondary" onClick={clear}>
          Xóa cache
        </button>
      </div>
      <p className="notice">
        Ảnh truyện được gửi tới backend đã chọn và Gemini khi bật dịch. Di
        chuột hoặc nhấp vào bản dịch để xem chữ gốc.
      </p>
      <p className="status">{status}</p>
    </main>
  );
}
