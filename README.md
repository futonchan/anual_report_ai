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
