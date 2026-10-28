'use strict';

/**
 * SiTBANK — サーバー (KAZUTBANK)
 *
 *  ・GAKU acct でログイン(確認コードをサーバー側で検証)
 *  ・プロジェクトを作り、ファイルをデプロイ → /s/<プロジェクトID>/ で公開
 *  ・プロジェクトごとの「環境変数」(暗号化して保存)
 *  ・プロジェクトの server.js を隔離したプロセスで実行(/s/<ID>/api/*)
 *  ・データの保存先は SerBANK。Secret キーはこのサーバーの環境変数にだけ置く
 */

const express = require('express');
const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ======================================================================
// 設定
// ======================================================================
const BASE = (process.env.SERBANK_BASE_URL || 'https://serbank.onrender.com/p/e3f7d6c63aa9').replace(/\/+$/, '');
const SB_ORIGIN = new URL(BASE).origin;
const PUBLIC_KEY = 'pk_OCESj6TyOa4RRMMPgPhESs5G2OQId_mm'; // 読み取り専用(公開OK)
const SECRET_KEY = process.env.SERBANK_SECRET_KEY || '';   // 書き込み用(環境変数・絶対に公開しない)
const MASTER = process.env.SITBANK_SECRET || SECRET_KEY;   // 暗号化・ログイン署名の元になる秘密
const GAKU_URL = process.env.GAKU_ACCT_URL ||
  'https://script.google.com/a/macros/school.kasugai.ed.jp/s/AKfycbyDnabgy3qc0L6Y4cfwW53tyzPMPS2thg1nd6mAvtIHa5YURK3Tui4c7vCUWt47sCow/exec';
// 公開サイトを「別のドメイン」で配信する設定(どちらも省略可)。
//   SITE_HOST   … 公開サイト専用のドメイン1つ(例: sitbank-sites.vercel.app)。サイトのURLは https://<SITE_HOST>/s/<ID>/
//   SITE_DOMAIN … ワイルドカードのドメイン(例: example.com)。サイトのURLは https://<ID>.example.com/ (サイトごとに別オリジン)
// 別ドメインで配信すると、サイトは sandbox なしの「ふつうのサイト」として動く(GAKU acct などの埋め込み・Cookie・IndexedDB も使える)。
const hostEnv = (v) => String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[\/:].*$/, '');
const SITE_HOST = hostEnv(process.env.SITE_HOST);
const SITE_DOMAIN = hostEnv(process.env.SITE_DOMAIN);
const siteBase = (id) => SITE_DOMAIN ? `https://${id}.${SITE_DOMAIN}/` : SITE_HOST ? `https://${SITE_HOST}/s/${id}/` : `/s/${id}/`;
const SERVER_CODE_ENABLED = process.env.ENABLE_SERVER_CODE !== '0';
const SERVER_TIMEOUT_MS = Math.min(Math.max(Number(process.env.SERVER_TIMEOUT_MS) || 8000, 1000), 55000);
const MAX_MEDIA_BYTES = Number(process.env.MAX_MEDIA_BYTES) || 4 * 1024 * 1024; // Vercel の本文上限(4.5MB)に合わせる

const SESSION_MS = 14 * 24 * 3600 * 1000;
const CHUNK_CHARS = 60000;       // SerBANK は1件64KBまで
const MAX_PUB_CHUNKS = 16;       // 公開ファイル(圧縮後 約700KB)
const MAX_PRIV_CHUNKS = 4;       // server.js など(圧縮後 約170KB)
const MAX_FILES = 150;
const MAX_MEDIA = 30;
const MAX_PROJECTS = 15;
const MAX_ENV = 30;
const META_TTL = 5000;

const ID_RE = /^[a-z0-9][a-z0-9-]{2,29}$/;
// ファイル名の1区切り(フォルダ名・ファイル名)。どの言語の文字も、スペース(先頭・末尾も)、あらゆる記号・絵文字もOK。
// だめなもの: / (フォルダの区切り)、制御文字(改行など)、壊れた文字、「.」「..」だけの名前
function segOk(s) {
  if (s.length < 1 || s.length > 60) return false;
  if (s === '.' || s === '..') return false;
  if (s.includes('/')) return false;
  if (/[\p{Cc}\p{Cs}]/u.test(s)) return false;
  return true;
}
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,49}$/;
const ENV_RESERVED = /^(NODE_|LD_|DYLD_|UV_|OPENSSL_|SSL_CERT|SITBANK)/i;

const TEXT_EXT = new Set(['html', 'htm', 'css', 'js', 'mjs', 'cjs', 'json', 'svg', 'txt', 'md', 'xml', 'csv', 'tsv', 'map', 'webmanifest', 'yml', 'yaml']);
const BIN_EXT = new Set(['ico', 'woff', 'woff2', 'ttf', 'otf', 'pdf', 'mp3', 'wav', 'ogg', 'm4a', 'bmp']);
const MEDIA = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
};
const MIME = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  cjs: 'text/javascript', json: 'application/json', svg: 'image/svg+xml', txt: 'text/plain',
  md: 'text/plain', xml: 'application/xml', csv: 'text/csv', tsv: 'text/tab-separated-values',
  map: 'application/json', webmanifest: 'application/manifest+json', yml: 'text/plain', yaml: 'text/plain',
  ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', bmp: 'image/bmp',
};

// ======================================================================
// 共通ヘルパー
// ======================================================================
const fail = (status, message) => { const e = new Error(message); e.status = status; return e; };
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const mw = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then(() => next(), next);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const extOf = (p) => { const n = p.split('/').pop(); const i = n.lastIndexOf('.'); return i < 0 ? '' : n.slice(i + 1).toLowerCase(); };

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// キーごとの直列化(同じインスタンス内)
const lockTails = new Map();
function withLock(key, fn) {
  const prev = lockTails.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  lockTails.set(key, tail);
  tail.then(() => { if (lockTails.get(key) === tail) lockTails.delete(key); });
  return run;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => { while (i < items.length) { const n = i++; out[n] = await fn(items[n], n); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// 簡易レート制限(インスタンス内)
const hits = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const a = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (a.length >= max) { hits.set(key, a); throw fail(429, 'リクエストが多すぎます。少し待ってからもう一度お試しください'); }
  a.push(now);
  hits.set(key, a);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
}

// ======================================================================
// 暗号・署名 (MASTER から鍵を派生)
// ======================================================================
let keys = null;
function K() {
  if (!MASTER) throw fail(500, 'SERBANK_SECRET_KEY(または SITBANK_SECRET)が設定されていません');
  if (!keys) {
    const d = (info) => Buffer.from(crypto.hkdfSync('sha256', MASTER, 'sitbank-v1', info, 32));
    keys = { enc: d('enc'), mac: d('mac') };
  }
  return keys;
}
const hmac = (s) => crypto.createHmac('sha256', K().mac).update(s).digest('base64url');

function encrypt(data) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', K().enc, iv);
  const ct = Buffer.concat([c.update(data), c.final()]);
  return ['v1', b64u(iv), b64u(c.getAuthTag()), b64u(ct)].join('.');
}
function decrypt(str) {
  const [v, iv, tag, ct] = String(str).split('.');
  if (v !== 'v1' || !ct) throw fail(500, '暗号化データの形式が正しくありません');
  const d = crypto.createDecipheriv('aes-256-gcm', K().enc, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
}

function signToken(payload) { const body = b64u(JSON.stringify(payload)); return body + '.' + hmac(body); }
function readToken(t) {
  try {
    const [body, sig] = String(t).split('.');
    if (!body || !sig || !safeEq(sig, hmac(body))) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p && p.exp > Date.now() ? p : null;
  } catch { return null; }
}

// ======================================================================
// SerBANK
// ======================================================================
async function sbReq(method, p, opts = {}) {
  const key = opts.key || SECRET_KEY;
  if (!key) throw fail(500, 'SERBANK_SECRET_KEY が設定されていません');
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(BASE + p, {
        method,
        headers: { 'X-API-Key': key, ...(opts.headers || {}) },
        body: opts.body,
        signal: AbortSignal.timeout(opts.timeout || 25000),
      });
      if ([502, 503, 504].includes(res.status) && attempt < 2) { attempt++; await sleep(1500 * attempt); continue; }
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* JSON以外 */ }
      return { status: res.status, json, text };
    } catch {
      if (attempt < 2) { attempt++; await sleep(1500 * attempt); continue; }
      throw fail(502, 'SerBANK に接続できませんでした。少し待ってからもう一度お試しください');
    }
  }
}

function sbError(r) {
  if (r.status === 401 || r.status === 403) return fail(500, 'SerBANK の認証に失敗しました。キーの設定を確認してください');
  if (r.status === 507) return fail(507, 'SerBANK の容量や件数がいっぱいです');
  if (r.status === 413) return fail(413, 'データが大きすぎます');
  return fail(r.status >= 400 && r.status < 600 ? r.status : 502, (r.json && r.json.error) || `SerBANK エラー (${r.status})`);
}

