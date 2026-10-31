/**
 * 唐揚げ在庫管理 API（Google Apps Script）
 *
 * スプレッドシート「唐揚げ在庫管理データ」に紐づけて使う。
 *   1. スプレッドシートを開き「拡張機能 → Apps Script」
 *   2. このファイルの中身を Code.gs に貼り付けて保存
 *   3. プロジェクトの設定（歯車）→ スクリプト プロパティ に
 *      ADDR_PASSWORD（住所を見るためのパスワード）を追加
 *   4. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *      次のユーザーとして実行：自分 ／ アクセスできるユーザー：全員
 *   5. 表示された「ウェブアプリのURL」をアプリの config.js に入れる
 *
 * このファイルはGitHubで公開されるので、住所やパスワードは書かないこと。
 *
 * API
 *   GET  ?action=state                         → 家・記録・基準・メモ（住所は含まない）
 *   POST {action:"add", id, k, t, n, d}       → 記録を追加（k: buy/give/collect, t: 店名か家の名前）
 *   POST {action:"undo", id}                   → 記録を取り消し（行は残し、取消日時を入れる）
 *   POST {action:"addresses", password}        → パスワードが合えば住所を返す
 */

const TAB = { places: "家", records: "記録", settings: "設定", notes: "メモ" };
const KIND_JA = { buy: "購入", give: "分配", collect: "回収" };
const KIND_EN = { "購入": "buy", "分配": "give", "回収": "collect" };
const MAX_TEXT = 40;
const MAX_FAILS = 10;          // 住所パスワードの連続失敗の上限
const LOCK_SECONDS = 600;      // 上限に達したら10分間受け付けない

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || "state";
    if (action === "state") return json_(state_());
    return json_(fail_("unknown_action"));
  } catch (err) {
    return json_(fail_("server_error", err));
  }
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    if (body.action === "add") return json_(add_(body));
    if (body.action === "undo") return json_(undo_(body));
    if (body.action === "addresses") return json_(addresses_(body));
    return json_(fail_("unknown_action"));
  } catch (err) {
    return json_(fail_("server_error", err));
  }
}

// ---- 読み出し ----

function state_() {
  const places = rows_(TAB.places)
    .filter(function (r) { return text_(r[0]) !== ""; })
    .map(function (r) {
      return { name: text_(r[0]), base: num_(r[1]), note: text_(r[3]), hasAddress: text_(r[2]) !== "" };
    });

  const records = [];
  rows_(TAB.records).forEach(function (r) {
    const id = text_(r[0]);
    if (!id || text_(r[6]) !== "") return;           // 空行・取り消し済み
    const k = KIND_EN[text_(r[1])];
    const n = Number(r[3]);
    const d = dateText_(r[4]);
    const t = text_(r[2]);
    if (!k || !t || !(n > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    records.push({ id: id, k: k, t: t, n: n, d: d, at: r[5] instanceof Date ? r[5].getTime() : 0 });
  });

  const s = settings_();
  const notes = rows_(TAB.notes, true).map(function (r) { return text_(r[0]); }).filter(Boolean);
  return {
    ok: true,
    places: places,
    records: records,
    baseDate: dateText_(s["基準日"]),
    baseTransit: num_(s["基準の手元・未分配"]),
    notes: notes,
  };
}

// ---- 書き込み ----

function add_(b) {
  const k = String(b.k || "");
  if (!KIND_JA[k]) return fail_("bad_kind");
  const n = Number(b.n);
  if (!isInt_(n) || n < 1 || n > 999) return fail_("bad_bags");
  const d = String(b.d || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return fail_("bad_date");
  let t = clean_(b.t);
  if (k === "buy") t = t.replace(/^業務スーパー\s*/, "");
  if (!t) return fail_("bad_text");
  // アプリ側で作ったIDを使う（通信のやり直しで二重に登録されないように）
  const id = /^[A-Za-z0-9-]{8,64}$/.test(String(b.id || "")) ? String(b.id) : Utilities.getUuid();

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(TAB.records);
    if (findRow_(sh, id) < 0) {
      if (k !== "buy") ensurePlace_(t);
      sh.appendRow([asText_(id), KIND_JA[k], asText_(t), n, asText_(d), new Date(), ""]);
    }
  } finally {
    lock.releaseLock();
  }
  return state_();
}

function undo_(b) {
  const id = String(b.id || "");
  if (!id) return fail_("bad_id");
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(TAB.records);
    const row = findRow_(sh, id);
    if (row > 0) {
      const cell = sh.getRange(row, 7);
      if (text_(cell.getValue()) === "") cell.setValue(new Date());
    }
  } finally {
    lock.releaseLock();
  }
  return state_();
}

function addresses_(b) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get("addr_fails") || 0);
  if (fails >= MAX_FAILS) return fail_("locked");
  const password = PropertiesService.getScriptProperties().getProperty("ADDR_PASSWORD");
  if (!password) return fail_("no_password_set");
  if (String(b.password || "") !== password) {
    cache.put("addr_fails", String(fails + 1), LOCK_SECONDS);
    Utilities.sleep(1500);
    return fail_("bad_password");
  }
  const addresses = {};
  rows_(TAB.places).forEach(function (r) {
    const name = text_(r[0]);
    const address = text_(r[2]);
    if (name && address) addresses[name] = address;
  });
  return { ok: true, addresses: addresses };
}

// 分配・回収で知らない名前が来たら「家」タブに行を足す（今の袋数の数式つき）
function ensurePlace_(name) {
  const names = rows_(TAB.places).map(function (r) { return text_(r[0]); });
  if (names.indexOf(name) >= 0) return;
  const sh = sheet_(TAB.places);
  sh.appendRow([asText_(name), 0, "", "", ""]);
  const r = sh.getLastRow();
  sh.getRange(r, 5).setFormula(stockFormula_(r));
}

function stockFormula_(r) {
  const sum = function (kind) {
    return 'SUMIFS(記録!$D:$D,記録!$B:$B,"' + kind + '",記録!$C:$C,$A' + r + ',記録!$G:$G,"")';
  };
  return "=B" + r + "+" + sum("分配") + "-" + sum("回収");
}

// ---- 小物 ----

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error("シート「" + name + "」が見つかりません");
  return sh;
}

function rows_(name, optional) {
  const sh = ss_().getSheetByName(name);
  if (!sh) {
    if (optional) return [];
    throw new Error("シート「" + name + "」が見つかりません");
  }
  return sh.getDataRange().getValues().slice(1);
}

function settings_() {
  const map = {};
  rows_(TAB.settings).forEach(function (r) {
    const key = text_(r[0]);
    if (key) map[key] = r[1];
  });
  return map;
}

function findRow_(sh, id) {
  const last = sh.getLastRow();
  if (last < 2) return -1;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (text_(ids[i][0]) === id) return i + 2;
  }
  return -1;
}

function text_(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return dateText_(v);
  return String(v).trim();
}

function dateText_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, ss_().getSpreadsheetTimeZone() || "Asia/Tokyo", "yyyy-MM-dd");
  return v === null || v === undefined ? "" : String(v).trim();
}

function num_(v) { const n = Number(v); return isFinite(n) ? n : 0; }

function isInt_(n) { return typeof n === "number" && isFinite(n) && Math.floor(n) === n; }

function clean_(v) {
  return String(v === null || v === undefined ? "" : v)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_TEXT);
}

// 先頭に ' を付けて、文字列のまま保存させる（数式・数値・日付に変換されないように）
function asText_(s) { return "'" + s; }

function fail_(code, err) {
  const out = { ok: false, error: code };
  if (err) out.message = String((err && err.message) || err);
  return out;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
