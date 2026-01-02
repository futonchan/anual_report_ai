const CSV_COLUMN_MAP = {
  // 候補列名を配列で書くと、存在する最初の列を採用する
  date: ["date", "日付"],
  title: ["title", "内容"],
  amount: ["amount", "金額（円）"],
  category: ["category", "中項目", "大項目"],
  source: ["source", "保有金融機関"],
  url: ["url", "URL"],
};

const TEXT_MODEL = "gemini-2.5-flash";
const IMAGE_MODEL = "gemini-2.5-flash-image";
const GENERATION_ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const KEYWORD_FLAG_TERMS = ["振替", "引落", "チャージ", "立替", "ATM", "チャージバック", "デビット"];
const AUTO_EXCLUDE_TAGS = ["transfer", "calc_off", "amount_zero", "title_empty"];
const SOFT_EXCLUDE_TAGS = ["title_generic", "card", "sbi", "atm", "category_empty", "url_like"];
const toQuarterKey = (monthStr) => {
  if (!monthStr || monthStr.length < 7) return "Unknown";
  const [y, m] = monthStr.split("-").map(Number);
  const q = Math.floor(((m || 1) - 1) / 3) + 1;
  return `${y}-Q${q}`;
};

let events = [];
let summary = null;
let reportJson = null;
let imageDataUrl = null;
let lastEventId = 0;
const tagExpandedState = {};
let previewExpanded = false;
let showAllFlagged = false;
let previewFileOverride = null;
let currentView = "ingest";
const quarterExpandedState = {};
const HOWTO_IMAGES = ["images/gemini_apikey_1.png", "images/gemini_apikey_2.png", "images/gemini_apikey_3.png"];
let howToIndex = 0;

const els = {
  apiKey: document.getElementById("apiKey"),
  csvFile: document.getElementById("csvFile"),
  previewBtn: document.getElementById("previewBtn"),
  reportBtn: document.getElementById("reportBtn"),
  imageBtn: document.getElementById("imageBtn"),
  imageBtn2: document.getElementById("imageBtn2"),
  dropZone: document.getElementById("dropZone"),
  togglePreview: document.getElementById("togglePreview"),
  toggleFlagged: document.getElementById("toggleFlagged"),
  status: document.getElementById("status"),
  reportStatus: document.getElementById("reportStatus"),
  previewTable: document.getElementById("previewTable"),
  flaggedInfo: document.getElementById("flaggedInfo"),
  flaggedList: document.getElementById("flaggedList"),
  reportView: document.getElementById("reportView"),
  imageContainer: document.getElementById("imageContainer"),
  imageActions: document.getElementById("imageActions"),
  viewIngest: document.getElementById("viewIngest"),
  viewReport: document.getElementById("viewReport"),
  navButtons: document.querySelectorAll(".nav-steps [data-view-target]"),
  progressDots: document.getElementById("progressDots"),
  flaggedSummary: document.getElementById("flaggedSummary"),
  lightbox: document.getElementById("lightbox"),
  lightboxImg: document.getElementById("lightbox-img"),
  lightboxClose: document.querySelector(".lightbox-close"),
  lightboxPrev: document.querySelector(".lightbox-nav.prev"),
  lightboxNext: document.querySelector(".lightbox-nav.next"),
  lightboxBackdrop: document.querySelector(".lightbox-backdrop"),
  howToGemini: document.getElementById("howToGemini"),
  lightboxStep: document.getElementById("lightbox-step"),
  lightboxLink: document.getElementById("lightbox-link"),
};

function setStatus(message, type = "") {
  els.status.textContent = message || "";
  els.status.className = `status ${type}`;
}

function setReportStatus(message, type = "") {
  els.reportStatus.textContent = message || "";
  els.reportStatus.className = `status ${type}`;
}

function showView(viewName) {
  currentView = viewName;
  if (els.viewIngest) els.viewIngest.classList.toggle("hidden", viewName !== "ingest");
  if (els.viewReport) els.viewReport.classList.toggle("hidden", viewName !== "report");
  if (els.navButtons) {
    els.navButtons.forEach((btn) => {
      const active = btn.getAttribute("data-view-target") === viewName;
      btn.classList.toggle("active", active);
    });
  }
}

function disableButtons(disabled) {
  els.reportBtn.disabled = disabled;
  els.imageBtn.disabled = disabled;
  if (els.imageBtn2) els.imageBtn2.disabled = disabled;
}