async function getStr(key) {
  const r = await sbReq('GET', '/data/' + encodeURIComponent(key), { key: PUBLIC_KEY });
  if (r.status === 404) return null;
  if (r.status >= 400) throw sbError(r);
  const j = r.json;
  if (j && typeof j === 'object' && !Array.isArray(j) && 'value' in j) return typeof j.value === 'string' ? j.value : JSON.stringify(j.value);
  if (typeof j === 'string') return j;
  return r.text;
}
async function putStr(key, str) {
  const body = JSON.stringify({ value: str });
  if (Buffer.byteLength(body) > 65000) throw fail(413, 'データが大きすぎます(64KB を超えました)');
  const r = await sbReq('PUT', '/data/' + encodeURIComponent(key), { body, headers: { 'Content-Type': 'application/json' } });
  if (r.status >= 400) throw sbError(r);
}
async function delKey(key) {
  const r = await sbReq('DELETE', '/data/' + encodeURIComponent(key));
  if (r.status >= 400 && r.status !== 404) throw sbError(r);
}
async function delFile(id) {
  try { await sbReq('DELETE', '/files/' + encodeURIComponent(id)); } catch { /* 消せなくても続ける */ }
}

// ---- キー名 ----
const kAcct = (aid) => `a_${aid}`;
const kProj = (id) => `p_${id}`;
const kEnv = (id) => `e_${id}`;
const kPub = (id, ver, n) => `d_${id}_${ver}_${n}`;
const kPriv = (id, ver, n) => `s_${id}_${ver}_${n}`;

// ---- アカウント(暗号化して保存) ----
const accountId = (cls, no) => crypto.createHmac('sha256', K().mac).update(`acct|${cls}|${no}`).digest('hex').slice(0, 24);
async function loadAccount(aid) {
  const s = await getStr(kAcct(aid));
  return s ? JSON.parse(decrypt(s).toString('utf8')) : null;
}
const saveAccount = (aid, rec) => putStr(kAcct(aid), encrypt(JSON.stringify(rec)));

// ---- プロジェクト ----
const metaCache = new Map();
async function loadProject(id, { fresh = false } = {}) {
  if (!ID_RE.test(id)) return null;
  const c = metaCache.get(id);
  if (!fresh && c && Date.now() - c.t < META_TTL) return c.meta;
  const s = await getStr(kProj(id));
  const meta = s ? JSON.parse(s) : null;
  metaCache.set(id, { t: Date.now(), meta });
  if (metaCache.size > 200) metaCache.delete(metaCache.keys().next().value);
  return meta;
}
async function saveProject(id, meta) {
  const s = JSON.stringify(meta);
  if (Buffer.byteLength(s) > 60000) throw fail(413, 'ファイルの数が多すぎます');
  await putStr(kProj(id), s);
  metaCache.set(id, { t: Date.now(), meta });
}

// ---- 環境変数(暗号化して保存) ----
async function loadEnv(id) {
  const s = await getStr(kEnv(id));
  return s ? JSON.parse(decrypt(s).toString('utf8')) : [];
}

// ---- デプロイ内容(圧縮 → 分割して保存) ----
function splitChunks(str) {
  const out = [];
  for (let i = 0; i < str.length; i += CHUNK_CHARS) out.push(str.slice(i, i + CHUNK_CHARS));
  return out.length ? out : [''];
}
const gz = (obj) => zlib.gzipSync(Buffer.from(JSON.stringify(obj)), { level: 9 });
const gunz = (buf) => JSON.parse(zlib.gunzipSync(buf, { maxOutputLength: 30 * 1024 * 1024 }).toString('utf8'));
const packPublic = (map) => splitChunks(gz(map).toString('base64'));
const packPrivate = (map) => splitChunks(encrypt(gz(map)));
const unpackPublic = (parts) => gunz(Buffer.from(parts.join(''), 'base64'));
const unpackPrivate = (parts) => gunz(decrypt(parts.join('')));

const bundleCache = new Map();
async function loadBundle(meta, id, priv) {
  const n = priv ? meta.sn : meta.dn;
  if (!n || !meta.ver) return {};
  const ck = `${priv ? 's' : 'd'}:${id}:${meta.ver}`;
  if (bundleCache.has(ck)) return bundleCache.get(ck);
  const parts = await mapLimit(Array.from({ length: n }, (_, i) => i), 6, async (i) => {
    const s = await getStr((priv ? kPriv : kPub)(id, meta.ver, i));
    if (s === null) throw fail(502, 'デプロイ内容が見つかりません(保存の途中かもしれません。少し待ってからもう一度お試しください)');
    return s;
  });
  const map = priv ? unpackPrivate(parts) : unpackPublic(parts);
  bundleCache.set(ck, map);
  if (bundleCache.size > 16) bundleCache.delete(bundleCache.keys().next().value);
  return map;
}

const fileIndex = (meta) => new Map((meta.files || []).map((f) => [f.p, f]));

// ======================================================================
// 入力チェック
// ======================================================================
function cleanName(name, what = '名前') {
  const n = String(name == null ? '' : name).trim();
  if (!n) throw fail(400, `${what}を入力してください`);
  if (n.length > 40) throw fail(400, `${what}は40文字までです`);
  return n;
}

function cleanPath(p) {
  p = String(p || '').normalize('NFC').replace(/^\.?\/+/, ''); // Mac の濃点(NFD)も NFC にそろえる
  if (!p || p.length > 120 || p.endsWith('/')) throw fail(400, `ファイル名が正しくありません: ${p}`);
  const segs = p.split('/');
  if (segs.length > 6) throw fail(400, `${p}: フォルダが深すぎます(6階層まで)`);
  for (const s of segs) {
    if (!segOk(s)) throw fail(400, `${p}: 使えない名前です(制御文字や、「.」「..」だけの名前は使えません)`);
  }
  if (!extOf(p)) throw fail(400, `${p}: 拡張子が必要です`);
  return p;
}
const isPrivatePath = (p) => p === 'server.js' || p.startsWith('server/');

function cleanEnvList(list) {
  if (!Array.isArray(list)) throw fail(400, '環境変数の形式が正しくありません');
  if (list.length > MAX_ENV) throw fail(400, `環境変数は${MAX_ENV}個までです`);
  const seen = new Set();
  return list.map((e) => {
    const key = String((e && e.key) || '').trim();
    const value = String((e && e.value) == null ? '' : e.value);
    if (!ENV_KEY_RE.test(key)) throw fail(400, `名前が正しくありません: 「${key}」(英数字と _ だけ、数字で始められません)`);
    if (ENV_RESERVED.test(key)) throw fail(400, `${key} はシステムが使うため登録できません`);
    if (seen.has(key)) throw fail(400, `${key} が重複しています`);
    if (value.length > 4000) throw fail(400, `${key} の値が長すぎます(4000文字まで)`);
    seen.add(key);
    return { key, value };
  });
}

// ======================================================================
// GAKU acct の本人確認
// ======================================================================
function gakuUrls() {
  const out = [GAKU_URL];
  const m = GAKU_URL.match(/^(https:\/\/script\.google\.com)\/a\/macros\/[^/]+\/(s\/[^/]+\/exec)/);
  if (m) out.push(`${m[1]}/macros/${m[2]}`);
  return out;
}

