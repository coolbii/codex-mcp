# OpenPencil 第三層測試路徑(ChatGPT 端到端)

一條「最小但完整」的流程,透過 ChatGPT 本身驗證視覺檢查功能,一次坐下來約 30 分鐘可跑完。探針請**照順序**做:save 閘門那關必須在任何截圖把它解鎖之前跑;決定性的視覺探針要早跑。

這條路徑最重要的目的:**確認 ChatGPT 的視覺是否真的透過 MCP 收到截圖**,而不是只靠讀 node JSON 在推理。

## 1. 前置條件

- [ ] `cd ~/bindev/devspace && npm run build`(確保 build 是最新的)。
- [ ] `.env` 有 `ENABLE_OPENPENCIL=1`,且 `ALLOWED_ROOTS=/Users/hezibin/bindev/devspace-sandbox`(絕不要用 `~` 或 `/`)。
- [ ] `op start --web` 已啟動(才有 live canvas / read-nodes)。
- [ ] 字型:不用安裝——Inter 已內建。要中文就 `npm run fetch-fonts`。出現 `missing-font-family` 是「內容」提醒,不是設定失敗。
- [ ] **重啟一個全新的 DevSpace server process**——save 閘門的記憶體 Set 是 process 生命週期、永不清除,只要這個 process 內截過一次圖就會把它預先解鎖。請重啟服務,並且在 Probe B 之前不要截任何圖。
- [ ] ChatGPT 開**開發者模式**、已把 devspace MCP connector 加進去,而且你看得到 **tool-call log**(哪些 `openpencil_*` 被呼叫、參數、isError)。
- [ ] 陷阱種子檔已放在 **workspace 根目錄**:`devspace-sandbox/vision-probe.op`(已預先做好;需要時用 `node scripts/make-vision-probe.mjs` 重生)。工具路徑是相對於 workspace 的,所以當你開的 workspace 是 `/Users/hezibin/bindev/devspace-sandbox` 時,截圖路徑就是 `vision-probe.op`(不是 `designs/vision-probe.op`)。
- [ ] 要貼的提示詞:`docs/openpencil-chatgpt-prompt.md`。

## 2. 測試路徑(照順序)

### Probe A — 視覺(決定性;最先跑、唯讀)

`vision-probe.op` 有三條彩色 section banner。兩個標題看得到(`Brief`、`Screens`);中間那條青色帶的標題(`ORCHID-7741`)被畫在它自己的 banner **後面**,所以它存在於 JSON 裡、但在像素裡看不見。

**貼給 ChatGPT(全新對話):**
> 對 `vision-probe.op` 呼叫 `openpencil_screenshot` 剛好一次。只看回傳的圖片,由上到下列出你「真的讀得到」的每個 section 標題。對於任何你讀不到標題的帶子,告訴我它的位置(top/middle/bottom)與它的帶子顏色。不要呼叫 `openpencil_read_nodes`、`openpencil_get`、`openpencil_lint_design`,也不要用截圖工具的文字摘要——只憑圖片回答。

- **PASS:** 讀得到 `Brief` 與 `Screens`;回報**中間**那條帶子**沒有可讀標題**、而且是**青色**;且講不出 `ORCHID-7741`。
- **FAIL:** 把 `ORCHID-7741` 當成看得到/可讀(它偷讀了 JSON);或說它根本看不到任何圖。
- **看哪裡:** tool-call log 必須顯示**一次** `openpencil_screenshot`、且**零次** read/get/lint(否則作廢,換新對話重跑)。圖片是正確答案的唯一來源——截圖工具的文字/結構化輸出不帶任何標題或顏色。

### Probe B — save 閘門(先反向、再正向;在任何其他截圖之前)

1. 讓模型用 `openpencil_insert` 往一個新 `.op` 插入一個很小的設計(3–5 個節點)。
2. 要它在**沒截圖**、**沒帶 `force`** 的情況下 `openpencil_save`。 → **預期被擋。**
3. 對同一個 workspace 做 `openpencil_screenshot`(需要至少 1 個節點)。
4. 再 `openpencil_save` 一次(不帶 force)。 → **預期成功。**
5.(選用,另開一個全新 process)`openpencil_save` 帶 `force:true`、且沒截圖。 → **預期成功**(略過)。

- **PASS:** 第 2 步回傳 `isError:true`,訊息含 **"blocked by the visual-review gate"**,且沒寫出檔案;第 4 步成功;第 5 步略過。
- **FAIL:** 第 2 步照樣存檔,或是用一個不同的/一般性的錯誤失敗。
- **看哪裡:** tool-call log——第 2 步之前不能有截圖、不能有 `force`。要比對**完整字串**(才能把「閘門擋下」跟「路徑/CLI 錯誤」區分開)。

### Probe C — 先問問題再動工

貼 `docs/openpencil-chatgpt-prompt.md`,然後輸入:*「Design a login form.」*

- **PASS:** 問完全部 **8** 個 STAGE-1 問題、整理出一段 Brief、停下來等 "go"——而且第一個回應裡有**零次** `openpencil_*` 呼叫。
- **FAIL:** 在 "go" 之前就呼叫任何設計工具,或問少於 8 題。
- **看哪裡:** 第一輪 tool-call log 是空的;對話裡看得到那些問題。

### Probe D — 逐節點 + 彩色 bar + foundation 共用(Design A)

回答 "go" 後,帶模型做一個 3 段套件:`Section / 00 Brief`(Banner BG `#1F2937`)、`Section / 04 Foundations`(`#0F766E`)、`Section / 07 Screens`(`#BE123C`)。每段:一個白色 `Section Title` + `Banner BG` 當**最後一個子層**。`04` 的 token 定義成具名圖層;兩個畫面都引用同一個 Foundations frame。