function showLightbox(idx = 0) {
  if (!els.lightbox || !els.lightboxImg) return;
  howToIndex = ((idx % HOWTO_IMAGES.length) + HOWTO_IMAGES.length) % HOWTO_IMAGES.length;
  els.lightboxImg.src = HOWTO_IMAGES[howToIndex];
  if (els.lightboxStep) {
    els.lightboxStep.textContent = `手順 ${howToIndex + 1}/${HOWTO_IMAGES.length}`;
  }
  els.lightbox.classList.remove("hidden");
  els.lightbox.setAttribute("aria-hidden", "false");
}

function hideLightbox() {
  if (!els.lightbox) return;
  els.lightbox.classList.add("hidden");
  els.lightbox.setAttribute("aria-hidden", "true");
}

function stepLightbox(delta) {
  showLightbox(howToIndex + delta);
}

function getMappedValue(row, key) {
  const col = CSV_COLUMN_MAP[key];
  const candidates = Array.isArray(col) ? col : [col];
  for (const name of candidates) {
    if (name && Object.prototype.hasOwnProperty.call(row, name)) {
      return row[name];
    }
  }
  return undefined;
}

function normalizeDateString(raw) {
  if (!raw) return null;
  const replaced = raw.trim().replace(/[./]/g, "-");
  if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(replaced)) return null;
  const [y, m, d] = replaced.split("-");
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return iso;
}

function parseAmount(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value)
    .replace(/,/g, "")
    // normalize various minus glyphs to ASCII hyphen-minus
    .replace(/[−ー―‐‑﹣－]/g, "-")
    .trim();
  if (!cleaned) return null;
  const num = parseFloat(cleaned);
  if (!Number.isFinite(num)) return null;
  return num;
}

// ルールベースのタグ付け（除外候補をマークするだけ）
function getRowFlags({ rawAmount, rawCategory, rawTitle, rawSource, rawRow }) {
  const flags = [];
  const title = rawTitle || "";
  const titleUpper = title.toUpperCase();
  const source = rawSource || "";
  const transferFlag = rawRow?.["振替"];
  const calcFlag = rawRow?.["計算対象"];

  if (transferFlag === "1" || transferFlag === 1) flags.push("transfer");
  if (calcFlag === "0" || calcFlag === 0) flags.push("calc_off");
  if (rawAmount === 0) flags.push("amount_zero");
  if (!title.trim()) flags.push("title_empty");

  if (!(rawAmount < 0)) flags.push("income");
  if (rawCategory === "カード引き落とし") flags.push("card");
  if (title.includes("振替 SBI証券") || title.includes("SBIハイブリッド預金")) flags.push("sbi");
  if (title.startsWith("ATM")) flags.push("atm");

  const keywordHits = KEYWORD_FLAG_TERMS.some((kw) => title.includes(kw));
  if (keywordHits) flags.push("title_generic");
  if (!rawCategory || rawCategory.trim() === "") flags.push("category_empty");
  if (/^https?:\/\//i.test(title) || /WWW\./i.test(titleUpper)) flags.push("url_like");

  return flags;
}

function normalizeRow(row, index) {
  const rawDateInput = getMappedValue(row, "date");
  const rawDate = normalizeDateString(rawDateInput);
  if (!rawDate) {
    return { warning: `row ${index + 1}: 日付が空または形式が無効 (${rawDateInput ?? ""})` };
  }
  const rawAmount = parseAmount(getMappedValue(row, "amount"));
  const rawCategory = getMappedValue(row, "category") || null;
  const rawSource = getMappedValue(row, "source") || "unknown";
  const rawTitle = getMappedValue(row, "title") || "";
  console.warn("[amount debug]", {
    row: index + 1,
    original: getMappedValue(row, "amount"),
    parsed: rawAmount,
  });
  if (rawAmount === null || rawAmount === undefined || Number.isNaN(rawAmount)) {
    return { warning: `row ${index + 1}: 金額が空または無効` };
  }
  const flags = getRowFlags({ rawAmount, rawCategory, rawTitle, rawSource, rawRow: row });
  const initialExclude =
    flags.some((f) => AUTO_EXCLUDE_TAGS.includes(f)) ||
    flags.some((f) => SOFT_EXCLUDE_TAGS.includes(f));

  const event = {
    id: ++lastEventId,
    source: rawSource,
    date: rawDate,
    title: rawTitle,
    amount: Math.abs(rawAmount), // 支出として正の値で保持（incomeは除外候補として扱う）
    signedAmount: rawAmount, // デバッグ用: 元の符号付き金額
    category: rawCategory,
    url: getMappedValue(row, "url") || null,
    isExpense: rawAmount < 0,
    flags,
    exclude: initialExclude, // 初期はルールマッチを除外扱いに
    raw: { ...row },
  };

  return { event };
}

function readCsvFile(file) {
  return new Promise((resolve, reject) => {
    if (!window.Papa) {
      reject(new Error("PapaParseの読み込みに失敗しました。ネットワークを確認してください。"));
      return;
    }
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => resolve(results),
      error: (err) => reject(err),
    });
  });
}