async function verifyGaku(code) {
  for (const base of gakuUrls()) {
    let text;
    try {
      const r = await fetch(base + (base.includes('?') ? '&' : '?') + 'verify=' + code, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
      text = await r.text();
    } catch { continue; }
    let j;
    try { j = JSON.parse(text); } catch { continue; } // JSON でなければ次の URL を試す(確認コードは消費されない)
    if (!j || !j.ok) throw fail(401, (j && j.message) || 'GAKU acct の確認に失敗しました。もう一度ログインしてください');
    return j;
  }
  throw fail(502, 'GAKU acct の確認サーバーに接続できませんでした。管理者は、ウェブアプリのアクセス権を「全員」にしてあるか確認してください');
}

// ======================================================================
// サーバー機能: 隔離したプロセスで server.js を実行
// ======================================================================
const PERM_FLAG = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission'
  : process.allowedNodeEnvironmentFlags.has('--experimental-permission') ? '--experimental-permission' : null;
const MAX_ACTIVE = 4;
let active = 0;

// 子プロセスの中で動く本体。fs・子プロセス・Worker・バインディングは --permission で禁止される。
function runnerMain() {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', async () => {
    const logs = [];
    const util = require('util');
    const cap = (...a) => { if (logs.length < 100) logs.push(a.map((x) => (typeof x === 'string' ? x : util.inspect(x, { depth: 3, breakLength: 120 }))).join(' ').slice(0, 2000)); };
    console.log = console.info = console.debug = cap;
    console.warn = console.error = (...a) => cap('[warn]', ...a);
    const done = (o) => { o.logs = logs; process.stdout.write('\n@@SITBANK@@' + JSON.stringify(o) + '\n', () => process.exit(0)); };
    const lower = (h) => { const r = {}; for (const k of Object.keys(h || {})) r[k.toLowerCase()] = String(h[k]); return r; };
    const JSONCT = 'application/json; charset=utf-8';
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const files = input.files;
      const vm = require('vm');
      const ALLOWED = ['crypto', 'url', 'querystring', 'util', 'buffer', 'path', 'zlib', 'events', 'string_decoder', 'assert', 'assert/strict', 'stream', 'stream/promises', 'stream/web', 'timers', 'timers/promises',
        'http', 'https', 'http2', 'net', 'tls', 'dns', 'dns/promises', 'os', 'async_hooks', 'perf_hooks', 'punycode', 'constants', 'util/types', 'diagnostics_channel', 'process', 'console', 'fs', 'fs/promises'];

      // ---- fs: プロジェクトの server.js / server/ の中身を読める「仮のファイル置き場」。書き込みはこの1回の実行の間だけ有効 ----
      const mem = Object.create(null);
      const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
      const fsKey = (p) => {
        if (p && typeof p === 'object' && p.pathname) p = decodeURIComponent(p.pathname);
        const parts = [];
        for (const seg of String(p).split('/')) { if (seg === '' || seg === '.') continue; if (seg === '..') parts.pop(); else parts.push(seg); }
        return parts.join('/');
      };
      const enoent = (p, sys) => Object.assign(new Error("ENOENT: no such file or directory, " + sys + " '" + p + "'"), { code: 'ENOENT', errno: -2, syscall: sys, path: String(p) });
      const fileGet = (k) => (has(mem, k) ? mem[k] : has(files, k) ? files[k] : undefined); // undefined=無い / null=消した
      const allKeys = () => { const s = new Set(Object.keys(files)); for (const k of Object.keys(mem)) { if (mem[k] === null) s.delete(k); else s.add(k); } return [...s].filter((k) => fileGet(k) != null); };
      const isDir = (k) => k === '' || allKeys().some((f) => f.startsWith(k + '/'));
      const mkStat = (k) => {
        const f = fileGet(k), d = f == null && isDir(k);
        if (f == null && !d) return null;
        const size = f == null ? 0 : Buffer.byteLength(f);
        return { size, mtimeMs: 0, mtime: new Date(0), isFile: () => f != null, isDirectory: () => d, isSymbolicLink: () => false };
      };
      const fsSync = {
        readFileSync(p, o) { const k = fsKey(p), f = fileGet(k); if (f == null) throw enoent(p, 'open'); const enc = typeof o === 'string' ? o : o && o.encoding; return enc ? f : Buffer.from(f); },
        existsSync(p) { return !!mkStat(fsKey(p)); },
        statSync(p, o) { const st = mkStat(fsKey(p)); if (!st) { if (o && o.throwIfNoEntry === false) return undefined; throw enoent(p, 'stat'); } return st; },
        readdirSync(p) {
          const k = fsKey(p), pre = k ? k + '/' : '';
          if (!isDir(k)) throw enoent(p, 'scandir');
          return [...new Set(allKeys().filter((f) => f.startsWith(pre)).map((f) => f.slice(pre.length).split('/')[0]))].sort();
        },
        writeFileSync(p, d) { mem[fsKey(p)] = Buffer.isBuffer(d) || ArrayBuffer.isView(d) ? Buffer.from(d.buffer, d.byteOffset, d.byteLength).toString('utf8') : String(d); },
        appendFileSync(p, d) { const k = fsKey(p); mem[k] = (fileGet(k) || '') + String(d); },
        mkdirSync() { return undefined; },
        unlinkSync(p) { const k = fsKey(p); if (fileGet(k) == null) throw enoent(p, 'unlink'); mem[k] = null; },
        rmSync(p, o) { const k = fsKey(p); if (fileGet(k) == null) { if (o && o.force) return; throw enoent(p, 'rm'); } mem[k] = null; },
      };
      fsSync.lstatSync = fsSync.statSync; fsSync.accessSync = (p) => { if (!fsSync.existsSync(p)) throw enoent(p, 'access'); };
      fsSync.realpathSync = (p) => '/' + fsKey(p);
      const fsMod = { ...fsSync, constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 }, promises: {} };
      for (const n of Object.keys(fsSync)) {
        if (n === 'existsSync') continue;
        const base = n.replace(/Sync$/, '');
        fsMod.promises[base] = async (...a) => fsSync[n](...a);
        fsMod[base] = (...a) => { const cb = a.pop(); let r, e = null; try { r = fsSync[n](...a); } catch (x) { e = x; } process.nextTick(() => (e ? cb(e) : cb(null, r))); };
      }
      fsMod.exists = (p, cb) => process.nextTick(() => cb(fsSync.existsSync(p)));
      const builtin = (name) => (name === 'fs' ? fsMod : name === 'fs/promises' ? fsMod.promises : require(name));
      const builtinName = (spec) => { const n = String(spec).replace(/^node:/, ''); return ALLOWED.includes(n) ? n : null; };
      const isEsm = (f, src) => f.endsWith('.mjs') || /^\s*(import\s*[\w{*"'$]|export\s+(default|const|let|var|function|class|async|\{|\*))/m.test(src);
      const esmCache = Object.create(null);
      const loadEsm = async (file) => {
        if (esmCache[file]) return esmCache[file];
        const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
        const m = new vm.SourceTextModule(files[file], { identifier: file });
        esmCache[file] = m;
        await m.link(async (spec) => {
          spec = String(spec);
          if (spec.startsWith('./') || spec.startsWith('../')) {
            const r = resolveFile(dir, spec);
            if (!r) throw new Error('モジュールが見つかりません: ' + spec + '(server/ フォルダ内のファイルだけ読み込めます)');
            if (r.endsWith('.json')) {
              const v = JSON.parse(files[r]);
              const sm = new vm.SyntheticModule(['default'], function () { this.setExport('default', v); });
              await sm.link(() => {}); return sm;
            }
            if (!isEsm(r, files[r])) {
              const v = load(r);
              const names = v && typeof v === 'object' ? Object.keys(v).filter((k) => k !== 'default') : [];
              const sm = new vm.SyntheticModule(['default', ...names], function () { this.setExport('default', v); for (const k of names) this.setExport(k, v[k]); });
              await sm.link(() => {}); return sm;
            }
            return loadEsm(r);
          }
          const name = builtinName(spec);
          if (!name) throw new Error('"' + spec + '" は使えません。使える標準モジュール: ' + ALLOWED.join(', ') + '(npm のパッケージは使えません)');
          const v = builtin(name);
          const names = Object.keys(v).filter((k) => k !== 'default');
          const sm = new vm.SyntheticModule(['default', ...names], function () { this.setExport('default', v); for (const k of names) this.setExport(k, v[k]); });
          await sm.link(() => {}); return sm;
        });
        await m.evaluate();
        return m;
      };
      const cache = Object.create(null);
      const resolveFile = (dir, spec) => {
        const parts = dir ? dir.split('/') : [];
        for (const seg of spec.split('/')) {
          if (seg === '' || seg === '.') continue;
          if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
        }
        const base = parts.join('/');
        for (const c of [base, base + '.js', base + '.mjs', base + '.cjs', base + '.json', base + '/index.js', base + '/index.mjs']) {
          if (Object.prototype.hasOwnProperty.call(files, c)) return c;
        }
        return null;
      };
      const load = (file) => {
        if (cache[file]) return cache[file].exports;
        const m = { exports: {} };
        cache[file] = m;
        if (file.endsWith('.json')) { m.exports = JSON.parse(files[file]); return m.exports; }
        const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
        const req = (spec) => {
          spec = String(spec);
          if (spec.startsWith('./') || spec.startsWith('../')) {
            const r = resolveFile(dir, spec);
            if (!r) throw new Error('モジュールが見つかりません: ' + spec + '(server/ フォルダ内のファイルだけ読み込めます)');
            return load(r);
          }
          const name = builtinName(spec);
          if (name) return builtin(name);
          throw new Error('"' + spec + '" は使えません。使える標準モジュール: ' + ALLOWED.join(', ') + '(npm のパッケージは使えません)');
        };
        const fn = vm.runInThisContext('(function (exports, require, module, __filename, __dirname) {' + files[file] + '\n})', { filename: file });
        fn.call(m.exports, m.exports, req, m, file, dir);
        return m.exports;
      };

      if (!has(files, 'server.js')) throw new Error('server.js がありません');
      const mod = isEsm('server.js', files['server.js']) ? (await loadEsm('server.js')).namespace : load('server.js');
      const R = input.req;
      let handler = typeof mod === 'function' ? mod : null;
      if (!handler && mod) {
        if (typeof mod.default === 'function') handler = mod.default;
        else if (typeof mod.handler === 'function') handler = mod.handler;
        else if (typeof mod[R.method] === 'function') handler = mod[R.method];
        else if (typeof mod[R.method.toLowerCase()] === 'function') handler = mod[R.method.toLowerCase()];
      }
      if (!handler) throw new Error('server.js は関数を module.exports してください(例: module.exports = async (req) => ({ hello: "world" }))');

      let out = null;
      let resolveOut;
      const outP = new Promise((r) => { resolveOut = r; });
      const res = {
        statusCode: 200, headers: {},
        status(c) { this.statusCode = c; return this; },
        set(k, v) { this.headers[String(k).toLowerCase()] = String(v); return this; },
        setHeader(k, v) { return this.set(k, v); },
        header(k, v) { return this.set(k, v); },
        type(t) { return this.set('content-type', t); },
        end(b) {
          const buf = Buffer.isBuffer(b);
          out = { status: this.statusCode, headers: this.headers, body: b == null ? '' : buf ? b.toString('base64') : String(b), b64: buf };
          resolveOut(out); return this;
        },
        json(o) { this.headers['content-type'] = JSONCT; return this.end(JSON.stringify(o)); },
        text(s) { this.headers['content-type'] = 'text/plain; charset=utf-8'; return this.end(String(s)); },
        html(s) { this.headers['content-type'] = 'text/html; charset=utf-8'; return this.end(String(s)); },
        send(b) { return b && typeof b === 'object' && !Buffer.isBuffer(b) ? this.json(b) : this.end(b); },
        redirect(a, b) { const code = typeof a === 'number' ? a : 302; this.headers.location = String(typeof a === 'number' ? b : a); this.statusCode = code; return this.end(''); },
      };
      const normalize = (v) => {
        if (v === null || v === undefined) return { status: 204, headers: {}, body: '' };
        if (typeof v === 'string') return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: v };
        if (Buffer.isBuffer(v)) return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: v.toString('base64'), b64: true };
        if (typeof v === 'object') {
          const keys = Object.keys(v);
          const shape = typeof v.status === 'number' ||
            (keys.length > 0 && keys.every((k) => ['status', 'headers', 'json', 'html', 'text', 'body'].includes(k)) && ('json' in v || 'html' in v || 'text' in v || 'body' in v));
          if (shape) {
            const headers = lower(v.headers);
            let body = '', b64 = false;
            if ('json' in v) { body = JSON.stringify(v.json); headers['content-type'] = headers['content-type'] || JSONCT; }
            else if ('html' in v) { body = String(v.html); headers['content-type'] = headers['content-type'] || 'text/html; charset=utf-8'; }
            else if ('text' in v) { body = String(v.text); headers['content-type'] = headers['content-type'] || 'text/plain; charset=utf-8'; }
            else if ('body' in v) {
              const b = v.body;
              if (Buffer.isBuffer(b)) { body = b.toString('base64'); b64 = true; }
              else if (b && typeof b === 'object') { body = JSON.stringify(b); headers['content-type'] = headers['content-type'] || JSONCT; }
              else { body = b == null ? '' : String(b); headers['content-type'] = headers['content-type'] || 'text/plain; charset=utf-8'; }
            }
            return { status: typeof v.status === 'number' ? v.status : 200, headers, body, b64 };
          }
        }
        return { status: 200, headers: { 'content-type': JSONCT }, body: JSON.stringify(v) };
      };

      const ret = await handler(R, res);
      done(ret === undefined && !out ? await outP : out || normalize(ret));
    } catch (e) {
      done({ status: 500, headers: {}, body: '', error: String((e && e.message) || e).slice(0, 500), stack: String((e && e.stack) || '').split('\n').slice(0, 6).join('\n') });
    }
  });
}
const RUNNER_SRC = '(' + runnerMain.toString() + ')()';

