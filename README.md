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
| `SITE_HOST` | 任意(おすすめ) | 公開サイト専用のドメイン(例: `sitbank-sites.vercel.app`)。設定すると、サイトが別ドメインの「ふつうのサイト」として動きます。詳しくは「3.5 公開サイト専用ドメイン」 |
| `SITE_DOMAIN` | 任意 | ワイルドカードのドメイン(例: `example.com`)。サイトごとに `https://<ID>.example.com/` で公開されます |
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

### 3.5 公開サイト専用ドメイン(GAKU acct の枠など、埋め込みを使うサイトに必要)

**何が違うのか:** 本家の Vercel では、あなたのサイトは「自分専用のドメイン」で動きます。一方 SiTBANK は、初期設定だと SiTBANK 本体と同じドメインの中(`/s/<ID>/`)で公開します。すると、サイトの JavaScript が **SiTBANK 本体のログイン情報を盗める**ため、安全のために公開サイトを「隔離(sandbox)」して表示しています。
この隔離は、サイトの中に埋め込んだ別のページ(**GAKU acct の `<iframe>` など**)にも同じ制限をかけてしまい、Google の画面(Cookie・ログインが必要)が表示されなくなります。`localStorage` は代用品でなんとか動かしていますが、Cookie や IndexedDB は動きません。

**直し方:** 公開サイトを、SiTBANK 本体とは **別のドメイン**で配信します。別ドメインなら、本体のログイン情報には触れないので、隔離なしの「ふつうのサイト」として動かせます(本家 Vercel と同じ動きです)。iframe・Cookie・`localStorage`・IndexedDB がすべてそのまま使えます。

**やり方(かんたん・無料): `SITE_HOST`**
1. Vercel のプロジェクト → **Settings → Domains** → **Add** で、もう1つドメインを追加します(例: `sitbank-sites.vercel.app`。空いていれば好きな名前でOK)。
2. **Settings → Environment Variables** に `SITE_HOST` = `sitbank-sites.vercel.app` を追加します(`https://` は付けない)。
3. **Redeploy**(再デプロイ)します。

これで、サイトのURLが `https://sitbank-sites.vercel.app/s/<ID>/` になります。本体のドメインに `/s/<ID>/` でアクセスしても、自動で転送されます(昔のURLもそのまま使えます)。専用ドメインでは、SiTBANK の画面と API は開けません。
注意: この方法では、**公開サイトどうしは同じドメインを共有**します(サイトAの `localStorage` を、サイトBも読めます)。信頼できる人だけで使うなら問題ありません。

**もっと安全に: `SITE_DOMAIN`(自分のドメインが必要)**
自分のドメイン(例: `example.com`)を持っていて、Vercel にワイルドカード(`*.example.com`)を追加できるなら、`SITE_DOMAIN` = `example.com` を設定します。サイトのURLは `https://<ID>.example.com/` になり、**サイトごとに別ドメイン**なので、サイトどうしも隔離されます。

**どちらも設定しない場合:** 従来どおり(隔離して配信)です。GAKU acct の枠のような埋め込みは表示されない場合があります。

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

ファイル名・フォルダ名は **自由** です。世界中の言語の文字(日本語の漢字・ひらがな・カタカナ、中国語、韓国語、アラビア語、キリル文字、タイ語など)、数字、**スペース(先頭・末尾も)、あらゆる記号、絵文字**が使えます(例: `私の 写真 (1).html`、`🎉パーティー.html`、` スペースから始まる.html`、`a\b#c%d.html`、`.hidden.html`)。使えないのは、`/`(フォルダの区切りになるため)、制御文字(改行など)、「`.`」「`..`」だけの名前です。フォルダは6階層まで、名前は1つ60文字まで、拡張子は必要です。公開URLでは、スペースや記号は自動で変換されて開けます(例: `私の 写真.html` → `/s/ID/私の%20写真`)。

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
- **`require` でも `import` でも書けます**(`export default async (req) => …` / `export const GET = …` も可)。`server/` の中は `.js` `.mjs` `.cjs` `.json` を置けて、`import { x } from './server/lib.mjs'` のように読み込めます。
- 使える Node.js 標準モジュール: `crypto url querystring util buffer path zlib events string_decoder assert stream timers http https http2 net tls dns os async_hooks perf_hooks fs` など(`node:` を付けてもOK)。通信は `fetch` や `https` が使えます。
- `fs` は「プロジェクトの `server.js` と `server/` の中身」を読める仮のファイル置き場です(`fs.readFileSync('server/data.json')`、`readdirSync`、`existsSync` など)。書き込みもできますが、**その1回のリクエストの間だけ**有効で、終わると消えます。残したいデータは SerBANK へ。
- `npm` のパッケージ(`node_modules`)、他のプログラムの起動(`child_process`)、Worker、`vm` はできません。**サーバーは、リクエストのたびに起動して終わる方式**なので、`app.listen()` で待ち受け続ける Express のようなプログラムは動きません(`(req) => …` の関数の形で書いてください)。
- `console.log` は、画面の「サーバー → 試してみる」で持ち主にだけ見えます。

