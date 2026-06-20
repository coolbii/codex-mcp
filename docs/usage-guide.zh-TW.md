# 使用指南 — 用 ChatGPT 操作 devspace

> English version → [usage-guide.md](usage-guide.md)

這是從零到「ChatGPT 正在改我 Mac 上某個資料夾的程式碼」的完整流程。更深入的參考
（tunnel 細節、排錯表）請看 [chatgpt-setup.md](chatgpt-setup.md)。

## 心智模型（一句話）

> devspace 跑在**你的 Mac** 上 → Cloudflare tunnel 把它安全地開到網路上 →
> **ChatGPT** 連上後，就能讀寫你指定的**那一個資料夾**裡的程式碼。

```
你在 ChatGPT 打字  ──▶  ChatGPT 伺服器  ──HTTPS──▶  你的 Cloudflare 網域
                                                         │ tunnel
                                                         ▼
                                          你的 Mac: devspace (127.0.0.1:7676)
                                                         │ 只能碰
                                                         ▼
                                          ~/code/sandbox   ← 你指定的資料夾
```

## 事前準備

- 一個有 **Developer Mode** 的 ChatGPT 方案（Plus/Pro/Business/Enterprise/Edu；
  Free 不行）。
- 一個 **Cloudflare 託管的網域** + `cloudflared`（`brew install cloudflared`）。
- devspace 已建置：`cd ~/bindev/devspace && npm install && npm run build`。

---

## A. 一次性設定（約 15 分鐘，只做一次）

### 1. 準備沙箱資料夾 + 密碼

```bash
mkdir -p ~/code/sandbox            # 把要給 ChatGPT 操作的程式碼放這
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
# ↑ 複製這串 —— 它就是你的 OWNER_TOKEN（登入密碼）
```

### 2. 寫設定檔 `~/bindev/devspace/.env`

```bash
ALLOWED_ROOTS=/Users/你/code/sandbox
AUTH_MODE=oauth
PUBLIC_BASE_URL=https://devspace.你的網域.com
ALLOWED_HOSTS=devspace.你的網域.com
OWNER_TOKEN=<剛剛產生的那串>
# ENABLE_SHELL 不要設（保持關閉）—— 建議
```

### 3. 建立 Cloudflare named tunnel（網址固定）

```bash
cloudflared tunnel login
cloudflared tunnel create devspace
cloudflared tunnel route dns devspace devspace.你的網域.com
```

`~/.cloudflared/config.yml`：

```yaml
tunnel: devspace
ingress:
  - hostname: devspace.你的網域.com
    service: http://127.0.0.1:7676
    originRequest:
      disableChunkedEncoding: true
  - service: http_status:404
```

### 4. 在 ChatGPT 加 connector（授權一次）

1. ChatGPT → **Settings → Apps & Connectors** → Advanced → **Developer Mode 開**
2. **Create** 自訂 connector → URL 填 `https://devspace.你的網域.com/mcp`，
   認證選 **OAuth**
3. 跳出 devspace 的登入頁 → **輸入你的 `OWNER_TOKEN`** → 連上 ✅

> 這個登入是**一次性的**。devspace 會把 OAuth refresh token 存檔，所以就算你重開
> devspace，ChatGPT 也會自動續連，不用再登入 —— 除非你換掉 `OWNER_TOKEN`。

---

## B. 每次要用時（開兩個終端機，各一行指令）

```bash
# 終端機 1 —— 開 devspace
cd ~/bindev/devspace && npm run start:http

# 終端機 2 —— 開 tunnel
cloudflared tunnel run devspace
```

兩個保持開著就好。（想開機自動跑，可以做成 launchd service —— 要的話我幫你加範本。）

---

## C. 實際在 ChatGPT 裡怎麼操作

直接用講的，例如：

> 「打開 `/Users/你/code/sandbox` 這個 workspace，找出 `parseConfig` 在哪裡定義，
> 幫我把它改成支援 YAML，然後給我看 diff。」

ChatGPT 背後會依序自動呼叫工具：

```
open_workspace → search_files / read_file → show_diff → edit_file
```

- **讀取類**（找檔、讀檔、搜尋）會直接跑，不打擾你。
- **寫入類**（`write_file` / `edit_file`）會跳一個**確認框** —— 你可以展開看它要改
  什麼 JSON，按同意才會真的改到你硬碟上的檔案。

改完，變更就在你 Mac 的 `~/code/sandbox` 裡 —— 直接跑測試、`git commit` 都行。這樣
就把實際編碼的 token 消耗丟給 ChatGPT，省下 Codex 額度。

## 各工具在做什麼

| 工具 | 唯讀 | 功能 |
|---|---|---|
| `open_workspace` | ✓ | 打開資料夾 → 回傳之後每次都要帶的 `workspaceId` |
| `list_directory` / `find_files` / `search_files` | ✓ | 瀏覽目錄 / 搜尋內容 |
| `read_file` | ✓ | 讀檔（可指定行範圍） |
| `show_diff` | ✓ | 預覽變更但不寫入 |
| `write_file` / `edit_file` | ✗ | 建立/覆寫，或精準字串替換 —— 會跳確認 |
| `create_site` / `update_site` | ✗ | 建立或更新有 git 版控的靜態網站 preview |
| `list_sites` / `get_site_versions` | ✓ | 檢視產生出的網站 preview 與 git history |

網站 preview 會寫到 `<第一個 ALLOWED_ROOTS>/devspace-sites/<siteId>/`，
並透過 `<PUBLIC_BASE_URL>/sites/<siteId>/` 提供預覽。詳細看
[generated-sites.md](generated-sites.md)。

## 安全提醒

- **`ALLOWED_ROOTS` 只設那個沙箱資料夾** —— 別設家目錄或整個專案根。ChatGPT（以及
  任何被它讀到的檔案內容做 prompt injection）只能碰到這個範圍。設到危險路徑會被
  devspace 直接拒絕啟動。
- **shell 預設關閉** —— 對 ChatGPT 開放的伺服器，維持關閉最安全。
- `OWNER_TOKEN` 和 `data/devspace-oauth.json` 當機密保管（後者已被 .gitignore）。

## 信任它之前先驗證

```bash
node scripts/smoke-oauth.mjs   # 在本機跑完整 OAuth 流程 —— 應該看到 ✅
```

排錯表：[chatgpt-setup.md](chatgpt-setup.md#troubleshooting)。