function runServerCode({ files, env, req, timeoutMs }) {
  return new Promise((resolve) => {
    if (!PERM_FLAG) return resolve({ status: 503, error: 'このサーバーの Node.js はサーバー機能に対応していません(Node 22 以上が必要です)' });
    if (active >= MAX_ACTIVE) return resolve({ status: 503, error: 'いまサーバーが混み合っています。少し待ってからもう一度お試しください' });
    active++;
    const t0 = Date.now();
    const childEnv = { SITBANK: '1' };
    for (const [k, v] of Object.entries(env)) if (ENV_KEY_RE.test(k) && !ENV_RESERVED.test(k)) childEnv[k] = String(v);
    let child;
    try {
      child = spawn(process.execPath, [PERM_FLAG, '--experimental-vm-modules', '--no-warnings', '--max-old-space-size=128', '-e', RUNNER_SRC], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      active--;
      return resolve({ status: 500, error: '実行を開始できませんでした: ' + e.message });
    }
    let out = Buffer.alloc(0), err = '', killed = null, finished = false;
    const finish = (r) => { if (finished) return; finished = true; clearTimeout(timer); active--; resolve({ ms: Date.now() - t0, ...r }); };
    const timer = setTimeout(() => { killed = 'timeout'; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { out = Buffer.concat([out, d]); if (out.length > 3 * 1024 * 1024) { killed = 'size'; child.kill('SIGKILL'); } });
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d.toString(); });
    child.on('error', (e) => finish({ status: 500, error: '実行できませんでした: ' + e.message }));
    child.on('close', () => {
      if (killed === 'timeout') return finish({ status: 504, error: `${Math.round(timeoutMs / 1000)}秒以内に応答しませんでした(時間切れ)` });
      if (killed === 'size') return finish({ status: 500, error: '応答が大きすぎます(3MBまで)' });
      const s = out.toString('utf8');
      const i = s.lastIndexOf('@@SITBANK@@');
      if (i < 0) return finish({ status: 500, error: (err.trim().split('\n').filter(Boolean).slice(-2).join(' ') || 'プログラムが途中で終了しました').slice(0, 300) });
      try {
        const o = JSON.parse(s.slice(i + 11));
        finish({ status: o.error ? 500 : o.status, headers: o.headers || {}, body: o.body || '', b64: !!o.b64, logs: o.logs || [], error: o.error, stack: o.stack });
      } catch { finish({ status: 500, error: '応答を読み取れませんでした' }); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ files, req }));
  });
}

// ======================================================================
// デプロイ処理
// ======================================================================
function makeTicket(o) { const body = b64u(JSON.stringify(o)); return body + '.' + hmac(body); }
function readTicket(t, pid) {
  try {
    const [body, sig] = String(t).split('.');
    if (!body || !sig || !safeEq(sig, hmac(body))) return null;
    const o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return o && o.pid === pid && o.exp > Date.now() ? o : null;
  } catch { return null; }
}

async function doDeploy(id, aid, entries) {
  if (!Array.isArray(entries) || !entries.length) throw fail(400, 'ファイルがありません');
  if (entries.length > MAX_FILES) throw fail(400, `ファイルは最大${MAX_FILES}個までです`);

  return withLock('proj:' + id, async () => {
    const meta = await loadProject(id, { fresh: true });
    if (!meta || meta.owner !== aid) throw fail(404, 'プロジェクトが見つかりません');

    const oldIdx = fileIndex(meta);
    let oldPub = null, oldPriv = null;
    const pub = {}, priv = {}, media = {}, manifest = [], seen = new Set();

    for (const e of entries) {
      const p = cleanPath(e && e.path);
      if (seen.has(p)) throw fail(400, `${p} が重複しています`);
      seen.add(p);

      if (e.keep) {
        const old = oldIdx.get(p);
        if (!old) throw fail(400, `${p}: 公開中のファイルが見つかりません`);
        if (old.k === 'm') media[p] = meta.media[p];
        else if (old.k === 'x') { oldPriv = oldPriv || await loadBundle(meta, id, true); priv[p] = oldPriv[p]; }
        else { oldPub = oldPub || await loadBundle(meta, id, false); pub[p] = oldPub[p]; }
        manifest.push(old);
        continue;
      }

      const ext = extOf(p);
      if (e.ticket) {
        const t = readTicket(e.ticket, id);
        if (!t) throw fail(400, `${p}: アップロードの有効期限が切れました。もう一度アップロードしてください`);
        if (!MEDIA[ext]) throw fail(400, `${p}: 画像・動画の拡張子ではありません`);
        media[p] = { id: t.id, url: t.url, type: t.type, size: t.size };
        manifest.push({ p, s: t.size, k: 'm' });
        continue;
      }

      if (MEDIA[ext]) throw fail(400, `${p}: 画像・動画は「アップロード」経由で追加してください`);
      const isText = e.enc === 'utf8';
      if (!isText && e.enc !== 'b64') throw fail(400, `${p}: 中身の形式が正しくありません`);
      if (typeof e.data !== 'string') throw fail(400, `${p}: 中身がありません`);

      if (isPrivatePath(p)) {
        if (!isText || !['js', 'mjs', 'cjs', 'json'].includes(ext)) throw fail(400, `${p}: server.js と server/ フォルダには .js / .mjs / .cjs / .json だけ置けます`);
        priv[p] = ['t', e.data];
        manifest.push({ p, s: Buffer.byteLength(e.data), k: 'x' });
      } else {
        if (!TEXT_EXT.has(ext) && !BIN_EXT.has(ext)) throw fail(400, `${p}: この種類のファイルは公開できません(.${ext})`);
        if (isText) {
          if (!TEXT_EXT.has(ext)) throw fail(400, `${p}: 文字ファイルではありません`);
          pub[p] = ['t', e.data];
          manifest.push({ p, s: Buffer.byteLength(e.data), k: 't' });
        } else {
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(e.data)) throw fail(400, `${p}: データが壊れています`);
          pub[p] = ['b', e.data];
          manifest.push({ p, s: Math.floor(e.data.length * 3 / 4), k: 'b' });
        }
      }
    }

    if (Object.keys(media).length > MAX_MEDIA) throw fail(400, `画像・動画は最大${MAX_MEDIA}個までです`);
    // index.html も server.js も必須ではない(abc.html だけ、画像だけ、でもデプロイできる)
    if (!manifest.length) throw fail(400, 'ファイルがありません');

    const pubChunks = Object.keys(pub).length ? packPublic(pub) : [];
    const privChunks = Object.keys(priv).length ? packPrivate(priv) : [];
    if (pubChunks.length > MAX_PUB_CHUNKS) throw fail(413, `公開ファイルが大きすぎます(圧縮後 約${Math.round(pubChunks.join('').length * 3 / 4 / 1024)}KB / 上限 約${Math.round(MAX_PUB_CHUNKS * CHUNK_CHARS * 3 / 4 / 1024)}KB)。画像や動画は、.png / .jpg / .mp4 などにするとアップロード方式になり、容量を使いません`);
    if (privChunks.length > MAX_PRIV_CHUNKS) throw fail(413, 'server.js と server/ フォルダが大きすぎます');

    const ver = Date.now().toString(36);
    const writes = [
      ...pubChunks.map((s, i) => [kPub(id, ver, i), s]),
      ...privChunks.map((s, i) => [kPriv(id, ver, i), s]),
    ];
    try {
      await mapLimit(writes, 6, ([k, s]) => putStr(k, s));
      const now = Date.now();
      const next = {
        ...meta, ver, dn: pubChunks.length, sn: privChunks.length, files: manifest, media,
        hasServer: !!priv['server.js'], pend: [], updatedAt: now, deploys: (meta.deploys || 0) + 1,
      };
      await saveProject(id, next);
      // 古いデータの後片付け(失敗しても公開には影響しない)
      const cleanup = [];
      if (meta.ver) {
        for (let i = 0; i < (meta.dn || 0); i++) cleanup.push(delKey(kPub(id, meta.ver, i)));
        for (let i = 0; i < (meta.sn || 0); i++) cleanup.push(delKey(kPriv(id, meta.ver, i)));
      }
      const keepIds = new Set(Object.values(media).map((m) => m.id));
      for (const m of Object.values(meta.media || {})) if (!keepIds.has(m.id)) cleanup.push(delFile(m.id));
      for (const pid of meta.pend || []) if (!keepIds.has(pid)) cleanup.push(delFile(pid));
      await Promise.allSettled(cleanup);
      return next;
    } catch (e) {
      await Promise.allSettled(writes.map(([k]) => delKey(k)));
      throw e;
    }
  });
}