function renderPreview(data) {
  if (!data.length) {
    els.previewTable.innerHTML = "<p>プレビューできる行がありません。</p>";
    return;
  }
  const limit = previewExpanded ? 10 : 3;
  const rows = data.slice(0, limit);
  const headers = Object.keys(rows[0]);
  const thead = `<tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr>`;
  const tbody = rows
    .map(
      (r) =>
        `<tr>${headers
          .map((h) => `<td>${r[h] !== undefined ? r[h] : ""}</td>`)
          .join("")}</tr>`
    )
    .join("");
  els.previewTable.innerHTML = `<table>${thead}${tbody}</table>`;
}

function getActiveEvents() {
  return events.filter((e) => e.isExpense && !e.exclude);
}

function renderFlaggedList() {
  const flagged = events.filter((e) => e.flags.length);
  if (!flagged.length) {
    els.flaggedInfo.textContent = "除外候補はありません。";
    els.flaggedInfo.className = "status";
    if (els.flaggedSummary) els.flaggedSummary.textContent = "ルールマッチ 0 件";
    els.flaggedList.innerHTML = "";
    return;
  }

  // グルーピング
  const byTag = {};
  flagged.forEach((ev) => {
    ev.flags.forEach((tag) => {
      byTag[tag] = byTag[tag] || [];
      byTag[tag].push(ev);
    });
  });

  const totalExcluded = flagged.filter((f) => f.exclude).length;
  const active = getActiveEvents().length;
  els.flaggedInfo.textContent = `ルールマッチ ${flagged.length}件中 ${totalExcluded}件を除外中`;
  els.flaggedInfo.className = "status";
  if (els.flaggedSummary) {
    els.flaggedSummary.textContent = `対象 ${active} 件 / 除外候補 ${flagged.length} 件`;
  }

  const sections = Object.entries(byTag)
    .map(([tag, rows]) => {
      const expanded = showAllFlagged || !!tagExpandedState[tag];
      const excludedCount = rows.filter((r) => r.exclude).length;
      const displayRows = expanded ? rows : rows.slice(0, 3);
      const label = FLAG_LABELS[tag] || tag;
      return `
        <div class="flag-card">
          <div class="flag-card-head">
            <div>
              <div class="flag-chip">${label}</div>
              <span class="flag-count">${rows.length}件 / 除外 ${excludedCount}件</span>
            </div>
            <div class="flag-card-actions">
              <button data-tag="${tag}" data-action="exclude-all" class="ghost small">全除外</button>
              <button data-tag="${tag}" data-action="include-all" class="ghost small">戻す</button>
              <button data-tag="${tag}" data-action="toggle" class="ghost small">${expanded ? "閉じる" : "さらに見る"}</button>
            </div>
          </div>
          <div class="flag-rows">
            ${displayRows
              .map(
                (f) => `
                  <label class="flag-row">
                    <input type="checkbox" data-id="${f.id}" class="flag-toggle" ${f.exclude ? "checked" : ""}>
                    <div class="flag-row-body">
                      <div class="flag-row-title">${f.title || "(無題)"}</div>
                      <div class="flag-row-meta">${f.date} ・ ¥${(f.amount || 0).toLocaleString()} ・ ${f.category || "未分類"} ・ ${f.source}</div>
                    </div>
                  </label>`
              )
              .join("")}
          </div>
        </div>
      `;
    })
    .join("");

  els.flaggedList.innerHTML = sections;

  // 個別チェック
  els.flaggedList.querySelectorAll(".flag-toggle").forEach((checkbox) => {
    checkbox.addEventListener("change", (e) => {
      const id = Number(e.target.getAttribute("data-id"));
      const target = events.find((ev) => ev.id === id);
      if (target) {
        target.exclude = e.target.checked;
        refreshAggregates();
        renderFlaggedList();
      }
    });
  });

  // タグ単位アクション
  els.flaggedList.querySelectorAll("button[data-tag]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tag = btn.getAttribute("data-tag");
      const action = btn.getAttribute("data-action");
      if (action === "toggle") {
        tagExpandedState[tag] = !tagExpandedState[tag];
        renderFlaggedList();
        return;
      }
      const shouldExclude = action === "exclude-all";
      events.forEach((ev) => {
        if (ev.flags.includes(tag)) {
          ev.exclude = shouldExclude;
        }
      });
      refreshAggregates();
      renderFlaggedList();
    });
  });
}

