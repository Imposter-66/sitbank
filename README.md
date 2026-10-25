# SiTBANK

**GAKU acct でログイン → プロジェクトを作る → ファイルをドロップ → デプロイ。**
HTML・JS・画像・動画はもちろん、`server.js`(サーバー)と環境変数にも対応した、Vercel / Render のような公開サービスです。

作った会社: **KAZUTBANK**

```
ブラウザ ──▶ SiTBANK (Vercel の server.js / Express) ──▶ SerBANK (データの保存先)
   │              │
   │              ├─ ログイン確認 ──▶ GAKU acct (Google Apps Script) の ?verify=確認コード
   │              └─ server.js を隔離したプロセスで実行 (/s/<ID>/api/*)
   └─ 公開サイト: https://あなたのドメイン/s/<プロジェクトID>/
```

## 構成

| ファイル | 役割 |
| --- | --- |
| `index.html` | 画面(ガラスデザイン)。ログイン / ホーム / プロジェクト(ファイル・環境変数・サーバー・設定) |
| `server.js` | API、ログイン確認、デプロイ、公開サイトの配信、`server.js` の実行 |
| `package.json` | 依存関係(`express`)と Node のバージョン(22.x) |
| `README.md` | このファイル |

---

## 使い方(画面)

1. **ログイン** … 画面の GAKU acct 枠に、クラス・出席番号・パスワード(4けた)を入れます。
2. **ホーム** … 「新しいプロジェクト」で、名前と URL 名(例: `my-site`)を決めます。
3. **ファイルをドロップ** … ファイルでもフォルダでも OK。**ファイル名は自由**です(`abc.html` でも `about.html` でも)。
   迷ったら「サンプルを入れてみる」を押すと、`index.html` と `server.js` が入ります。
4. **デプロイ** … 下の「デプロイ」を押すと `https://あなたのドメイン/s/my-site/` で公開されます。
   ファイルの編集(✏️)・削除(🗑)もでき、変更した分だけが反映されます。
5. **環境変数** … `server.js` から `process.env.名前` で読める値を設定します(Render の Environment と同じ使い方)。
6. **サーバー** … `server.js` の状態確認と、試し実行(エラーやログは持ち主にだけ見えます)。

---

## 公開するときの準備

### 1. サーバー側の環境変数(Vercel の Environment Variables)

| 名前 | 必須 | 内容 |
| --- | --- | --- |
| `SERBANK_SECRET_KEY` | ✅ | SerBANK の **Secret キー**(`sk_...`)。絶対に公開しないでください |
| `SITBANK_SECRET` | 推奨 | ログインの署名と、環境変数・アカウントの暗号化に使う長い合言葉(32文字以上のランダムな文字列)。未設定だと `SERBANK_SECRET_KEY` で代用しますが、キーを変えると全員ログインし直し・保存済みの環境変数が読めなくなります |
| `GAKU_ACCT_URL` | 任意 | GAKU acct のウェブアプリ URL(`.../exec`)。未設定ならコードに入っている学校のURL |
| `ENABLE_SERVER_CODE` | 任意 | `0` にすると、サーバー機能(`server.js` の実行)を止めます |
| `SERVER_TIMEOUT_MS` | 任意 | `server.js` の制限時間(初期値 8000 = 8秒) |
| `MAX_MEDIA_BYTES` | 任意 | 画像・動画1つの上限(初期値 4MB。Vercel の本文上限に合わせています) |
| `SERBANK_BASE_URL` | 任意 | SerBANK のベースURL(テスト用。初期値は仕様のURL) |

Public キー(`pk_...`)はコードに入っています(読み取り専用なので公開して問題ありません)。

### 2. GAKU acct 側の条件

SiTBANK のサーバーは、ログインのたびに `GAKU acct のウェブアプリURL?verify=確認コード` を呼んで本人確認をします。

- ウェブアプリの **アクセスできるユーザーが「全員」** になっている必要があります
  (「学校のアカウントだけ」だと、サーバーからの確認が Google のログイン画面で止まります)。
