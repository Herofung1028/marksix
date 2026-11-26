// 六合彩攪珠結果自動更新（由 GitHub Actions 執行）
// 用法：
//   node update.mjs            → 加入最近幾期（每次開獎後自動執行）
//   node update.mjs backfill   → 一次過下載由 1993 年至今嘅全部歷史（第一次設定時用）
// 結果寫入 data/draws.csv：id,date,n1,n2,n3,n4,n5,n6,sp

import fs from 'node:fs';

const FILE = 'data/draws.csv';
const HEADER = 'id,date,n1,n2,n3,n4,n5,n6,sp';
const HKJC = 'https://info.cld.hkjc.com/graphql/base/';
const LATEST_APIS = [
  'https://api1.marksix6.net/lottery_api.php?type=hk',
  'https://api2.marksix6.net/lottery_api.php?type=hk',
  'https://api3.marksix6.net/lottery_api.php?type=hk',
];
// 第二個歷史來源（第三方整理、已對照馬會公佈）：馬會接口用唔到時先用
const BACKUP_HISTORY = 'https://raw.githubusercontent.com/hklamsir/marksix/main/data/draw_results_verified.json';

const HKJC_QUERY = `fragment lotteryDrawsFragment on LotteryDraw {
  id
  year
  no
  openDate
  closeDate
  drawDate
  status
  snowballCode
  snowballName_en
  snowballName_ch
  lotteryPool {
    sell
    status
    totalInvestment
    jackpot
    unitBet
    estimatedPrize
    derivedFirstPrizeDiv
    lotteryPrizes {
      type
      winningUnit
      dividend
    }
  }
  drawResult {
    drawnNo
    xDrawnNo
  }
}

query marksixResult($lastNDraw: Int, $startDate: String, $endDate: String, $drawType: LotteryDrawType) {
  lotteryDraws(
    lastNDraw: $lastNDraw
    startDate: $startDate
    endDate: $endDate
    drawType: $drawType
  ) {
    ...lotteryDrawsFragment
  }
}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad2 = n => String(n).padStart(2, '0');

// ---------- 資料檢查 ----------
function normId(id) {
  const m = String(id || '').trim().match(/^(\d{2}|\d{4})\s*\/?\s*(\d{1,3})$/);
  if (!m) return '';
  return `${m[1].slice(-2)}/${m[2].padStart(3, '0')}`;
}
function normDate(d) {
  const m = String(d || '').match(/(\d{4})-?(\d{2})-?(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}
function makeDraw(id, date, nums, sp) {
  id = normId(id); date = normDate(date);
  nums = (nums || []).map(Number); sp = Number(sp);
  const all = [...nums, sp];
  if (!id || nums.length !== 6 || all.some(x => !Number.isInteger(x) || x < 1 || x > 49) || new Set(all).size !== 7) return null;
  return { id, date, n: nums.sort((a, b) => a - b), sp };
}
// 期數排序用：1993–2092 年
const sortKey = d => {
  const yy = +d.id.slice(0, 2);
  return (yy >= 93 ? 1900 + yy : 2000 + yy) * 1000 + +d.id.slice(3);
};

// ---------- CSV ----------
function readCsv() {
  const map = new Map();
  if (!fs.existsSync(FILE)) return map;
  for (const line of fs.readFileSync(FILE, 'utf8').split(/\r?\n/).slice(1)) {
    const c = line.split(',');
    if (c.length < 9) continue;
    const d = makeDraw(c[0], c[1], c.slice(2, 8), c[8]);
    if (d) map.set(d.id, d);
  }
  return map;
}
function writeCsv(map) {
  const rows = [...map.values()].sort((a, b) => sortKey(a) - sortKey(b))
    .map(d => [d.id, d.date, ...d.n.map(pad2), pad2(d.sp)].join(','));
  fs.mkdirSync('data', { recursive: true });
  const text = [HEADER, ...rows].join('\n') + '\n';
  const old = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : '';
  if (text !== old) { fs.writeFileSync(FILE, text); return true; }
  return false;
}

// ---------- 來源 1：馬會 GraphQL ----------
async function hkjc(variables) {
  const res = await fetch(HKJC, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Origin': 'https://bet.hkjc.com',
      'Referer': 'https://bet.hkjc.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    },
    body: JSON.stringify({ operationName: 'marksixResult', variables, query: HKJC_QUERY }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`馬會 HTTP ${res.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  if (j.errors) throw new Error('馬會回覆錯誤: ' + JSON.stringify(j.errors).slice(0, 300));
  const list = (j.data && j.data.lotteryDraws) || [];
  return list.map(x => {
    const r = x.drawResult || {};
    const id = x.id && /\//.test(x.id) ? x.id : `${String(x.year || '').slice(-2)}/${x.no}`;
    return makeDraw(id, x.drawDate, r.drawnNo, r.xDrawnNo);
  }).filter(Boolean);
}
const ymd = d => `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
async function hkjcRange(from, to) {
  const out = [];
  for (let s = new Date(from); s <= to; ) {
    const e = new Date(Math.min(to.getTime(), Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 3, 0)));
    const part = await hkjc({ lastNDraw: null, startDate: ymd(s), endDate: ymd(e), drawType: 'All' });
    out.push(...part);
    console.log(`  馬會 ${ymd(s)}–${ymd(e)}：${part.length} 期`);
    s = new Date(e.getTime() + 86400000);
    await sleep(800);   // 唔好太快，對馬會伺服器有禮貌
  }
  return out;
}

// ---------- 來源 2：公開接口（只有最新一期） ----------
async function latestApi() {
  for (const url of LATEST_APIS) {
    try {
      const res = await fetch(url + '&_=' + Date.now(), { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const raw = (j.numbers && j.numbers.length ? j.numbers : String(j.openCode || '').split(',')).map(x => parseInt(x, 10));
      const exp = String(j.expect || '');
      const id = /^\d{7}$/.test(exp) ? `${exp.slice(2, 4)}/${exp.slice(4)}` : exp;
      const d = makeDraw(id, j.openTime, raw.slice(0, 6), raw[6]);
      if (d) return d;
      throw new Error('格式不正確');
    } catch (e) { console.log(`  ${url} 失敗：${e.message}`); }
  }
  return null;
}

// ---------- 來源 3：第三方歷史檔（格式未必固定，盡量自動識別） ----------
function walkDraws(node, out) {
  if (Array.isArray(node)) { node.forEach(x => walkDraws(x, out)); return; }
  if (!node || typeof node !== 'object') return;
  const vals = Object.entries(node);
  const idVal = vals.find(([k, v]) => typeof v === 'string' && /^(\d{2}|\d{4})\/\d{1,3}$/.test(v.trim()));
  const nums = vals.find(([k, v]) => Array.isArray(v) && v.length >= 6 && v.length <= 7 && v.every(x => /^\d{1,2}$/.test(String(x))));
  const res = node.drawResult || node.result || null;
  let n = null, sp = null;
  if (res && Array.isArray(res.drawnNo)) { n = res.drawnNo; sp = res.xDrawnNo; }
  else if (nums) {
    n = nums[1].slice(0, 6);
    sp = nums[1].length === 7 ? nums[1][6]
      : (vals.find(([k, v]) => /special|extra|xdrawn|sp$|特別/i.test(k) && /^\d{1,2}$/.test(String(v))) || [])[1];
  }
  const dateVal = vals.find(([k, v]) => /date/i.test(k) && /\d{4}-?\d{2}-?\d{2}/.test(String(v)));
  if (idVal && n) {
    const d = makeDraw(idVal[1], dateVal ? dateVal[1] : '', n, sp);
    if (d) { out.push(d); return; }
  }
  vals.forEach(([, v]) => { if (v && typeof v === 'object') walkDraws(v, out); });
}
async function backupHistory() {
  const res = await fetch(BACKUP_HISTORY, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const out = [];
  walkDraws(await res.json(), out);
  return out;
}

// ---------- 主程式 ----------
const backfill = process.argv[2] === 'backfill';
const META = 'data/meta.json';
let source = '';   // 今次成功用咗邊個來源
const map = readCsv();
const before = map.size;
let added = 0;
const merge = list => list.forEach(d => {
  const old = map.get(d.id);
  if (!old || (!old.date && d.date)) { if (!old) added++; map.set(d.id, d); }
});

if (backfill) {
  console.log('▶ 下載全部歷史資料…');
  let ok = false;
  try { merge(await hkjcRange(new Date(Date.UTC(1993, 0, 1)), new Date())); ok = true; source = '馬會'; }
  catch (e) { console.log('⚠ 馬會接口失敗：' + e.message); }
  if (!ok || map.size < 3000) {
    try { const list = await backupHistory(); console.log(`  後備來源：${list.length} 期`); merge(list); source = source ? source + '+後備' : '後備'; }
    catch (e) { console.log('⚠ 後備來源失敗：' + e.message); }
  }
} else {
  console.log('▶ 檢查最新開獎結果…');
  try {
    const to = new Date(), from = new Date(Date.now() - 45 * 86400000);
    merge(await hkjc({ lastNDraw: null, startDate: ymd(from), endDate: ymd(to), drawType: 'All' }));
    source = '馬會';
  } catch (e) {
    console.log('⚠ 馬會接口失敗，改用公開接口：' + e.message);
    const d = await latestApi();
    if (d) { merge([d]); source = '公開接口'; }
  }
}

const changed = writeCsv(map);
const sorted = [...map.values()].sort((a, b) => sortKey(a) - sortKey(b));
const last = sorted[sorted.length - 1];
console.log(`✔ 原有 ${before} 期，新加入 ${added} 期，共 ${map.size} 期，最新 ${last ? last.id + ' ' + last.date : '—'}${changed ? '' : '（冇變動）'}`);

// 自我檢查：2002-07-04 至 26/118 嘅期數應為 3,395 期
const chk = sorted.filter(d => d.date >= '2002-07-04' && sortKey(d) <= 2026118);
if (chk.length) console.log(`ℹ 自我檢查：2002-07-04 至 26/118 共 ${chk.length} 期（應為 3395）`);
if (!map.size) { console.log('✘ 未能取得任何資料'); process.exit(1); }

// 系統狀態：網頁頂部顯示「資料更新時間」同「最後檢查時間」
// checkedAt 每次執行都會更新（即使冇新一期），咁使用者可以分辨「未開獎」定「系統停咗」
let oldMeta = {};
try { oldMeta = JSON.parse(fs.readFileSync(META, 'utf8')) || {}; } catch (e) {}
const nowIso = new Date().toISOString();
const meta = {
  checkedAt: nowIso,
  updatedAt: changed || !oldMeta.updatedAt ? nowIso : oldMeta.updatedAt,
  latestId: last ? last.id : '',
  latestDate: last ? last.date : '',
  total: map.size,
  ok: !!source,
  source: source || '全部來源失敗',
};
fs.writeFileSync(META, JSON.stringify(meta, null, 2) + '\n');
console.log(`ℹ 狀態：${JSON.stringify(meta)}`);