function refreshAggregates() {
  const active = getActiveEvents();
  renderPreview(active);
  summary = computeSummary(active);
  renderSummary(summary);
}

function computeSummary(items) {
  if (!items.length) return null;
  const totalSpend = items.reduce((sum, e) => sum + (e.amount || 0), 0);

  const spendByMonth = new Map();
  const spendByQuarter = new Map();
  const spendByCategory = new Map();
  const purchaseCountByCategory = new Map();
  const yearCounts = new Map();
  const purchasesByMonthMap = new Map();
  const purchasesByQuarterMap = new Map();

  items.forEach((e) => {
    const monthKey = e.date.slice(0, 7);
    const quarterKey = toQuarterKey(monthKey);
    spendByMonth.set(monthKey, (spendByMonth.get(monthKey) || 0) + (e.amount || 0));
    spendByQuarter.set(quarterKey, (spendByQuarter.get(quarterKey) || 0) + (e.amount || 0));

    if (!purchasesByMonthMap.has(monthKey)) purchasesByMonthMap.set(monthKey, []);
    purchasesByMonthMap.get(monthKey).push({
      title: e.title,
      amount: e.amount,
      category: e.category,
      date: e.date,
      source: e.source,
    });
    if (!purchasesByQuarterMap.has(quarterKey)) {
      purchasesByQuarterMap.set(quarterKey, {
        monthItems: new Map(),
        totalAmount: 0,
        totalCount: 0,
        categoryAmounts: new Map(),
        categoryCounts: new Map(),
      });
    }
    const quarterRef = purchasesByQuarterMap.get(quarterKey);
    quarterRef.totalAmount += e.amount || 0;
    quarterRef.totalCount += 1;
    quarterRef.categoryAmounts.set(
      e.category || "未分類",
      (quarterRef.categoryAmounts.get(e.category || "未分類") || 0) + (e.amount || 0)
    );
    quarterRef.categoryCounts.set(
      e.category || "未分類",
      (quarterRef.categoryCounts.get(e.category || "未分類") || 0) + 1
    );
    if (!quarterRef.monthItems.has(monthKey)) quarterRef.monthItems.set(monthKey, []);
    quarterRef.monthItems.get(monthKey).push({
      title: e.title,
      amount: e.amount,
      category: e.category,
      date: e.date,
      source: e.source,
    });

    const cat = e.category || "未分類";
    spendByCategory.set(cat, (spendByCategory.get(cat) || 0) + (e.amount || 0));
    purchaseCountByCategory.set(cat, (purchaseCountByCategory.get(cat) || 0) + 1);

    const year = e.date.slice(0, 4);
    yearCounts.set(year, (yearCounts.get(year) || 0) + 1);
  });

  const topYear =
    [...yearCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ||
    new Date().getFullYear().toString();

  const sortedMonth = [...spendByMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const sortedCategory = [...spendByCategory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const purchasesByMonth = [...purchasesByMonthMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, list]) => ({
      month,
      items: list.sort((a, b) => b.amount - a.amount),
    }));
  const purchasesByQuarter = [...purchasesByQuarterMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([quarter, data]) => ({
      quarter,
      totalAmount: data.totalAmount,
      totalCount: data.totalCount,
      topCategoriesByAmount: [...data.categoryAmounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([category, amount]) => ({ category, amount })),
      topCategoriesByCount: [...data.categoryCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([category, count]) => ({ category, count })),
      months: [...data.monthItems.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([month, list]) => ({
          month,
          items: list.sort((a, b) => b.amount - a.amount),
        })),
    }));

  return {
    year: topYear,
    totalSpend,
    spendByMonth: sortedMonth.map(([month, amount]) => ({ month, amount })),
    spendByQuarter: [...spendByQuarter.entries()].map(([quarter, amount]) => ({ quarter, amount })),
    spendByCategory: sortedCategory.map(([category, amount]) => ({ category, amount })),
    purchaseCountByCategory: [...purchaseCountByCategory.entries()].map(([category, count]) => ({
      category,
      count,
    })),
    purchasesByMonth,
    purchasesByQuarter,
  };
}

function renderSummary(data) {
  if (!data) {
    return;
  }
}

async function autoFlow(file) {
  if (file) {
    previewFileOverride = file;
  }
  await handlePreview();
  const apiKey = els.apiKey?.value?.trim();
  if (apiKey) {
    await handleReport();
  } else {
    setStatus("APIキーを入力してレポートを生成してください。", "error");
  }
}

// Geminiに渡すプロンプトを構築
function buildReportPrompt(summaryData) {
  const schema = {
    year: "YYYY",
    title: "年間レポートのタイトル",
    spendTypeDiagnosis: "支出タイプ診断の短い一文",
    bestPurchase: { title: "今年いちばん助けた買い物", reason: "その理由" },
    praisePoints: ["今年の自分を褒めるポイント3つ"],
    messageToNextYear: "来年の自分へのひとこと（今年の購入から発展させた提案を含めてOK）",
    nextYearSuggestions: [
      { item: "おすすめの新しい購入/挑戦", reason: "今年の購入からの発展・好奇心ベースの理由" },
    ],
    quarterSummaries: [
      {
        quarter: "YYYY-Qn (例: 2024-Q1は1-3月)",
        summary: "5文の前向きサマリ（支出額＋頻出カテゴリ/タイトルに触れる。全体件数は不要）",
        prompt: "短いポジティブな問いかけ（頻出カテゴリ/タイトルから気づきを促す）",
      },
    ],
    monthPurchases: [
      {
        month: "YYYY-MM",
        items: [{ title: "購入名", amount: 0, category: "カテゴリ", date: "YYYY-MM-DD", source: "購入元" }],
      },
    ],
    monthSpendSummary: [{ month: "YYYY-MM", summary: "この月の支出の一行サマリ" }],
    memoryPrompts: [
      { month: "YYYY-MM", prompt: "この月の購入に紐づくポジティブな問いかけ（例: 美顔器の使い心地は？生活のどこが良くなった？）" },
    ],
    spendInsights: [{ topic: "支出傾向", detail: "短い所感" }],
    coverImagePrompt: "表紙画像用の短いプロンプト（任意）",
    posterImagePrompt: "ポスター画像用の短いプロンプト（任意、年間の思い出が伝わるように）",
  };

  return [
    "Based only on the provided summary JSON, create an annual review.",
    "Output strictly one JSON object and nothing else. No markdown, no code fences, no commentary.",
    "Respond in Japanese.",
    "Use playful short headings and concise sentences, but keep the tone gently upbeat (avoid over-excitement and multiple exclamation marks). Prefer句点 over exclamation; at most one ! in the whole response.",
    "For each quarter (Q1=1-3月, Q2=4-6月, Q3=7-9月, Q4=10-12月), write 5 sentences of gently upbeat summary that mentions spend amounts and high-frequency categories or recurring titles (e.g., books bought often). Avoid citing the total purchase count for the quarter; focus on which kinds of items showed up often.",
    "Ensure quarterSummaries contains one entry per quarter present in purchasesByQuarter. The quarter field must exactly match the key (e.g., 2024-Q1).",
    "For each month, select 3-5 notable purchase items from the provided monthPurchases (prioritize higher amounts, do not invent new items). Keep month arrays intact; they will be shown under each quarter.",
    "When generating coverImagePrompt/posterImagePrompt, include a sense of the year's memorable purchases and joyful reflections (short, visual, no sensitive data).",
    "Create these playful top-level sections: 支出タイプ診断 (spendTypeDiagnosis), 今年いちばん助けた買い物 (bestPurchase.title + reason), 褒めポイント3つ (praisePoints: array of 3 strings), 来年の自分へのひとこと (messageToNextYear).",
    "Additionally, propose 2-3 nextYearSuggestions (items/experiences) that build on this year's purchases and a curious, positive personality. Keep them concise; we will show them together with messageToNextYear.",
    "Return only JSON (no markdown, no tables). monthPurchases must stay as the array of objects provided so the client can render tables. quarterSummaries must be aligned with purchasesByQuarter keys.",
    "Keep the output concise and focused on quarterly reflection while enabling monthly recall; this is a prep for writing personal reflections.",
    "Use purchase counts as well as total amounts to spot patterns (e.g., frequent book buys, many small cafe visits).",
    "Follow this schema keys exactly:",
    JSON.stringify(schema, null, 2),
    "Use concise sentences. Ensure coverImagePrompt and posterImagePrompt are short descriptive prompts if provided.",
    "Summary JSON:",
    JSON.stringify(summaryData, null, 2),
  ].join("\n");
}

// POST Geminiテキスト生成API
async function callGeminiText(apiKey, summaryData, promptText) {
  const body = {
    contents: [{ role: "user", parts: [{ text: promptText || buildReportPrompt(summaryData) }] }],
    generationConfig: { temperature: 0.7 },
  };
  const res = await fetch(GENERATION_ENDPOINT(TEXT_MODEL), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Geminiテキスト生成に失敗 (${res.status}): ${text}`);
  }
  return res.json();
}

function parseGeminiTextResponse(resp) {
  const parts =
    resp?.candidates?.flatMap((c) => (c.content?.parts || []).map((p) => p.text).filter(Boolean)) ||
    [];
  const text = parts.join("\n").trim();
  if (!text) throw new Error("Geminiのレスポンスにテキストがありません。");

  try {
    return JSON.parse(text);
  } catch (e) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      const sliced = text.slice(start, end + 1);
      try {
        return JSON.parse(sliced);
      } catch (inner) {
        throw new Error("JSONパースに失敗しました。プロンプトを調整してください。");
      }
    }
    throw new Error("JSON形式を抽出できませんでした。");
  }
}

function renderReport(data) {
  if (!data) {
    els.reportView.innerHTML = "<p>レポートがまだありません。</p>";
    return;
  }
  const highlightSections = `
    <div class="report-grid">
      <div class="report-card">
        <p class="report-eyebrow">支出タイプ診断</p>
        <p class="report-body">${data.spendTypeDiagnosis || "今年の使い方をひとことで診断"}</p>
      </div>
      <div class="report-card">
        <p class="report-eyebrow">今年いちばん助けた買い物</p>
        <p class="report-body"><strong>${data.bestPurchase?.title || "-"}</strong><br>${data.bestPurchase?.reason || ""}</p>
      </div>
      <div class="report-card">
        <p class="report-eyebrow">褒めポイント</p>
        <ul class="report-list">
          ${(data.praisePoints || ["今年のがんばりを3つ挙げてください"]).slice(0, 3).map((p) => `<li>${p}</li>`).join("")}
        </ul>
      </div>
      <div class="report-card">
        <p class="report-eyebrow">来年の自分へ / 次の挑戦</p>
        <p class="report-body">${data.messageToNextYear || "一言メッセージをここに"}</p>
        <ul class="report-list">
          ${(data.nextYearSuggestions || [])
            .slice(0, 3)
            .map((s) => `<li><strong>${s.item || "-"}</strong>: ${s.reason || ""}</li>`)
            .join("") || "<li>今年の購入から広げたいことを提案します。</li>"}
        </ul>
      </div>
    </div>
  `;
  const spendInsights =
    data.spendInsights
      ?.map((s) => `<li><strong>${s.topic}</strong>: ${s.detail}</li>`)
      .join("") || "<li>なし</li>";

  // クォーターごとに月リストをまとめる
  const monthMap = new Map();
  (data.monthPurchases || []).forEach((m) => {
    const q = toQuarterKey(m.month);
    if (!monthMap.has(q)) monthMap.set(q, []);
    monthMap.get(q).push(m);
  });
  const quarterSummaries = data.quarterSummaries || [];
  const quarterSections = [...monthMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([quarter, months]) => {
      const qs = quarterSummaries.find((q) => q.quarter === quarter);
      const summaryText = qs?.summary || "このクォーターの振り返りを表示します。";
      const promptText = qs?.prompt || "思い出や成長を思い出す問いかけをここに。";
      const summaryQuarter = summary?.purchasesByQuarter?.find((q) => q.quarter === quarter);
      const totalAmount = summaryQuarter?.totalAmount || 0;
      const totalCount = summaryQuarter?.totalCount || 0;
      const monthTables = months
        .sort((a, b) => a.month.localeCompare(b.month))
        .map((m) => {
          const items = (m.items || []).slice(0, 5);
          const truncated = (m.items || []).length > items.length;
          return `
            <div class="table month-table">
              <h4>${m.month}</h4>
              <table>
                <tr><th>タイトル</th><th>カテゴリ</th><th>金額</th><th>日付</th><th>ソース</th></tr>
                ${items
                  .map(
                    (i) =>
                      `<tr><td>${i.title}</td><td>${i.category || "-"}</td><td>¥${(i.amount || 0).toLocaleString()}</td><td>${i.date || ""}</td><td>${i.source || ""}</td></tr>`
                  )
                  .join("")}
              </table>
              ${truncated ? `<p class="month-note muted">上位5件のみ表示中</p>` : ""}
            </div>
          `;
        })
        .join("");
      const expanded = !!quarterExpandedState[quarter];
      return `
        <div class="quarter-card" data-quarter="${quarter}">
          <div class="quarter-head">
            <div>
              <h3>${quarter}</h3>
              <p class="quarter-summary">${summaryText}</p>
              <p class="quarter-prompt">問い: ${promptText}</p>
              <p class="quarter-meta">合計: ¥${totalAmount.toLocaleString()} / 件数: ${totalCount}件</p>
            </div>
            <button class="ghost small" data-quarter-toggle="${quarter}">${expanded ? "月を閉じる" : "月を展開"}</button>
          </div>
          <div class="quarter-months ${expanded ? "" : "hidden"}" data-quarter="${quarter}">
            ${monthTables}
          </div>
        </div>
      `;
    })
    .join("");

  els.reportView.innerHTML = `
    <h3>${data.title || "年間レポート"}</h3>
    <p><strong>年度:</strong> ${data.year || "-"}</p>
    ${highlightSections}
    <h3>クォーター別リスト</h3>
    ${quarterSections || "<p>なし</p>"}
    <h3>支出インサイト（任意）</h3>
    <ul>${spendInsights}</ul>
    <p><strong>表紙プロンプト:</strong> ${data.coverImagePrompt || "-"}</p>
    <p><strong>ポスタープロンプト:</strong> ${data.posterImagePrompt || "-"}</p>
  `;

  // クォーター展開トグル
  document.querySelectorAll("[data-quarter-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const q = btn.getAttribute("data-quarter-toggle");
      quarterExpandedState[q] = !quarterExpandedState[q];
      renderReport(data);
    });
  });
}

// POST Gemini画像生成API
async function callGeminiImage(apiKey, prompt) {
  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: `${prompt}\n画像を生成して返してください。` }],
      },
    ],
  };
  const res = await fetch(GENERATION_ENDPOINT(IMAGE_MODEL), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`画像生成に失敗 (${res.status}): ${text}`);
  }
  return res.json();
}

function extractImageData(resp) {
  const parts =
    resp?.candidates?.flatMap((c) => c.content?.parts || []) ||
    [];
  for (const part of parts) {
    if (part.inlineData?.data && part.inlineData?.mimeType) {
      return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
    }
    if (part.text && part.text.startsWith("data:")) {
      return part.text.trim();
    }
  }
  throw new Error("画像データをレスポンスから取得できませんでした。レスポンス構造を確認してください。");
}

function renderImage(dataUrl) {
  if (!dataUrl) {
    els.imageContainer.innerHTML = "";
    els.imageActions.innerHTML = "";
    return;
  }
  els.imageContainer.innerHTML = `<img src="${dataUrl}" alt="Generated image">`;
  els.imageActions.innerHTML = `
    <button id="downloadImageBtn">画像を保存</button>
  `;
  document.getElementById("downloadImageBtn").onclick = () => {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = "annual-report-image.png";
    a.click();
  };
}

async function handlePreview() {
  setStatus("");
  const file = previewFileOverride || els.csvFile.files?.[0];
  previewFileOverride = null;
  if (!file) {
    setStatus("CSVファイルを選択してください。", "error");
    return;
  }

  disableButtons(true);
  setStatus("CSVを読み込み中...", "");
  try {
    lastEventId = 0;
    const result = await readCsvFile(file);
    const warnings = [];
    events = [];
    result.data.forEach((row, idx) => {
      const { event, warning } = normalizeRow(row, idx);
      if (warning) {
        warnings.push(warning);
        return;
      }
      events.push(event);
    });

    renderFlaggedList();
    refreshAggregates();
    setStatus(
      `読み込み完了: ${events.length}件の行を正規化しました。` +
        (warnings.length ? ` 警告: ${warnings.length}件 (console参照)` : ""),
      "success"
    );
    console.log("[CSV normalize] events:", events.length, { sample: events.slice(0, 2) });
    if (warnings.length) {
      console.warn("CSV warnings:", warnings);
    }
  } catch (err) {
    console.error(err);
    setStatus(`CSV読込に失敗しました: ${err.message}`, "error");
  } finally {
    disableButtons(false);
  }
}

// Geminiテキスト呼び出しとレポート表示
async function handleReport() {
  showView("report");
  setStatus("");
  setReportStatus("");
  const activeEvents = getActiveEvents();
  if (!events.length || !activeEvents.length) {
    const msg = "先にCSVを読み込み、除外設定を確認してください（対象行がありません）。";
    setStatus(msg, "error");
    setReportStatus(msg, "error");
    return;
  }
  const apiKey = els.apiKey.value.trim();
  if (!apiKey) {
    const msg = "APIキーを入力してください。";
    setStatus(msg, "error");
    setReportStatus(msg, "error");
    return;
  }

  summary = computeSummary(activeEvents);
  renderSummary(summary);
  setStatus(`Gemini送信準備: 有効イベント ${activeEvents.length}件`, "");
  setReportStatus(`Gemini送信準備: 有効イベント ${activeEvents.length}件`, "");

  disableButtons(true);
  const promptText = buildReportPrompt(summary);
  console.log("[Gemini request payload] events:", activeEvents.length, "summary:", summary);
  console.log("[Gemini request prompt]", promptText);
  setStatus("Geminiへ送信中...", "");
  setReportStatus("Geminiへ送信中...", "");
  try {
    const resp = await callGeminiText(apiKey, summary, promptText);
    reportJson = parseGeminiTextResponse(resp);
    console.log("[Gemini text raw response]", resp);
    console.log("[Gemini parsed JSON]", reportJson);
    renderReport(reportJson);
    setStatus("レポート生成が完了しました。", "success");
    setReportStatus("レポート生成が完了しました。", "success");
  } catch (err) {
    console.error(err);
    const msg = `レポート生成に失敗: ${err.message}`;
    setStatus(msg, "error");
    setReportStatus(msg, "error");
  } finally {
    disableButtons(false);
  }
}

async function handleImage() {
  showView("report");
  setStatus("");
  if (!reportJson) {
    setStatus("先にレポートを生成してください。", "error");
    return;
  }
  const apiKey = els.apiKey.value.trim();
  if (!apiKey) {
    setStatus("APIキーを入力してください。", "error");
    return;
  }

  // 画像生成用プロンプトを決定
  const prompt =
    reportJson.posterImagePrompt ||
    reportJson.coverImagePrompt ||
    "Annual report cover illustration, clean infographic poster";

  disableButtons(true);
  setStatus("画像を生成中...", "");
  // Gemini画像生成API呼び出し
  try {
    const resp = await callGeminiImage(apiKey, prompt);
    imageDataUrl = extractImageData(resp);
    renderImage(imageDataUrl);
    setStatus("画像生成が完了しました。", "success");
  } catch (err) {
    console.error(err);
    setStatus(`画像生成に失敗: ${err.message}`, "error");
  } finally {
    disableButtons(false);
  }
}

function init() {
  showView(currentView);
  document.querySelectorAll("[data-view-target]").forEach((btn) =>
    btn.addEventListener("click", () => showView(btn.getAttribute("data-view-target")))
  );
  if (els.previewBtn) els.previewBtn.addEventListener("click", handlePreview);
  if (els.reportBtn) els.reportBtn.addEventListener("click", handleReport);
  if (els.imageBtn) els.imageBtn.addEventListener("click", handleImage);
  if (els.imageBtn2) els.imageBtn2.addEventListener("click", handleImage);
  if (els.csvFile) {
    els.csvFile.addEventListener("change", () => autoFlow(els.csvFile.files?.[0]));
  }
  if (els.dropZone && els.csvFile) {
    ["dragenter", "dragover"].forEach((evt) =>
      els.dropZone.addEventListener(evt, (e) => {
        e.preventDefault();
        els.dropZone.classList.add("dragging");
      })
    );
    ["dragleave", "drop"].forEach((evt) =>
      els.dropZone.addEventListener(evt, (e) => {
        e.preventDefault();
        els.dropZone.classList.remove("dragging");
        if (evt === "drop" && e.dataTransfer?.files?.[0]) {
          autoFlow(e.dataTransfer.files[0]);
        }
      })
    );
  }
  if (els.togglePreview) {
    els.togglePreview.addEventListener("click", () => {
      previewExpanded = !previewExpanded;
      els.togglePreview.textContent = previewExpanded ? "少なく表示" : "もっと見る";
      refreshAggregates();
    });
  }
  if (els.toggleFlagged) {
    els.toggleFlagged.addEventListener("click", () => {
      showAllFlagged = !showAllFlagged;
      els.toggleFlagged.textContent = showAllFlagged ? "折りたたむ" : "展開";
      renderFlaggedList();
    });
  }

  // ライトボックス（Geminiキー取得手順）
  if (els.howToGemini) {
    els.howToGemini.addEventListener("click", () => showLightbox(0));
  }
  if (els.lightboxClose) els.lightboxClose.addEventListener("click", hideLightbox);
  if (els.lightboxPrev) els.lightboxPrev.addEventListener("click", () => stepLightbox(-1));
  if (els.lightboxNext) els.lightboxNext.addEventListener("click", () => stepLightbox(1));
  if (els.lightboxBackdrop) els.lightboxBackdrop.addEventListener("click", hideLightbox);
}

document.addEventListener("DOMContentLoaded", init);
const FLAG_LABELS = {
  transfer: "振替=1",
  calc_off: "計算対象=0",
  amount_zero: "金額0",
  title_empty: "タイトル空",
  income: "収入行",
  card: "カード引き落とし",
  sbi: "振替/SBIハイブリッド",
  atm: "ATM開始",
  title_generic: "汎用タイトル(振替/引落/チャージ等)",
  category_empty: "カテゴリ未設定",
  url_like: "URL風タイトル",
};