- **PASS:** ≥3 次 `openpencil_insert`(不是 `openpencil_design`);截圖看到 3 條不同顏色的帶子;`openpencil_lint_design` 沒有 `background-z-order` / `missing-section-banners` / `incomplete-section-banner`;read-nodes 顯示兩個畫面共用同一個 Foundations id。
- **FAIL:** 用了 `openpencil_design`;bar 缺失/沒上色/不是最後一個子層;token 各自為政。
- **看哪裡:** tool-call log(insert vs design);回傳圖片(帶子顏色);lint 輸出;read-nodes(共用 id)。

### Probe E — state matrix:空格錯誤 → 修正 → 乾淨(Design B)

做一個 `Section / 06 State Matrix`,含一個 `Matrix / Header Row`(Default/Hover/Active)與一個 `Matrix / Row / Button`,底下 3 個 `Matrix Cell / Button / <State>` frame——**故意留一格空的**——然後 `openpencil_lint_design`。

- **PASS:** 第一次 lint = 剛好一個 `empty-state-cell` 錯誤(那個空格),沒有 `missing-state-matrix-headers`;模型用 `openpencil_update` 把那格補上;第二次 lint = 0 issue;截圖看到所有格子都有內容。
- **FAIL:** 明明有 Header Row 卻報 headers 警告;空格沒被抓到、或有內容的格子被誤報;沒修就存檔。
- **看哪裡:** lint 輸出;tool-call log(兩次 lint 之間那個 `update`);回傳圖片。

### Probe F — 截圖 → 批評 → 修正 迴圈(Design C,故意放一個瑕疵)

做一個小設計,**只放一個**故意的瑕疵——一個**不是最後一個子層**的 `Banner BG`(會蓋住它的標題),或一個比文字還窄的 `Section Title`(會被切掉)。然後輸入:*「Review the design visually and fix any issues you find.」*

- **PASS:** 截圖 #1 → 模型**從圖片**指出瑕疵(「banner 蓋住了標題」),呼叫 `openpencil_move`/`openpencil_update`,截圖 #2 → 確認已修;總共 ≤3 次截圖。
- **FAIL:** 沒分析就說「看起來不錯」;明明有可見瑕疵卻不修;>3 次截圖。
- **看哪裡:** 對話(批評有具體指涉那張圖);tool-call log(2–3 次截圖、中間有 update/move);`.op`(banner 已變成最後一個子層 / 文字框已加寬)。

## 3. 一眼判定表

| 機制 | PASS |
|---|---|
| 先問問題再動工 | 8 題 + Brief + 等 "go";"go" 前無工具呼叫(C) |
| 視覺真的收到圖 | 回報像素獨有事實(中間帶被蓋、青色);講不出 ORCHID-7741(A) |
| save 視覺閘門 | 截圖前被擋;截圖後解鎖;`force` 略過(B) |
| 逐節點 + 彩色 bar | ≥3 次 insert(非 design);3 條彩色帶;無 `background-z-order`(D) |
| foundation 共用 | 跨畫面共用 Foundations id、token 一致(D) |
| state matrix | 一個 `empty-state-cell` → 修好 → 乾淨;headers 正常(E) |
| 批評→修正 迴圈 | 從圖指出瑕疵、修正、重截,≤3 次(F) |
| lint 無誤報 | 乾淨的 Design A/B 不會出現任何結構性代碼(D、E) |

## 4. 疑難排解

| 症狀 | 可能原因 | 處理 |
|---|---|---|
| ChatGPT 裡沒有圖 / 用文字在答 | MCP host 把 image content block 丟掉了,只剩文字摘要(摘要不帶標題/顏色) | 這就是「視覺到底有沒有進來」的診斷,不是模型的錯。要求它講出像素獨有細節;講不出來就去修 connector / image 傳遞,而不是改 prompt |
| 視覺「假 PASS」(講得出 ORCHID-7741) | 它呼叫了 `read_nodes`/`get` | 檢查 tool-call log 是否零次 read;作廢、換新對話重跑 |
| save 閘門沒擋住 | 同一個 process 內較早的截圖已把 Set 解鎖,或偷加了 `force:true` | 重啟 server 銷毀 Set;save 當成第一個動作跑;確認沒有先前截圖/force |
| save 閘門「假 FAIL」(第 4 步還是被擋) | 截圖丟出 `No OpenPencil nodes to screenshot`,所以沒解鎖 | 截圖前確保至少 1 個節點;截圖與 save 用同一個 workspace |
| lint 規則沒觸發 | 命名不符:要 `Section / NN <Title>`、`Matrix Cell / …`、`Matrix / Header Row`、matrix frame 名含 `State Matrix`/`Section / 06`;或畫面 <2、頂層 frame ≤3 導致套件判定沒成立 | 用 `docs/openpencil-chatgpt-prompt.md` 的字面命名;要觸發 `missing-section-banners` 需 ≥2 個 Screen frame |
| 帶子看起來白/灰 | Banner BG 接近白色,或沒排成最後一個子層(畫到後面/前面位置錯) | 最後一個子層 + 飽和的分類色(00 #1F2937、04 #0F766E、06 #B45309、07 #BE123C、10 #0E7490) |
| 文字被切 / 字寬怪 | 用了 Inter 沒有的字型 | 用 Inter(已內建)或 `npm run fetch-fonts` 補中文;把文字框加寬 |
