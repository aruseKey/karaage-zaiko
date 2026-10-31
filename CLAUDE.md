# CLAUDE.md

大学の吹奏楽部が文化祭で売る「匠の金賞唐揚げ」の在庫管理アプリ。使うのは部員と文化祭の実行委員で、ほぼスマホから使う。

## 構成

- `index.html`：アプリ本体。ビルドなし、外部ライブラリなしの1ファイル（HTML・CSS・JS）。GitHub Pages でそのまま公開される
- `config.js`：Apps Script ウェブアプリのURL（`window.KARAAGE_API_URL`）
- `apps-script/Code.gs`：API。スプレッドシート「唐揚げ在庫管理データ」に紐づけた Apps Script。ここを変えたら、スプレッドシート側に貼り直して「新バージョン」でデプロイし直す必要がある（GitHubにpushしただけでは反映されない）
- `manifest.webmanifest`・アイコン：ホーム画面に追加したとき用

## API（Code.gs）

- `GET ?action=state` → `{ok, places:[{name, base, note, hasAddress}], records:[{id, k, t, n, d, at}], baseDate, baseTransit, notes}`
  - `k` は `buy`（購入）/ `give`（分配）/ `collect`（回収）、`t` は店名（購入）か家の名前、`n` は袋数、`d` は `YYYY-MM-DD`、`at` は入力時刻（ms）
  - 住所は返さない
- `POST {action:"add", id, k, t, n, d}`：記録を追加。`id` はアプリ側で作るUUIDで、同じIDは二重登録しない
- `POST {action:"undo", id}`：取り消し（行は消さず「取消日時」を入れる）
- `POST {action:"addresses", password}`：スクリプトプロパティ `ADDR_PASSWORD` と合えば `{ok, addresses:{名前: 住所}}`。10回間違えると10分止まる
- POST は `Content-Type: text/plain` のまま送る（Apps Script は CORS の事前確認に応答できないため）

## 在庫の計算

- 家ごとの今の袋数 ＝ 11/1時点の袋数 ＋ 分配 − 回収
- 手元・未分配 ＝ 基準の手元・未分配 ＋ 購入 − 分配
- 在庫合計 ＝ 11/1時点の合計 ＋ 購入 − 回収

## ルール

- 画面の文言は日本語。スマホ（幅390px前後）で見やすいことを優先する
- 住所・パスワード・個人のデータをこのリポジトリに書かない（Public リポジトリ）。データはスプレッドシートにだけ置く
- `index.html` は1ファイルのまま保つ。ライブラリやビルド工程は足さない
- 確認は、ローカルで `python3 -m http.server` を立てて、`config.js` と API を Playwright の `route` で差し替えて行う
