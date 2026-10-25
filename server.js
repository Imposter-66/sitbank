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
  p = String(p || '').replace(/^\.?\/+/, '');
  if (!p || p.length > 120 || p.endsWith('/')) throw fail(400, `ファイル名が正しくありません: ${p}`);
  const segs = p.split('/');
  if (segs.length > 6) throw fail(400, `${p}: フォルダが深すぎます(6階層まで)`);
  for (const s of segs) {
    if (s.startsWith('.')) throw fail(400, `${p}: ドットで始まるファイルは使えません(.env などは「環境変数」に入れてください)`);
    if (!/^[A-Za-z0-9._-]{1,60}$/.test(s)) throw fail(400, `${p}: ファイル名は英数字と . _ - だけにしてください`);
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
      const ALLOWED = ['crypto', 'url', 'querystring', 'util', 'buffer', 'path', 'zlib', 'events', 'string_decoder', 'assert', 'stream', 'timers', 'timers/promises'];
      const cache = Object.create(null);
      const resolveFile = (dir, spec) => {
        const parts = dir ? dir.split('/') : [];
        for (const seg of spec.split('/')) {
          if (seg === '' || seg === '.') continue;
          if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
        }
        const base = parts.join('/');
        for (const c of [base, base + '.js', base + '.cjs', base + '.json', base + '/index.js']) {
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
          const name = spec.replace(/^node:/, '');
          if (ALLOWED.includes(name)) return require(name);
          throw new Error('"' + spec + '" は使えません。使える標準モジュール: ' + ALLOWED.join(', ') + '(通信は fetch が使えます)');
        };
        const fn = vm.runInThisContext('(function (exports, require, module, __filename, __dirname) {' + files[file] + '\n})', { filename: file });
        fn.call(m.exports, m.exports, req, m, file, dir);
        return m.exports;
      };

      const mod = load('server.js');
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
      child = spawn(process.execPath, [PERM_FLAG, '--max-old-space-size=128', '-e', RUNNER_SRC], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
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
        if (!isText || !['js', 'cjs', 'json'].includes(ext)) throw fail(400, `${p}: server.js と server/ フォルダには .js / .json だけ置けます`);
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
  id, name: m.name, url: `/s/${id}/`, createdAt: m.createdAt, updatedAt: m.updatedAt,
  deployed: !!m.ver, hasServer: !!m.hasServer, fileCount: (m.files || []).length,
});

// ======================================================================
// アプリ
// ======================================================================
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

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
function siteHeaders(res) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // 公開サイトが SiTBANK 本体(ログイン情報)に触れないよう、必ず隔離して配信する
    'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, X-Requested-With',
  });
}
const siteText = (res, status, msg) => res.status(status).type('text/plain; charset=utf-8').send(msg);

const bodyParser = express.raw({ type: () => true, limit: '1mb' });

app.get('/s/:id', (req, res, next) => {
  if (req.path.endsWith('/')) return next(); // /s/<id>/ はそのまま下の配信へ
  const q = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  res.redirect(302, `/s/${encodeURIComponent(req.params.id)}/${q}`);
});

app.all('/s/:id/*', bodyParser, wrap(async (req, res) => {
  siteHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const id = req.params.id;
  const meta = await loadProject(id);
  if (!meta) return siteText(res, 404, 'このサイトは見つかりません');

  let rel;
  try { rel = decodeURIComponent(req.params[0] || ''); } catch { return siteText(res, 400, 'Bad Request'); }
  if (rel.includes('\0') || rel.includes('\\') || rel.split('/').some((s) => s === '..')) return siteText(res, 400, 'Bad Request');
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
      if (pages[0].p.includes('/')) return res.redirect(302, `/s/${encodeURIComponent(id)}/${href(pages[0].p)}`);
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
  if (hit.p === rel + '/index.html') return res.redirect(302, `/s/${encodeURIComponent(id)}/${rel.split('/').map(encodeURIComponent).join('/')}/`);

  if (hit.k === 'm') {
    res.set('Cache-Control', 'public, max-age=60');
    return res.redirect(302, SB_ORIGIN + meta.media[hit.p].url);
  }

  const etag = `W/"${meta.ver}-${sha1(hit.p).slice(0, 8)}"`;
  res.set({ ETag: etag, 'Cache-Control': 'public, max-age=0, s-maxage=5, stale-while-revalidate=30' });
  if (req.get('if-none-match') === etag) return res.status(304).end();

  const pub = await loadBundle(meta, id, false);
  const e = pub[hit.p];
  if (!e) return siteText(res, 404, '404 Not Found');
  const ext = extOf(hit.p);
  const mime = MIME[ext] || 'application/octet-stream';
  res.type(e[0] === 't' ? `${mime}; charset=utf-8` : mime);
  return res.send(e[0] === 't' ? e[1] : Buffer.from(e[1], 'base64'));
}));

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