- 確認コードは **5分間・1回だけ** 有効です(GAKU acct 側の仕様)。
- 確認に成功すると、クラス・出席番号・名前が分かり、その人専用のアカウントができます。
  ステータスが「有効」でないアカウントは入れません。

### 3. GitHub と Vercel

```bash
git init
git add index.html server.js package.json README.md
git commit -m "SiTBANK"
git branch -M main
git remote add origin https://github.com/<ユーザー名>/<リポジトリ名>.git
git push -u origin main
```

[Vercel](https://vercel.com) で **Add New → Project** からこのリポジトリを Import し、上の環境変数を入れて **Deploy** します。

`server.js` が自動で認識されない、または `server.js`(サーバー機能)の実行が10秒で切れる場合は、
プロジェクト直下に `vercel.json` を足してください。

```json
{
  "functions": { "server.js": { "maxDuration": 60, "includeFiles": "index.html" } }
}
```

ローカルで試すとき:

```bash
npm install
export SERBANK_SECRET_KEY="sk_ここにSecretキー"
export SITBANK_SECRET="長いランダムな文字列"
npm start      # → http://localhost:3000
```

---

## デプロイしたサイトの作り方

### 公開される場所

| 置いたファイル | 公開URL |
| --- | --- |
| `index.html` | `/s/<ID>/`(トップページ) |
| `index.html` が無いとき | HTML が1つならそれがトップに / 複数なら「ページ一覧」が開く(例: `abc.html` だけなら `/s/<ID>/` で `abc.html` が開く) |
| `css/style.css` | `/s/<ID>/css/style.css` |
| `about.html` | `/s/<ID>/about` または `/s/<ID>/about.html` |
| `ページ/ホーム.html` | `/s/<ID>/ページ/ホーム` (ブラウザでは日本語のまま表示されます) |
| `404.html` | 見つからないときに表示 |
| 画像・動画(png jpg gif webp avif mp4 mov webm) | SerBANK に保存され、`/s/<ID>/画像のパス` から表示 |
| `server.js` と `server/` の中 | **公開されません**(サーバー用) |

ファイル名・フォルダ名は **自由** です。世界中の言語の文字(日本語の漢字・ひらがな・カタカナ、中国語、韓国語、アラビア語、キリル文字、タイ語など)、数字、**スペース、記号、絵文字**が使えます(例: `私の 写真 (1).html`、`🎉パーティー.html`)。使えないのは `/` と `\`、制御文字、向きを入れ替える見えない文字、名前の先頭・末尾のスペース、先頭のドット(`.env` など)だけです。フォルダは6階層まで、名前は1つ60文字までです。公開URLでは、スペースや記号は自動で変換されて開けます(例: `私の 写真.html` → `/s/ID/私の%20写真`)。

### サーバー(`server.js`)

**サーバーは必須ではありません。** `server.js` が無い(HTML や画像だけの)サイトも、そのままデプロイできます。
決まった名前が必要なのは、サーバーを使うときの `server.js` だけです。

プロジェクトに `server.js` があると、`/s/<ID>/api/...` へのアクセスをそのプログラムが処理します。

```js
// server.js
module.exports = async (req) => {
  // req.method / req.path / req.query / req.headers / req.body
  if (req.path === '/api/hello') {
    return { message: 'こんにちは、' + (req.query.name || 'ゲスト') };   // JSON で返る
  }
  if (req.path === '/api/memo' && req.method === 'POST') {
    const r = await fetch(process.env.SERBANK_BASE_URL + '/data/memo', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.SERBANK_SECRET_KEY },
      body: JSON.stringify({ value: req.body }),
    });
    return { status: r.status, json: { ok: r.ok } };
  }
  return { status: 404, json: { error: 'not found' } };
};
```

- 返し方: オブジェクト → JSON / 文字列 → テキスト / `{ status, headers, json | html | text | body }` / Express 風の `(req, res) => res.json(...)` も使えます。
- ブラウザ側からは `fetch('api/hello')` のように、**相対パス**で呼べます(CORS は許可済み)。
- `server/` フォルダの中のファイルは `require('./server/lib.js')` で読み込めます。
- 使える標準モジュール: `crypto url querystring util buffer path zlib events string_decoder assert stream timers`。通信は `fetch` が使えます。
- ファイルの読み書き・他のプログラムの起動・`npm` のパッケージはできません。
- `console.log` は、画面の「サーバー → 試してみる」で持ち主にだけ見えます。

### 環境変数と SerBANK

「環境変数」タブの **かんたん追加 → SerBANK** で、`SERBANK_BASE_URL` / `SERBANK_PUBLIC_KEY` / `SERBANK_SECRET_KEY` の3つが入ります。

- **Secret キーは、必ず環境変数に**入れて `server.js` から使ってください。`index.html` など公開されるファイルには書かないでください。
- ブラウザで動く HTML / JS から SerBANK を使うなら、書いてよいのは **Public キー**だけです。
- 環境変数は暗号化して保存され、保存したらデプロイし直さなくてもすぐ反映されます。

---

## localStorage について

デプロイしたサイトでは **`localStorage` と `sessionStorage` がそのまま使えます**(`setItem` / `getItem` / `localStorage.abc = '…'` / `storage` イベントなど)。

しくみ: 公開サイトは安全のため隔離(sandbox)されており、ブラウザは隔離されたページに本物の `localStorage` を使わせません。そこで SiTBANK は、サイトのURL(`/s/<id>/…`)を開くと **「親ページ」の中に、隔離した本物のサイト(`/f/<id>/…`)を表示**します。サイト側には `localStorage` の代わりになる小さなスクリプトが自動で差し込まれ、保存はサイトごとに別の名前で親ページがブラウザへ行います。SiTBANK 本体のログイン情報とは混ざりません。

- 保存先は **その人のブラウザの中**です(人やパソコンをまたいでは共有されません。共有したいデータは `server.js` + SerBANK へ)。
- 容量は **サイトごとに約1MB**(`localStorage` と `sessionStorage` それぞれ)。超えると、本物と同じく `QuotaExceededError` になります。ブラウザ全体の上限(約5MB)は、他のサイトと共有です。
- `sessionStorage` はタブごとに独立し、リロードしても残ります。別タブでの変更は `storage` イベントで届きます。
- ページ移動(`page2.html` へのリンクなど)をしても、データは引き継がれます。アドレスバーも、いま見ているページに追従します。
- 注意点: ページのURLは `…/s/<id>/…` のまま使えますが、サイトの中から見える `location.href` は `…/f/<id>/…` になります。また、データの引き継ぎのために `window.name` を内部で使うので、サイト側の `window.name` は(ページ間の受け渡しには)使えません。
- `fetch('page.html')` のように、JS から HTML を取得した場合は、差し込みのない元のHTMLが返ります。
- `IndexedDB` / Cookie / `caches` は、隔離のため使えません。

---

## 安全のしくみと、知っておいてほしい限界

- **公開サイトは隔離して配信**します(`Content-Security-Policy: sandbox`)。そのため、公開サイトの JS から SiTBANK 本体のログイン情報には触れません。公開サイト自身の `localStorage` / `sessionStorage` は、下の「localStorage について」のしくみで使えます(Cookie と IndexedDB は使えません)。
- **環境変数・アカウント情報・server.js は暗号化**(AES-256-GCM)して SerBANK に保存します。SerBANK の Public キーは誰でも読めるため、平文では置きません。
- **ログインできるのは GAKU acct のアカウントだけ**です。確認コードは1回限りで、ログインの記録は署名つきトークン(14日)です。
- **`server.js` は別プロセスで実行**し、Node の permission model で「ファイル読み取り・子プロセス・Worker・バインディング」を禁止、環境変数はそのプロジェクトのものだけ、メモリ128MB、制限時間つきです。手元の試験では、`fs` / `child_process` / `process.binding` / `/proc/<親>/environ` はすべて拒否され、親の Secret キーも見えませんでした。
  ただし Node の permission model は「完全な防御」とは公式にも言っていません。**学校の外の不特定多数に開放する場合は、`ENABLE_SERVER_CODE=0` でサーバー機能を止める**ことをおすすめします。
- 使いすぎ防止として、ログイン・デプロイ・サーバー実行には回数制限があります。

---

## SerBANK のデータ配置

| キー | 内容 |
| --- | --- |
| `a_<ハッシュ>` | アカウント(暗号化): クラス・番号・名前・プロジェクト一覧 |
| `p_<ID>` | プロジェクトの情報(名前・持ち主のハッシュ・ファイル一覧・バージョン) |
| `d_<ID>_<ver>_<n>` | 公開ファイル(まとめて圧縮 → 約45KBごとに分割) |
| `s_<ID>_<ver>_<n>` | `server.js` など(圧縮 + 暗号化) |
| `e_<ID>` | 環境変数(暗号化) |
| `/files/...` | 画像・動画(SerBANK のファイル保存) |

1プロジェクトあたり、普通は 3〜5 件しか使いません(SerBANK は全体で 1000 件まで)。

## 制限

- 公開ファイル(文字・小さなバイナリ)は、圧縮後に合計 約 700KB まで。`server.js` 側は約 170KB まで。
- 画像・動画は 1つ 4MB まで・1プロジェクト 30 個まで(`MAX_MEDIA_BYTES` で変更できますが、Vercel の本文上限は 4.5MB です)。
- 1アカウントにつきプロジェクトは 15 個、1プロジェクトのファイルは 150 個、環境変数は 30 個まで。
- 古いバージョンは残しません(デプロイのたびに入れ替わり、巻き戻しはできません)。

## API(画面が使っているもの)

`Authorization: Bearer <トークン>` が必要です(ログインを除く)。

| メソッド | パス | 説明 |
| --- | --- | --- |
| `GET` | `/api/config` | 設定情報 |
| `POST` | `/api/auth/gaku` | `{code}`(GAKU acct の確認コード)→ `{token, user}` |
| `GET` | `/api/me` | 自分とプロジェクト一覧 |
| `POST` | `/api/projects` | 作成 `{name, slug?}` |
| `GET` `PUT` `DELETE` | `/api/projects/:id` | 詳細 / 名前変更 / 削除 |
| `POST` | `/api/projects/:id/media` | 画像・動画をアップロード(本体をそのまま送る。`X-Site-Path` ヘッダー) |
| `POST` | `/api/projects/:id/deploy` | `{entries:[{path, keep:true} \| {path, enc, data} \| {path, ticket}]}` |
| `GET` | `/api/projects/:id/file?path=` | ファイルの中身(編集用) |
| `GET` `PUT` | `/api/projects/:id/env` | 環境変数 |
| `POST` | `/api/projects/:id/server-test` | `server.js` の試し実行 |
| `ALL` | `/s/:id/*` | 公開サイト(`/s/:id/api/*` は `server.js`) |

## 困ったとき

- **ログインで止まる / 「確認サーバーに接続できません」** … GAKU acct のウェブアプリのアクセス権が「全員」か確認。コードを変更したら、新しいバージョンとして再デプロイが必要です。
- **「SERBANK_SECRET_KEY が設定されていません」** … Vercel の Environment Variables を入れたあと、**再デプロイ**が必要です。
- **最初の1回だけ遅い** … SerBANK は Render 上にあり、しばらく使わないと眠ります。少し待つと復活します(SiTBANK は自動で数回やり直します)。
- **「サーバー機能は使えません」と出る** … このサーバーの Node.js が permission model に未対応(Node 22.13 以上が必要)か、`ENABLE_SERVER_CODE=0` になっています。