async function deleteProject(id, aid) {
  return withLock('proj:' + id, async () => {
    const meta = await loadProject(id, { fresh: true });
    if (!meta || meta.owner !== aid) throw fail(404, 'プロジェクトが見つかりません');
    const jobs = [];
    if (meta.ver) {
      for (let i = 0; i < (meta.dn || 0); i++) jobs.push(delKey(kPub(id, meta.ver, i)));
      for (let i = 0; i < (meta.sn || 0); i++) jobs.push(delKey(kPriv(id, meta.ver, i)));
    }
    for (const m of Object.values(meta.media || {})) jobs.push(delFile(m.id));
    for (const pid of meta.pend || []) jobs.push(delFile(pid));
    await Promise.all(jobs);
    await delKey(kEnv(id));
    await delKey(kProj(id));
    metaCache.delete(id);
    for (const k of [...bundleCache.keys()]) if (k.split(':')[1] === id) bundleCache.delete(k);
    await withLock('acct:' + aid, async () => {
      const rec = await loadAccount(aid);
      if (rec) { rec.projects = (rec.projects || []).filter((x) => x !== id); await saveAccount(aid, rec); }
    });
  });
}

const summarize = (id, m) => ({
  id, name: m.name, url: siteBase(id), createdAt: m.createdAt, updatedAt: m.updatedAt,
  deployed: !!m.ver, hasServer: !!m.hasServer, fileCount: (m.files || []).length,
});

// ======================================================================
// アプリ
// ======================================================================
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// 公開サイト専用ドメインへのアクセスは、ここで振り分ける(本体の画面・API には触れさせない)
app.use((req, res, next) => {
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  if (SITE_DOMAIN && host.endsWith('.' + SITE_DOMAIN)) {
    const id = host.slice(0, -SITE_DOMAIN.length - 1);
    if (!ID_RE.test(id)) return res.status(404).type('text/plain; charset=utf-8').send('このサイトは見つかりません');
    req.siteOwn = 'sub';
    req.url = `/s/${id}` + (req.url.startsWith('/') ? req.url : '/' + req.url);
    return next();
  }
  if (SITE_HOST && host === SITE_HOST) {
    if (!/^\/s\/[^/?]+/.test(req.url)) return res.status(404).type('text/plain; charset=utf-8').send('404 Not Found');
    req.siteOwn = 'host';
    return next();
  }
  if ((SITE_HOST || SITE_DOMAIN) && /^\/[sf]\/[^/?]+/.test(req.url)) {
    const m = /^\/[sf]\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(req.url);
    let id; try { id = decodeURIComponent(m[1]); } catch { id = ''; }
    if (m && ID_RE.test(id)) {
      const base = siteBase(id).replace(/\/$/, '');
      return res.redirect(req.method === 'GET' || req.method === 'HEAD' ? 302 : 307, base + (m[2] || '/') + (m[3] || ''));
    }
  }
  next();
});

const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