### 環境変数と SerBANK

「環境変数」タブの **かんたん追加 → SerBANK** で、`SERBANK_BASE_URL` / `SERBANK_PUBLIC_KEY` / `SERBANK_SECRET_KEY` の3つが入ります。

- **Secret キーは、必ず環境変数に**入れて `server.js` から使ってください。`index.html` など公開されるファイルには書かないでください。
- ブラウザで動く HTML / JS から SerBANK を使うなら、書いてよいのは **Public キー**だけです。
- 環境変数は暗号化して保存され、保存したらデプロイし直さなくてもすぐ反映されます。

---

## AI でサイトを作って、SiTBANK に載せる(2パターン)

サイトづくりを AI(ChatGPT・Claude など)に手伝ってもらう場合の、進め方です。
**まず決めるのは、「みんなで共有するデータ(書き込んだ内容を、ほかの人にも見せたい)」があるかどうか**です。

| | パターンA: SerBANK を使わない | パターンB: SerBANK を使う |
| --- | --- | --- |
| 向いているサイト | 自己紹介、作品紹介、ポートフォリオ、クイズ、ゲーム、電卓、時間割 | 掲示板、投票、ランキング、みんなのコメント、出欠表 |
| データの置き場所 | なし。または、見ている人自身のブラウザの中(`localStorage`) | SerBANK(みんなで共有される) |
| 作るファイル | HTML・CSS・JS・画像だけ | 上に加えて、サーバー用の `server.js` |
| 環境変数 | いらない | SerBANK のかんたん追加で入れる |
| 難しさ | かんたん | すこし手間(でも手順は決まっています) |

### パターンA: SerBANK を使わない(HTML だけ)

**考え方:** ふつうのホームページです。パソコンやスマホのブラウザだけで動きます。サーバーは使いません。
記録を残したいときは `localStorage` が使えます。ただし、**その人のブラウザの中だけ**に残ります(自分の記録は残るが、友だちの画面には出ません)。

**手順**
1. AI に、作りたいサイトを日本語で伝えます(下の「AIへのお願いの例」をコピーして使えます)。
2. AI が出した HTML(と CSS・JS・画像)を、ファイルにして保存します。ファイル名は自由です(`index.html` が無くてもOK)。
3. SiTBANK にログイン → 「新しいプロジェクト」 → ファイルをアップロード → 「デプロイ」。
4. 出てきたURL(`/s/<ID>/`)を開いて、動くか確認します。直したいときは、AI に「ここを直して」と頼み、ファイルを差し替えてもう一度デプロイします。

**AIへのお願いの例(パターンA)**
```
HTML・CSS・JavaScript だけで動く、〇〇のサイトを作ってください。
・サーバーやデータベースは使いません。
・記録を残したいときは localStorage を使ってください。
・外部のライブラリは使わず、ファイルは index.html の1枚(または index.html + style.css + script.js)にしてください。
・スマホでも見やすくしてください。
```

### パターンB: SerBANK を使う(みんなで共有するデータがある)

**考え方:** データは SerBANK という「みんなで使う入れ物」に置きます。
データの **読み取り** は誰でもできますが、**書き込み** には Secret キーという「合いかぎ」が必要です。この合いかぎをサイトの HTML に書くと、見た人全員に盗まれてしまいます。
そこで、**書き込みだけは `server.js`(サーバー側)に任せます。** 合いかぎは「環境変数」に入れておき、`server.js` だけが使います。

```
 見ている人のブラウザ(index.html) ──「書き込んで」──▶ server.js ──(合いかぎで)──▶ SerBANK
 見ている人のブラウザ(index.html) ◀──────── 読み取り(Publicキー) ───────────────── SerBANK
```

