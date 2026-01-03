# 年間振り返りレポート MVP
Gemini Developer API をブラウザから直接呼び出して、CSVから年間レポート（テキスト＋任意で画像）を生成する静的HTMLアプリです。依存はほぼゼロで、Nodeはローカルサーバ起動にのみ使います。入力するCSVはMoneyforwardアプリから取得できる「収入・支出詳細_<年>」ファイルを想定しています。

![サンプル動画](https://github.com/user-attachments/assets/fd168446-1cdf-468a-9713-99b9406a010f)

## ファイル構成
- `index.html` UI本体（APIキー入力・CSVアップロード・ボタン類）
- `app.js` ロジック（CSV正規化→集計→Gemini呼び出し→描画）
- `style.css` 最小限のスタイル
- `sample_mf.csv` サンプルデータ

## 最短起動
静的サーバを起動してブラウザで開きます（以下のいずれか）。
- `npx http-server -p 5173`
- `npx serve .`
- `python -m http.server 5173`

ブラウザで `http://localhost:5173` を開く。

## 使い方
1. AI Studio で取得した Gemini API キーを入力（保存しません。sessionStorage/localStorage 不使用）。
2. `sample.csv` を参考に CSV を選択。
3. `[1] CSVを読み込んでプレビュー` で正規化と集計を確認。
4. `[2] 年間レポートを生成（テキスト）` で Gemini テキストモデルを呼び出し、JSONレポートを整形表示。
5. 任意で `[3] 表紙/ポスター画像を生成` を実行。レポート内のプロンプトを使って画像モデル（nano banana 想定）を呼び出し、表示・ダウンロードできます。

## CSV仕様（暫定・差し替えやすい設計）
`app.js` 先頭の `CSV_COLUMN_MAP` で列名→内部フィールドのマッピングを一括管理しています。列名を変える場合はこのマップだけ更新してください。内部構造:
```
Event = {
  source: string, date: "YYYY-MM-DD", title: string,
  amount: number|null, category: string|null, url: string|null, raw: object
}
```

## モデルとエンドポイント
- テキスト: `gemini-2.5-flash`（`TEXT_MODEL`定数で差し替え可能）
- 画像: `gemini-2.5-flash-image`（`IMAGE_MODEL`定数で差し替え可能）
- エンドポイント: `https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent`
APIキーは `x-goog-api-key` ヘッダに設定し、永続保存しません。

## エラーハンドリング
- APIキー未入力やCSV未選択でボタンを押すと画面にエラー表示
- fetch 失敗時は status code とメッセージを表示
- 生成中はボタンを disabled にして二重送信を防止

## メモ
- 集計結果をローカルで計算してから Gemini に渡すため、API に生データを送らず安全です。
- レスポンスがJSON以外を返す場合に備え、JSON抽出のフォールバックを実装しています。

### Lightbox（オーバーレイ）の使い方メモ
・転用手順（最小構成）

１.HTMLに枠を置く
```
<div id="lightbox" class="lightbox hidden" aria-hidden="true">
  <div class="lightbox-backdrop"></div>
  <div class="lightbox-body" role="dialog" aria-label="Lightbox">
    <button class="lightbox-close" aria-label="閉じる">×</button>
    <button class="lightbox-nav prev" aria-label="前へ">←</button>
    <div class="lightbox-media">
      <img id="lightbox-img" alt="">
      <p class="lightbox-caption"><span id="lightbox-step"></span></p>
    </div>
    <button class="lightbox-nav next" aria-label="次へ">→</button>
  </div>
</div>
<button id="openLightbox">開く</button>
```
ID/class 名は現行のまま使うとそのまま流用可。必要なら id を任意に変えて後述の init 引数も合わせる。

２. CSSを取り込む
style.css の .lightbox... セクションを流用（ホバーやレスポンシブ含む）。既存CSSに追記するだけでOK。
JSを組み込む
```
import { initLightbox } from "./lightbox.js";

const lightbox = initLightbox({
  els: {
    container: document.getElementById("lightbox"),
    img: document.getElementById("lightbox-img"),
    close: document.querySelector(".lightbox-close"),
    prev: document.querySelector(".lightbox-nav.prev"),
    next: document.querySelector(".lightbox-nav.next"),
    backdrop: document.querySelector(".lightbox-backdrop"),
    step: document.getElementById("lightbox-step"), // 任意
  },
  images: ["images/step1.png", "images/step2.png", "images/step3.png"],
});
```
// 開くトリガー
`document.getElementById("openLightbox").addEventListener("click", () => lightbox.show(0));
images` を使いたい画像配列に差し替え。
step 要素を渡さなければ手順表示は省略される。
実行環境
type="module" でスクリプトを読み込む（ESM importが必要）。
外部依存なし。fetch不要。
これで他のサイトでも、画像配列とトリガーを差し替えるだけで同じオーバーレイ部品を使い回せます。