app.get('/', (req, res) => {
  res.set({ 'Cache-Control': 'no-cache', 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' });
  res.type('html').send(indexHtml);
});
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ---------- 管理 API ----------
const api = express.Router();
api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
api.use(express.json({ limit: '4mb' }));

api.get('/config', (req, res) => {
  res.json({
    configured: !!SECRET_KEY,
    siteHost: SITE_HOST, siteDomain: SITE_DOMAIN,
    secureSecret: !!process.env.SITBANK_SECRET,
    serverCode: SERVER_CODE_ENABLED && !!PERM_FLAG,
    serverTimeoutSec: Math.round(SERVER_TIMEOUT_MS / 1000),
    maxMediaBytes: MAX_MEDIA_BYTES,
    maxFiles: MAX_FILES,
    maxProjects: MAX_PROJECTS,
    maxEnv: MAX_ENV,
  });
});

const authMw = mw(async (req) => {
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  const p = m && readToken(m[1]);
  if (!p) throw fail(401, 'ログインが必要です');
  req.aid = p.aid;
});

async function ownProject(req) {
  const id = String(req.params.id || '');
  const meta = await loadProject(id, { fresh: true });
  if (!meta || meta.owner !== req.aid) throw fail(404, 'プロジェクトが見つかりません');
  return { id, meta };
}

// GAKU acct の確認コード → SiTBANK のログイン
api.post('/auth/gaku', wrap(async (req, res) => {
  K();
  rateLimit('auth:' + req.ip, 30, 60000);
  const code = String((req.body && req.body.code) || '');
  if (!/^[0-9a-f]{64}$/.test(code)) throw fail(400, '確認コードが正しくありません');
  const g = await verifyGaku(code);
  if (g.active === false) throw fail(403, 'このアカウントは、いま使えない状態です');
  const cls = String(g.cls || '').trim();
  const no = Number(g.no);
  if (!cls || !Number.isInteger(no)) throw fail(502, 'GAKU acct の返事が正しくありません');
  const name = String(g.name || '').slice(0, 40);
  const company = String(g.company || '').slice(0, 40);
  const aid = accountId(cls, no);

  await withLock('acct:' + aid, async () => {
    const rec = (await loadAccount(aid)) || { projects: [], createdAt: Date.now() };
    Object.assign(rec, { cls, no, name, company, lastLoginAt: Date.now() });
    await saveAccount(aid, rec);
  });
  res.json({ token: signToken({ aid, exp: Date.now() + SESSION_MS }), user: { name, cls, no, company } });
}));

api.get('/me', authMw, wrap(async (req, res) => {
  const rec = await loadAccount(req.aid);
  if (!rec) throw fail(401, 'ログインし直してください');
  const metas = await mapLimit(rec.projects || [], 6, async (id) => [id, await loadProject(id, { fresh: true })]);
  const projects = metas.filter(([, m]) => m && m.owner === req.aid).map(([id, m]) => summarize(id, m));
  res.json({ user: { name: rec.name, cls: rec.cls, no: rec.no, company: rec.company }, projects });
}));

api.post('/projects', authMw, wrap(async (req, res) => {
  const name = cleanName(req.body && req.body.name, 'プロジェクト名');
  let id = String((req.body && req.body.slug) || '').trim().toLowerCase();
  if (id && !ID_RE.test(id)) throw fail(400, 'URL名は、英小文字・数字・ハイフンで3〜30文字にしてください');
  const aid = req.aid;

  const created = await withLock('acct:' + aid, async () => {
    const rec = await loadAccount(aid);
    if (!rec) throw fail(401, 'ログインし直してください');
    if ((rec.projects || []).length >= MAX_PROJECTS) throw fail(400, `プロジェクトは${MAX_PROJECTS}個までです。使わないものを削除してください`);
    if (id) {
      if (await loadProject(id, { fresh: true })) throw fail(409, 'そのURL名はすでに使われています');
    } else {
      for (let i = 0; i < 5; i++) {
        const cand = crypto.randomBytes(4).toString('hex');
        if (!(await loadProject(cand, { fresh: true }))) { id = cand; break; }
      }
      if (!id) throw fail(500, 'URL を決められませんでした。もう一度お試しください');
    }
    const now = Date.now();
    const meta = { name, owner: aid, createdAt: now, updatedAt: now, ver: null, dn: 0, sn: 0, files: [], media: {}, pend: [], hasServer: false };
    await saveProject(id, meta);
    const back = await loadProject(id, { fresh: true }); // 同時に作られていないか確認
    if (!back || back.owner !== aid) throw fail(409, 'そのURL名はすでに使われています');
    rec.projects = [...(rec.projects || []), id];
    await saveAccount(aid, rec);
    return { id, meta };
  });
  res.status(201).json(summarize(created.id, created.meta));
}));

api.get('/projects/:id', authMw, wrap(async (req, res) => {
  const { id, meta } = await ownProject(req);
  const files = (meta.files || []).map((f) => (f.k === 'm' && meta.media[f.p] ? { ...f, u: SB_ORIGIN + meta.media[f.p].url } : f));
  res.json({ ...summarize(id, meta), files, version: meta.ver, deploys: meta.deploys || 0 });
}));

api.put('/projects/:id', authMw, wrap(async (req, res) => {
  const { id } = await ownProject(req);
  const name = cleanName(req.body && req.body.name, 'プロジェクト名');
  const out = await withLock('proj:' + id, async () => {
    const meta = await loadProject(id, { fresh: true });
    if (!meta || meta.owner !== req.aid) throw fail(404, 'プロジェクトが見つかりません');
    meta.name = name;
    await saveProject(id, meta);
    return meta;
  });
  res.json(summarize(id, out));
}));

api.delete('/projects/:id', authMw, wrap(async (req, res) => {
  const { id } = await ownProject(req);
  await deleteProject(id, req.aid);
  res.json({ ok: true });
}));

// 画像・動画のアップロード(中身そのものを送る)
api.post('/projects/:id/media', authMw,
  express.raw({ type: () => true, limit: MAX_MEDIA_BYTES }),
  wrap(async (req, res) => {
    const { id } = await ownProject(req);
    let p;
    try { p = cleanPath(decodeURIComponent(req.get('x-site-path') || '')); } catch (e) { throw e.status ? e : fail(400, 'ファイル名が正しくありません'); }
    const type = MEDIA[extOf(p)];
    if (!type) throw fail(415, '対応していない種類です(PNG / JPEG / GIF / WebP / AVIF / MP4 / MOV / WebM)');
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) throw fail(400, 'ファイルが空です');
    if (buf.length > MAX_MEDIA_BYTES) throw fail(413, `ファイルが大きすぎます(${Math.round(MAX_MEDIA_BYTES / 1048576)}MBまで)`);

    const meta0 = await loadProject(id, { fresh: true });
    if ((meta0.pend || []).length >= 40) throw fail(429, 'アップロードだけで使っていないファイルが多すぎます。いちどデプロイしてください');

    const r = await sbReq('POST', '/files', { body: buf, headers: { 'X-File-Name': encodeURIComponent(p.split('/').pop()), 'Content-Type': type }, timeout: 60000 });
    if (r.status !== 201 && r.status !== 200) throw sbError(r);
    const f = r.json;
    if (!f || !f.id || !f.url) throw fail(502, 'SerBANK の返事が正しくありません');

    await withLock('proj:' + id, async () => {
      const m = await loadProject(id, { fresh: true });
      m.pend = [...(m.pend || []), f.id];
      await saveProject(id, m);
    });
    res.json({ ticket: makeTicket({ pid: id, id: f.id, url: f.url, type, size: buf.length, exp: Date.now() + 3600e3 }), url: SB_ORIGIN + f.url, size: buf.length });
  }));

api.post('/projects/:id/deploy', authMw, wrap(async (req, res) => {
  const { id } = await ownProject(req);
  rateLimit('deploy:' + req.aid, 30, 60000);
  const meta = await doDeploy(id, req.aid, req.body && req.body.entries);
  res.json({ ok: true, ...summarize(id, meta), version: meta.ver });
}));

// 公開中のファイルの中身(編集用)
api.get('/projects/:id/file', authMw, wrap(async (req, res) => {
  const { id, meta } = await ownProject(req);
  const p = cleanPath(String(req.query.path || ''));
  const f = fileIndex(meta).get(p);
  if (!f) throw fail(404, 'ファイルが見つかりません');
  if (f.k === 'm') return res.json({ kind: 'media', url: SB_ORIGIN + meta.media[p].url });
  const map = await loadBundle(meta, id, f.k === 'x');
  const e = map[p];
  if (!e) throw fail(404, 'ファイルが見つかりません');
  if (e[0] === 'b') return res.json({ kind: 'binary' });
  res.json({ kind: 'text', content: e[1] });
}));

// 環境変数(Render の Environment のように)
api.get('/projects/:id/env', authMw, wrap(async (req, res) => {
  const { id } = await ownProject(req);
  res.json({ vars: await loadEnv(id) });
}));
api.put('/projects/:id/env', authMw, wrap(async (req, res) => {
  const { id } = await ownProject(req);
  const vars = cleanEnvList(req.body && req.body.vars);
  await putStr(kEnv(id), encrypt(JSON.stringify(vars)));
  res.json({ vars });
}));

// server.js の試し実行(結果とログは持ち主にだけ見える)
api.post('/projects/:id/server-test', authMw, wrap(async (req, res) => {
  const { id, meta } = await ownProject(req);
  rateLimit('test:' + req.aid, 60, 60000);
  if (!SERVER_CODE_ENABLED) throw fail(503, 'このSiTBANKではサーバー機能がオフになっています');
  if (!meta.hasServer) throw fail(400, 'server.js がまだデプロイされていません');
  const b = req.body || {};
  const method = String(b.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw fail(400, 'メソッドが正しくありません');
  let p = String(b.path || '/api/').trim();
  if (!p.startsWith('/')) p = '/' + p;
  const u = new URL(p, 'http://x');
  const bodyText = String(b.body || '');
  let body = bodyText;
  try { body = JSON.parse(bodyText); } catch { /* 文字列のまま */ }
  const files = await loadBundle(meta, id, true);
  const privFiles = {};
  for (const [k, v] of Object.entries(files)) privFiles[k] = v[1];
  const env = await loadEnv(id);
  const r = await runServerCode({
    files: privFiles, timeoutMs: SERVER_TIMEOUT_MS,
    env: Object.fromEntries(env.map((e) => [e.key, e.value])),
    req: { method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: { 'content-type': 'application/json' }, body, text: bodyText },
  });
  res.json({
    status: r.status, ms: r.ms, headers: r.headers || {}, logs: r.logs || [], error: r.error || null, stack: r.stack || null,
    body: r.b64 ? '(バイナリ)' : String(r.body || '').slice(0, 20000),
  });
}));

app.use('/api', api);

// ---------- 公開サイトの配信 ----------
const SITE_SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation';
function siteHeaders(res, own) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // 公開サイトが SiTBANK 本体(ログイン情報)に触れないよう、必ず隔離して配信する
    ...(own ? {} : { 'Content-Security-Policy': SITE_SANDBOX }),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, X-Requested-With',
  });
}
const siteText = (res, status, msg) => res.status(status).type('text/plain; charset=utf-8').send(msg);

const bodyParser = express.raw({ type: () => true, limit: '1mb' });