**手順**
1. SiTBANK で新しいプロジェクトを作ります。
2. 「環境変数」タブ → **かんたん追加 → SerBANK** を押します。`SERBANK_BASE_URL` / `SERBANK_PUBLIC_KEY` / `SERBANK_SECRET_KEY` の3つが入ります(Secret キーだけは、自分で貼り付けます)。→ 保存。
3. AI に、サイトと `server.js` を作ってもらいます(下の「AIへのお願いの例」)。
4. 出てきたファイルを保存します。`index.html` などの画面用ファイルと、**名前を `server.js` にしたファイル**を用意します。
5. 「ファイル」タブでアップロード → 「デプロイ」。
6. 「サーバー」タブの **試してみる** で、`server.js` が動くか確認できます(`console.log` の中身もここに出ます)。
7. サイトのURLを開いて、書き込み・読み取りができるか確かめます。

**AIへのお願いの例(パターンB)**
```
〇〇(例: みんなで書き込める掲示板)を作ってください。次の決まりを守ってください。

【ファイル】
・画面用の index.html(HTML・CSS・JS だけ。外部ライブラリなし)
・サーバー用の server.js(Node.js)

【データの置き場所】
・データは SerBANK に保存します。
・書き込み(PUT/POST/DELETE)は、必ず server.js からだけ行います。
  Secret キーは process.env.SERBANK_SECRET_KEY から読み、HTML や JS には絶対に書かないでください。
・URLの土台は process.env.SERBANK_BASE_URL を使い、リクエストのヘッダーに
  'X-API-Key': process.env.SERBANK_SECRET_KEY を付けます。

【server.js の書き方】
module.exports = async (req) => { ... } の形で、req.method / req.path / req.query / req.body が使えます。
オブジェクトを return すると JSON で返ります。通信は fetch が使えます(npm のパッケージは使えません)。
index.html からは fetch('api/xxx') のように、相対パスで呼んでください。

【SerBANK の制限】
・値は文字列のみ。1件64KBまで。全部で1000件まで。
・複数の項目は、JSON.stringify して1つの文字列として保存してください。
```

### 迷ったら
- 「他の人の画面にも反映させたい?」 → **はい** ならパターンB、**いいえ** ならパターンA。
- 最初はパターンAで作って、あとから「共有したくなった」ときに、パターンBへ足していくこともできます(`server.js` を足して、環境変数を入れるだけです)。
- AI が書いたコードに Secret キー(`sk_` で始まる文字)が直接書かれていたら、**そのままアップロードしないで**、環境変数を使う形に直してもらってください。

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

- **公開サイトは隔離して配信**します(`SITE_HOST` / `SITE_DOMAIN` が未設定のとき: `Content-Security-Policy: sandbox`。設定すると、別ドメインで配信するので sandbox なしでも本体と分離されます)。そのため、公開サイトの JS から SiTBANK 本体のログイン情報には触れません。公開サイト自身の `localStorage` / `sessionStorage` は、下の「localStorage について」のしくみで使えます(Cookie と IndexedDB は使えません)。
- **環境変数・アカウント情報・server.js は暗号化**(AES-256-GCM)して SerBANK に保存します。SerBANK の Public キーは誰でも読めるため、平文では置きません。
- **ログインできるのは GAKU acct のアカウントだけ**です。確認コードは1回限りで、ログインの記録は署名つきトークン(14日)です。
- **`server.js` は別プロセスで実行**し、Node の permission model で「ファイル読み取り・子プロセス・Worker・バインディング」を禁止、環境変数はそのプロジェクトのものだけ、メモリ128MB、制限時間つきです。手元の試験では、`fs` / `child_process` / `process.binding` / `/proc/<親>/environ` はすべて拒否され、親の Secret キーも見えませんでした(サイト側の `fs` は、本物のファイルではなく、プロジェクトの中身だけを返す仮のものです)。
  ただし通信(`fetch` / `http` / `https` / `net`)は制限していないので、サーバーコードから、SiTBANK を動かしているサーバーと同じネットワークの中のものへアクセスできてしまいます。
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
- **サイトの中の GAKU acct の枠(iframe)が表示されない** … 公開サイトを本体と同じドメインで隔離して配信しているためです。「3.5 公開サイト専用ドメイン」の `SITE_HOST` を設定してください。
- **「サーバー機能は使えません」と出る** … このサーバーの Node.js が permission model に未対応(Node 22.13 以上が必要)か、`ENABLE_SERVER_CODE=0` になっています。