// ---------- localStorage / sessionStorage への対応 ----------
// 公開サイトは隔離(sandbox)されていて、そのままでは localStorage が使えない。
// そこで /s/ では「親ページ(ホスト)」を返し、その中に隔離した本物のサイト(/f/)を iframe で表示する。
// サイト側には小さなスクリプト(shim)を差し込み、localStorage / sessionStorage の代わりを用意する。
// データはホスト側が(サイトごとに別の名前で)ブラウザへ保存するので、SiTBANK 本体のログイン情報には触れない。
function shimMain() {
  var PRE = '__sbstore:', MAX = 1000000;
  var touched = { l: {}, s: {} }, ready = false, timer = 0;
  function cl(o) {
    var m = new Map();
    if (o && typeof o === 'object') for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k) && typeof o[k] === 'string') m.set(k, o[k]);
    return m;
  }
  function obj(m) { var o = {}; m.forEach(function (v, k) { Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }); }); return o; }
  var L = new Map(), S = new Map(), got = false;
  try {
    var n = window.name;
    if (typeof n === 'string' && n.indexOf(PRE) === 0) { var o0 = JSON.parse(n.slice(PRE.length)); L = cl(o0.l); S = cl(o0.s); got = true; window.name = ''; }
  } catch (e) { /* 読めなければ空から始める */ }
  ready = got;
  // 引き継ぎ用の名前(window.name)の中身は、サイト側には見せない
  var nd = Object.getOwnPropertyDescriptor(window, 'name') || {};
  var nameGet = nd.get ? function () { return nd.get.call(window); } : function () { return window.name; };
  var nameSet = nd.set ? function (v) { nd.set.call(window, v); } : function (v) { window.name = v; };
  if (nd.get && nd.set && nd.configurable) {
    try { Object.defineProperty(window, 'name', { get: function () { var v = nameGet(); return typeof v === 'string' && v.indexOf(PRE) === 0 ? '' : v; }, set: function (v) { nameSet(v); }, configurable: true, enumerable: nd.enumerable }); } catch (e) { /* 無視 */ }
  }
  var inFrame = false; try { inFrame = window.parent !== window; } catch (e) { inFrame = false; }
  function post(m) { if (!inFrame) return; m.sb = 1; try { window.parent.postMessage(m, '*'); } catch (e) { /* 親がいない */ } }
  function stash() { try { if (ready) nameSet(PRE + JSON.stringify({ l: obj(L), s: obj(S) })); } catch (e) { /* 無視 */ } }
  function flush() { timer = 0; if (ready) { post({ t: 'set', l: obj(L), s: obj(S) }); stash(); } }
  function changed(kind, k) { touched[kind][k === null ? '\u0000all' : k] = 1; stash(); if (!timer) timer = setTimeout(flush, 30); }
  function size(d) { var t = 0; d.forEach(function (v, k) { t += k.length + v.length; }); return t; }

  function make(d, kind) {
    var methods = {
      getItem: function (k) { k = String(k); return d.has(k) ? d.get(k) : null; },
      setItem: function (k, v) {
        if (arguments.length < 2) throw new TypeError("Failed to execute 'setItem' on 'Storage': 2 arguments required, but only " + arguments.length + ' present.');
        k = String(k); v = String(v);
        var old = d.has(k) ? d.get(k) : null;
        if (old === v) return;
        if (size(d) - (old === null ? 0 : k.length + old.length) + k.length + v.length > MAX) throw new DOMException("Failed to execute 'setItem' on 'Storage': Setting the value of '" + k + "' exceeded the quota.", 'QuotaExceededError');
        d.set(k, v); changed(kind, k);
      },
      removeItem: function (k) { k = String(k); if (!d.has(k)) return; d.delete(k); changed(kind, k); },
      clear: function () { if (!d.size) return; d.clear(); changed(kind, null); },
      key: function (i) { i = Number(i); var ks = Array.from(d.keys()); return i >= 0 && i < ks.length ? ks[i] : null; },
    };
    var t = {};
    try { if (window.Storage && window.Storage.prototype) Object.setPrototypeOf(t, window.Storage.prototype); } catch (e) { /* そのまま */ }
    Object.keys(methods).forEach(function (m) { Object.defineProperty(t, m, { value: methods[m], configurable: true, writable: true, enumerable: false }); });
    Object.defineProperty(t, 'length', { get: function () { return d.size; }, configurable: true, enumerable: false });
    try { Object.defineProperty(t, Symbol.toStringTag, { value: 'Storage', configurable: true }); } catch (e) { /* 無視 */ }
    return new Proxy(t, {
      get: function (tt, p, r) { if (typeof p !== 'string' || p in tt) return Reflect.get(tt, p, r); return d.has(p) ? d.get(p) : undefined; },
      set: function (tt, p, v) { if (typeof p === 'symbol') { tt[p] = v; return true; } methods.setItem(p, v); return true; },
      deleteProperty: function (tt, p) { if (typeof p === 'string') methods.removeItem(p); return true; },
      has: function (tt, p) { return (typeof p === 'string' && d.has(p)) || p in tt; },
      ownKeys: function () { return Array.from(d.keys()); },
      getOwnPropertyDescriptor: function (tt, p) {
        if (typeof p === 'string' && d.has(p)) return { value: d.get(p), writable: true, enumerable: true, configurable: true };
        return undefined;
      },
      defineProperty: function (tt, p, desc) { if (typeof p === 'string' && 'value' in desc) methods.setItem(p, desc.value); return true; },
    });
  }
  var LS = make(L, 'l'), SS = make(S, 's');
  function def(name, val) {
    try { Object.defineProperty(window, name, { get: function () { return val; }, configurable: true, enumerable: true }); } catch (e) { /* 失敗しても動作は続ける */ }
  }
  def('localStorage', LS); def('sessionStorage', SS);

  // 親(ホスト)からの連絡
  function apply(d, kind, snap, fire, area) {
    var nm = cl(snap), ch = [];
    if (fire) {
      nm.forEach(function (v, k) { if (!d.has(k) || d.get(k) !== v) ch.push([k, d.has(k) ? d.get(k) : null, v]); });
      d.forEach(function (v, k) { if (!nm.has(k)) ch.push([k, v, null]); });
    }
    d.clear(); nm.forEach(function (v, k) { d.set(k, v); });
    ch.forEach(function (c) {
      try {
        var ev = new StorageEvent('storage', { key: c[0], oldValue: c[1], newValue: c[2], url: location.href });
        try { Object.defineProperty(ev, 'storageArea', { value: area }); } catch (e) { /* 無視 */ }
        window.dispatchEvent(ev);
      } catch (e) { /* 無視 */ }
    });
  }
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!inFrame || e.source !== window.parent || !m || m.sb !== 1) return;
    if (m.t === 'init' && !ready) {
      [['l', L], ['s', S]].forEach(function (a) {
        var host = cl(m[a[0]]), cur = a[1];
        host.forEach(function (v, k) { if (!touched[a[0]]['\u0000all'] && !touched[a[0]][k] && !cur.has(k)) cur.set(k, v); });
      });
      ready = true; flush();
    } else if (m.t === 'ext' && ready) {
      if (m.l) apply(L, 'l', m.l, true, LS);
    }
  });
  if (!got) post({ t: 'hello' });

  // ページを離れる前に保存し、次のページへ引き継ぐ
  function leave() {
    if (timer) { clearTimeout(timer); flush(); }
    stash();
  }
  window.addEventListener('pagehide', leave);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') leave(); });

  // 今いるページ(アドレス・タイトル)を親へ知らせる
  var nt = 0;
  function nav() { if (nt) return; nt = setTimeout(function () { nt = 0; post({ t: 'nav', u: location.href }); }, 80); }
  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = history[m];
    history[m] = function () { var r = orig.apply(this, arguments); nav(); return r; };
  });
  window.addEventListener('hashchange', nav);
  window.addEventListener('popstate', nav);
  function title() { post({ t: 'title', v: document.title || '' }); }
  document.addEventListener('DOMContentLoaded', function () {
    nav(); title();
    try { var te = document.querySelector('title'); if (te) new MutationObserver(title).observe(te, { childList: true, characterData: true, subtree: true }); } catch (e) { /* 無視 */ }
  });
}
const SHIM_SRC = `(${shimMain.toString()})();`;

function hostMain(C) {
  var PRE = '__sbstore:', MAX = 1000000;
  var KL = 'sbsite:' + C.id, KS = 'sbsess:' + C.id;
  function rd(st, k) {
    try {
      var o = JSON.parse(st.getItem(k) || 'null'), r = {}, n = 0;
      if (o && typeof o === 'object' && !Array.isArray(o)) for (var key in o) if (typeof o[key] === 'string') { n += key.length + o[key].length; if (n <= MAX) r[key] = o[key]; }
      return r;
    } catch (e) { return {}; }
  }
  function wr(st, k, o) { try { st.setItem(k, JSON.stringify(o)); return true; } catch (e) { return false; } }
  function clean(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    var r = {}, n = 0;
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) {
      if (typeof o[k] !== 'string') return null;
      n += k.length + o[k].length; if (n > MAX) return null;
      Object.defineProperty(r, k, { value: o[k], enumerable: true, writable: true, configurable: true });
    }
    return r;
  }
  var L = rd(window.localStorage, KL), S = rd(window.sessionStorage, KS);
  // 名前(=保存データ)と src は、ページに差し込む「前」に決めておく(後からだと引き継がれない)
  var f = document.createElement('iframe');
  f.id = 'f';
  f.title = C.name;
  f.name = PRE + JSON.stringify({ l: L, s: S });
  f.setAttribute('sandbox', C.sandbox);
  f.setAttribute('allow', 'fullscreen; autoplay; clipboard-write; camera; microphone; geolocation');
  f.src = C.src + location.hash;
  document.body.appendChild(f);
  function post(m) { m.sb = 1; try { f.contentWindow.postMessage(m, '*'); } catch (e) { /* まだ無い */ } }
  window.addEventListener('message', function (e) {
    if (e.source !== f.contentWindow) return;
    var d = e.data;
    if (!d || d.sb !== 1) return;
    if (d.t === 'set') {
      var l = clean(d.l), s = clean(d.s);
      if (l) { L = l; wr(window.localStorage, KL, L); }
      if (s) { S = s; wr(window.sessionStorage, KS, S); }
    } else if (d.t === 'hello') {
      post({ t: 'init', l: L, s: S });
    } else if (d.t === 'nav') {
      try {
        var u = new URL(String(d.u));
        if (u.origin === location.origin && u.pathname.indexOf('/f/') === 0) history.replaceState(null, '', '/s/' + u.pathname.slice(3) + u.search + u.hash);
      } catch (x) { /* 無視 */ }
    } else if (d.t === 'title') {
      document.title = String(d.v || '').slice(0, 200) || C.name;
    }
  });
  window.addEventListener('storage', function (e) {
    if (e.storageArea === window.localStorage && e.key === KL) { L = rd(window.localStorage, KL); post({ t: 'ext', l: L }); }
  });
}
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function hostPage(res, meta, id, src) {
  res.set({
    'Cache-Control': 'private, no-cache',
    'Vary': 'Sec-Fetch-Dest',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
  });
  return res.type('html').send(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${escHtml(meta.name)}</title>
<style>html,body{margin:0;height:100%;background:#fff}iframe{position:fixed;inset:0;width:100%;height:100%;border:0;display:block}</style></head>
<body>
<noscript>このサイトの表示には JavaScript が必要です。</noscript>
<script>(${hostMain.toString()})(${jsonForScript({ id, name: meta.name, src, sandbox: SITE_SANDBOX.replace('sandbox ', '') })});</script></body></html>`);
}

function injectShim(html) {
  const tag = `<script>${SHIM_SRC}</script>`;
  const m = /<head(?:\s[^>]*)?>/i.exec(html) || /<html(?:\s[^>]*)?>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
  const d = /^\s*<!doctype[^>]*>/i.exec(html);
  if (d) return html.slice(0, d[0].length) + tag + html.slice(d[0].length);
  return tag + html;
}

for (const P of ['s', 'f']) {
  app.get(`/${P}/:id`, (req, res, next) => {
    if (req.path.endsWith('/')) return next(); // /s/<id>/ はそのまま下の配信へ
    const q = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    res.redirect(302, `/${P}/${encodeURIComponent(req.params.id)}/${q}`);
  });
  app.all(`/${P}/:id/*`, bodyParser, siteMain(P));
}

function siteMain(P) { return wrap(async (req, res) => {
  siteHeaders(res, !!req.siteOwn);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const dest = String(req.get('sec-fetch-dest') || '').toLowerCase();
  // 隔離側(/f/)をアドレスバーで直接開いたら、親ページ側(/s/)へ移す
  if (P === 'f' && dest === 'document' && (req.method === 'GET' || req.method === 'HEAD')) return res.redirect(302, req.originalUrl.replace(/^\/f\//, '/s/'));

  const id = req.params.id;
  const sbase = req.siteOwn === 'sub' ? '' : `/${P}/${encodeURIComponent(id)}`;
  const meta = await loadProject(id);
  if (!meta) return siteText(res, 404, 'このサイトは見つかりません');

  let rel;
  rel = String(req.params[0] || '').normalize('NFC'); // Express がURLの %E3.. を日本語に戻し済み
  if (rel.includes('\0') || rel.split('/').some((s) => s === '..')) return siteText(res, 400, 'Bad Request');
  rel = rel.replace(/^\/+/, '');

  // --- サーバー機能: /api/* は server.js が受け持つ ---
  if (meta.hasServer && /^api(\/|$)/.test(rel)) {
    if (!SERVER_CODE_ENABLED) return siteText(res, 503, 'サーバー機能はオフになっています');
    rateLimit('srv:' + id, 240, 60000);
    const files = await loadBundle(meta, id, true);
    const privFiles = {};
    for (const [k, v] of Object.entries(files)) privFiles[k] = v[1];
    const env = await loadEnv(id);
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const text = raw.toString('utf8');
    const ct = (req.get('content-type') || '').toLowerCase();
    let body = text;
    if (ct.includes('json')) { try { body = JSON.parse(text); } catch { /* 文字列のまま */ } }
    else if (ct.includes('x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(text));
    const headers = { ...req.headers };
    delete headers.cookie;
    const r = await runServerCode({
      files: privFiles, timeoutMs: SERVER_TIMEOUT_MS,
      env: Object.fromEntries(env.map((e) => [e.key, e.value])),
      req: { method: req.method, path: '/' + rel, query: req.query, headers, body, text },
    });
    res.set('Cache-Control', 'no-store');
    if (r.error) return res.status(r.status >= 400 ? r.status : 500).json({ error: r.error });
    const forbid = /^(content-length|transfer-encoding|connection|set-cookie|content-security-policy|x-content-type-options|access-control-allow-origin)$/i;
    for (const [k, v] of Object.entries(r.headers || {})) if (!forbid.test(k)) { try { res.set(k, v); } catch { /* 不正なヘッダーは無視 */ } }
    const code = Number.isInteger(r.status) && r.status >= 200 && r.status <= 599 ? r.status : 200;
    return res.status(code).send(r.b64 ? Buffer.from(r.body, 'base64') : r.body);
  }

  // --- 静的ファイル ---
  if (req.method !== 'GET' && req.method !== 'HEAD') return siteText(res, 405, 'Method Not Allowed');
  if (!meta.ver) return siteText(res, 404, 'このプロジェクトは、まだデプロイされていません');

  const idx = fileIndex(meta);
  const cands = (rel === '' || rel.endsWith('/')) ? [rel + 'index.html'] : [rel, rel + '.html', rel + '/index.html'];
  let hit = null;
  for (const c of cands) { const f = idx.get(c); if (f && f.k !== 'x') { hit = f; break; } }

  // トップに index.html が無いとき: HTML が1つならそれを、複数なら一覧ページを出す
  if (!hit && rel === '') {
    const pages = [...idx.values()].filter((f) => f.k === 't' && /\.html?$/i.test(f.p) && f.p !== '404.html').sort((a, b) => a.p.localeCompare(b.p));
    const href = (p) => p.split('/').map(encodeURIComponent).join('/');
    if (pages.length === 1) {
      if (pages[0].p.includes('/')) return res.redirect(302, `${sbase}/${href(pages[0].p)}`);
      hit = pages[0];
    } else if (pages.length > 1) {
      res.set('Cache-Control', 'no-store');
      return res.type('html').send(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(meta.name)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:-apple-system,"Hiragino Sans","Noto Sans JP",system-ui,sans-serif;background:linear-gradient(135deg,#cfe0ff,#ffd9ec);color:#0c1226}
main{width:min(520px,92vw);padding:28px;border-radius:28px;background:rgba(255,255,255,.55);-webkit-backdrop-filter:blur(24px);backdrop-filter:blur(24px);box-shadow:0 20px 60px rgba(30,60,120,.18)}
h1{margin:0 0 4px;font-size:22px}p{margin:0 0 14px;color:#5b6378;font-size:14px}ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}
a{display:block;padding:12px 16px;border-radius:14px;background:rgba(255,255,255,.7);color:#0a84ff;text-decoration:none;font-weight:600;word-break:break-all}a:hover{background:#fff}</style></head>
<body><main><h1>${escHtml(meta.name)}</h1><p>ページを選んでください</p><ul>${pages.map((f) => `<li><a href="${href(f.p)}">${escHtml(f.p)}</a></li>`).join('')}</ul></main></body></html>`);
    }
  }

  if (!hit) {
    const nf = idx.get('404.html');
    if (nf && nf.k === 't') {
      const pub = await loadBundle(meta, id, false);
      res.set('Cache-Control', 'no-store');
      return res.status(404).type('text/html; charset=utf-8').send(pub['404.html'][1]);
    }
    return siteText(res, 404, '404 Not Found');
  }
  if (hit.p === rel + '/index.html') return res.redirect(302, `${sbase}/${rel.split('/').map(encodeURIComponent).join('/')}/`);

  if (hit.k === 'm') {
    res.set('Cache-Control', 'public, max-age=60');
    return res.redirect(302, SB_ORIGIN + meta.media[hit.p].url);
  }

  // HTML は「親ページ(host)」「shim入り(shim)」「そのまま(raw)」のどれかで返す
  let mode = 'raw';
  if (!req.siteOwn && hit.k === 't' && /\.html?$/i.test(hit.p)) {
    if (P === 's') mode = (dest === '' || dest === 'document') ? 'host' : (dest === 'iframe' || dest === 'frame') ? 'shim' : 'raw';
    else mode = (dest === '' || dest === 'iframe' || dest === 'frame') ? 'shim' : 'raw';
  }
  if (mode === 'host') return hostPage(res, meta, id, req.originalUrl.replace(/^\/s\//, '/f/'));

  const etag = `W/"${meta.ver}-${sha1(hit.p).slice(0, 8)}${mode === 'shim' ? 's' : ''}"`;
  res.set({ ETag: etag, 'Cache-Control': mode === 'raw' && !/\.html?$/i.test(hit.p) ? 'public, max-age=0, s-maxage=5, stale-while-revalidate=30' : 'private, no-cache', Vary: 'Sec-Fetch-Dest' });
  if (req.get('if-none-match') === etag) return res.status(304).end();

  const pub = await loadBundle(meta, id, false);
  const e = pub[hit.p];
  if (!e) return siteText(res, 404, '404 Not Found');
  const ext = extOf(hit.p);
  const mime = MIME[ext] || 'application/octet-stream';
  res.type(e[0] === 't' ? `${mime}; charset=utf-8` : mime);
  if (mode === 'shim') return res.send(injectShim(e[1]));
  return res.send(e[0] === 't' ? e[1] : Buffer.from(e[1], 'base64'));
}); }

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: '見つかりません' });
  res.status(404).type('text/plain; charset=utf-8').send('404 Not Found');
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON の形式が正しくありません' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'データが大きすぎます' });
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status === 500) console.error(err);
  if (req.path.startsWith('/s/')) return res.status(status).type('text/plain; charset=utf-8').send(err.message || 'Server Error');
  res.status(status).json({ error: err.message || 'サーバーエラー' });
});

module.exports = app;

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`SiTBANK: http://localhost:${port}`));
}
