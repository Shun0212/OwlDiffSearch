# OwlDiffSearch

Git の変更差分（diff）に特化し、自然言語やキーワードで検索できる VS Code 拡張機能です。

差分抽出・埋め込み（Embedding）生成・検索処理は、VS Code 内の Node.js Worker で実行します。NightOwl-CodeEmbedding の ONNX モデルを利用し、Python・uv・PyTorch・HTTP サーバーの起動は不要です。

## 主な機能

- **柔軟な比較範囲**: `HEAD` と作業ツリー、または任意のコミット・ブランチ（From / To）間の差分を検索可能
- **選べる検索単位**:
  - `Hunks`: `git diff` のハンク（変更箇所のまとまり）単位で検索
  - `Commits`: コミット内のハンクをファイルごとにまとめ、最も関連度が高いファイルのスコアを採用してコミット単位で検索
  - `Branches`: 「特定の変更を行ったブランチ」を変更内容から検索。比較元ブランチに含まれないコミット差分を検索し、一致の根拠となったコミットを表示
- **4つの検索モード**: `Semantic`（意味検索）、`Hybrid`（意味検索＋BM25）、`BM25`、`Keyword`（キーワード一致）
- **スマートなテキスト差分検索**: 拡張子を問わずテキストファイルの差分を検索（デフォルトでドキュメント類は除外、バイナリ差分は自動スキップ）
- **コミットグラフ連携**: コミットグラフ上で From / To を直感的に選択でき、対象範囲を行・ノード・接続線でハイライト表示
- **VS Code 標準 Diff エディタ連携**: 検索結果から VS Code 標準の差分画面を直接オープン
- **高効率な埋め込みキャッシュ**: 生成した埋め込みはディスクに保存。差分内容とモデルが同じであれば、拡張機能の再起動後や検索範囲の変更時にも再利用され、新規・変更差分のみを再計算
- **日本語クエリの英訳機能**: オプションで Gemini を利用し、日本語の検索クエリを自動で英訳して検索可能

## インストール

1. リポジトリ直下で `npm ci && npx @vscode/vsce package` を実行し、VSIX パッケージを作成します。
2. VS Code のコマンドパレット（`Ctrl+Shift+P` / `Cmd+Shift+P`）から `Extensions: Install from VSIX...` を実行し、生成されたファイルを選択してインストールします。
3. アクティビティバー（サイドバー）の OwlDiffSearch アイコンを開きます。
4. 検索クエリを入力して `Search` をクリックします。必要なモデルは自動で読み込まれます。

初回の意味検索には、Hugging Face からモデルを取得するためのインターネット接続が必要です。既定の INT8 モデルは約152 MB（ほかにトークナイザーなどの小さなファイル）です。取得後はオフラインでも検索できます。`BM25` / `Keyword` はモデルの取得も不要です。利用時には Git と VS Code が必要で、Node.js ランタイムは VS Code に内蔵されています。

### ONNX の設定

- サイドバーの **Settings → Search behavior → Embedding model** で通常版と35M版を選べます。**Model precision** では `INT8 — Quantized`（既定）と `FP32 — Full precision` を切り替えられます。モデルに応じたダウンロードサイズも表示します。
- 選択内容は VS Code 設定の `owlDiffSearch.modelName` / `owlDiffSearch.onnxDtype`（`q8` / `fp32`）に保存され、次の意味検索から適用されます。モデルと量子化形式ごとに埋め込みキャッシュを分離します。推論は ONNX Runtime の CPU 実行です。
- `owlDiffSearch.modelRevision`: 通常は空欄のままで、選択モデルの検証済みコミットを自動使用します。手動で更新する場合は40桁のコミットハッシュを指定します。サイドバーでモデルを変更すると、別モデルのリビジョンが残らないようこの上書き指定をリセットします。
- `owlDiffSearch.batchSize`: 既定値 `2`。メモリ使用量を抑える場合は `1` に下げてください。

| モデル | 出力次元 | INT8 ONNX | FP32 ONNX |
|---|---:|---:|---:|
| `NightOwl-CodeEmbedding`（既定） | 768 | 約152 MB | 約604 MB |
| `NightOwl-CodeEmbedding-35M` | 384 | 約35 MB | 約137 MB |

通常版は `cfc3c6d172a93c79826db380ce82b6fee377ae1c`、35M版は `ca36960f1d5ca8ef69a133464202e432635fc595` に固定しています。35M版のエクスポート仕様は[ONNX manifest](https://huggingface.co/Shuu12121/NightOwl-CodeEmbedding-35M/blob/ca36960f1d5ca8ef69a133464202e432635fc595/onnx/manifest.json)を参照してください。

ONNX の入力は `input_ids` / `attention_mask`、出力は `last_hidden_state` です。先頭の CLS を取り出して L2 正規化します。長い入力は本文を1022トークンに切り詰め、CLS / SEP の両方を保持します。クエリ・文書用の接頭辞は付けません。仕様は[モデルの ONNX README](https://huggingface.co/Shuu12121/NightOwl-CodeEmbedding/blob/cfc3c6d172a93c79826db380ce82b6fee377ae1c/onnx/README.md)に対応しています。

## 使い方

### 検索範囲の指定
- **デフォルト**: `HEAD` から遡る直近100コミットの差分を検索します（From / To の指定は不要です。履歴が100件未満なら全コミットが対象となり、作業ツリーの未コミット変更は含まれません）。
- **作業ツリーの検索**: `Settings` → `Compare range` → `When From is blank` を `Working tree / manual range` に変更し、From / To と Branch を空欄にすると `HEAD → 作業ツリー` の差分を検索します。
- **From のみ指定**: `From → HEAD` の範囲を検索します。
- **From と To の両方を指定**: その間のコミット差分を検索します（From を指定した場合、100件の上限は適用されません）。
- **From が空欄で To または Branch を指定**: 指定した先端（tip）から直近100コミットを検索します。

### コミットグラフの操作
- コミット一覧は初期状態で100件読み込まれ、スクロールすると過去の履歴が追加表示されます（追加表示を行っても検索対象のコミット数は増えません）。
- コミット一覧でクリックすると `From`、Shift+クリックで `To` を選択できます。
- 対象範囲のコミットは緑、From は青、To は黄色でハイライトされ、ブランチラベルにはブランチごとに固定色が付きます。
- 同じコミットを指す複数のブランチやタグは「代表名 + 件数」にまとめられ、ホバーするとすべての参照名を確認できます。現在のブランチが代表名として優先され、Git の現在位置には `Current`、比較範囲の始点・終点には `From` / `To` バッジが表示されます。
- `Settings` → `Commit history` から、表示・検索対象とするブランチ、表示するブランチ先端の最大数、履歴の走査方法をカスタマイズできます。

### 検索単位と差分の確認
- `Hunks`: 追加・削除行および前後のコンテキスト行を含む、unified diff の個々のハンク単位で検索します。
- `Commits`: コミット内のハンクをファイルごとにまとめて検索し、最もスコアが高いファイルの値をコミット全体のスコアとして扱います（作業ツリーもファイルごとに評価され、1つの「Working tree changes」として返されます）。
- コミット検索の結果または青色の `Open Commit Diff` をクリックすると、そのコミットで変更された全ファイルを VS Code 標準の差分エディタでまとめて開きます（最も一致したファイルが先頭に表示され、検索フィルターで除外されたファイルも含めて変更全体を確認できます。マージコミットの場合は第1親コミットとの差分を表示します）。
- 結果内のファイル名をクリックすると、そのファイル単体の差分が開きます（`Hunks` の `Open Diff` は該当ファイル、`Branches` の `Open Best Diff` は最も一致度が高いファイルを開きます）。

### 検索モードとスコアリング
- 検索クエリは英語入力が基本です（同じ差分を再検索する際は保存済みの埋め込みが利用されます）。
- `Semantic`: クエリと差分の埋め込みを L2 正規化し、Node.js 内で内積を計算してコサイン類似度を算出します。スコアは −1〜1 の範囲で小数第3位まで表示されます（候補内での再正規化は行いません）。
- `Hybrid`: コサイン類似度と、0〜1 に正規化した BM25 スコアを既定の比率（0.6 : 0.4）で合成します。
- `BM25`: 正規化スコアをパーセント（%）で表示します。
- `Keyword`: 完全一致（Match）を表示します。
- ONNX 用キャッシュは旧 Python 版と独立しています。量子化により埋め込みに差が出るため、Python 版のキャッシュは流用せず、ONNX で初回に計算します。
- `Semantic` は候補を類似度順に返します。該当変更の有無を自動判定するしきい値は設けていません。`BM25` / `Keyword` は語が一致しなければ0件です。
- プログラミング言語の選択は不要です。サイドバーの言語表示は参考情報であり、依存関係ファイル、ロックファイル、YAML、拡張子のないファイルも検索できます。Markdown などのドキュメント類はデフォルトで除外されますが、設定から対象に含めることも可能です。

### クエリの記述例

自然言語で探すときは `Semantic` を選び、「何に対して、どんな動作を追加・修正したか」を簡潔な英語で入力します。

| 探したい変更内容 | 入力例 |
|---|---|
| 必須項目がないリクエストを拒否する | `reject requests with missing required fields` |
| タイムアウトしたリクエストを再試行する | `retry requests after a timeout` |
| 認証トークンをログに出さないようにする | `redact authentication tokens from logs` |
| 入力が変わっていない場合にキャッシュを再利用する | `reuse cached results when the input has not changed` |
| 検索処理中の重複リクエスト（連打）を防ぐ | `prevent duplicate searches while a request is running` |
| テストコード内のプライベートAPIを公開APIに置き換える | `replace private test helpers with public APIs` |

- **クエリ作成のコツ**: 1つのクエリには1つの具体的な変更内容を記述します。例えば単に `fix bug` とするのではなく、「どんな状況で何を防ぐか」を補足して `avoid crashing when the response body is empty` のように記述します。
- 関数名、エラーメッセージ、HTTP メソッドなどの具体的なキーワードが分かっている場合は、クエリに含めるか `BM25` / `Keyword` モードを利用すると効果的です。
- 目的の単位に合わせて、コミットを探すなら `Commits`、個々の差分箇所なら `Hunks`、変更を含むブランチなら `Branches` を選択してください。

### 検索対象の絞り込み（フィルター）

`Settings` → `Target filters` から、リポジトリルートを基準としたパスまたは glob パターンをカンマ区切りで指定できます。

- `Include .py`: Python ファイルのみ
- `Include src/**`: `src` ディレクトリ配下のみ
- `Include src/**/*.py`: `src` ディレクトリ配下の Python ファイルのみ
- `Include src/flask/app.py`: 特定のファイルのみ
- `Exclude tests/**, docs/**`: テストとドキュメントを除外
- `Exclude documentation files`: `.md`、`.rst`、`.adoc`、`.org` などのドキュメントや、拡張子のない `README`、`CHANGELOG`、`LICENSE` などを除外（デフォルトでオン）

> **補足**:
> - `Include` を複数指定した場合は、いずれかに一致するファイルが対象になります（OR 条件）。
> - `Exclude` およびドキュメント除外設定は、`Include` の結果からさらに除外されます。
> - `Commits` 検索では、条件に一致するファイルを含むコミットのみが抽出され、一致したファイルの差分だけが検索対象となります。
> - ドキュメント除外をオフにし、`Include` / `Exclude` を空欄にすると、すべてのテキスト差分を検索します。なお、`package.json` や `requirements.txt` などの依存定義ファイルは、ドキュメント除外がオンのままでも検索対象に残ります。

### ブランチとマージ履歴の絞り込み

`Settings` → `Commit history` で、対象ブランチや履歴の遡り方を指定できます（From / To を直接入力する場合は、同じく Settings 内の `Compare range` で設定します）。

- `Branch`: 特定の1ブランチのみに絞り込みます。ここで選択したブランチは To の指定より優先され、コミットツリーと差分検索の両方に適用されます。
- `Max branches`: `All visible branches` 選択時、更新日時が新しいブランチ先端を最大何本までツリーに読み込むかを制限します（現在のブランチは常に最優先されます）。
- `Full history`: マージコミットのすべての親コミット（parent）を遡ります。通常のフィーチャーブランチのマージで複数コミットがある場合、それらの個別コミットもツリーおよび検索対象に含まれます。
- `First parent`: 選択したブランチのメインライン（第1親）のみを辿ります。フィーチャーブランチ側の個別コミットは辿らず、取り込まれた変更全体をマージコミットの差分として扱います。

※ Fast-forward マージや Rebase を行った場合は、個々のコミットが直線的な履歴として残ります。Squash マージの場合は元の個別コミットは統合されず、1つの squash コミットのみが対象となります。

### 変更内容からブランチを探す（Branches モード）

1. 画面上部の `Find` で `Branches` を選択します。
2. `Changes not in` で比較元のベースブランチ（例: `main`）を選択します。`Auto` を選ぶと、ローカルの `main`、`origin/HEAD` が指すブランチ、`master` などから自動選択されます（判定できない場合は手動で指定してください）。
3. 検索ボックスに探したい変更内容（例: `retry failed authentication`）を入力して検索します（日本語翻訳を有効にしている場合は日本語での検索も可能です）。
4. 変更内容との関連度順にブランチ名が表示されます。`Matching changes` に表示されたコミットをクリックすると根拠となったファイル差分が開き、`Open Best Diff` で最も一致度が高いファイル差分を直接開くことができます。

**仕様と注意点**:
- 検索対象はローカルブランチおよび取得済みのリモート追跡ブランチです。各ブランチの `比較元..対象ブランチ` に含まれるコミットのファイル差分を検索し、最もスコアが高かったファイルの値をブランチのスコアとします（`Keyword` モードでは一致したブランチが名前順で表示されます）。
- 結果には、一致の根拠となったコミットが最大3件まで表示されます。なお、ブランチ名やコミットメッセージ自体は検索スコアには影響しません。
- 同じコミットを含む複数ブランチが存在する場合、検索用の埋め込みは共有されます。ローカルブランチと追跡ブランチが同じコミットを指している場合は、エイリアス（別名）として1つの結果にまとめられます。
- `Include` / `Exclude` フィルターはブランチ検索にも適用されます。
- `Branches` モードでは全ブランチを横断検索するため、ツリー表示用の `Branch`、`Max branches`、`History` や From / To の範囲指定は無視されます（マージ先の親コミットもすべて辿ります）。
- 検索処理によってリポジトリの checkout や fetch が勝手に行われることはありません。
- 比較元ブランチに全コミットがマージ済みのブランチや、参照が削除されたブランチは結果に表示されません。ただし、Squash や Rebase によってマージされた場合はコミットハッシュが異なるため、同一の変更であっても元ブランチが結果に残る場合があります。

### 検索処理の制御とキャッシュ

- **二重リクエスト防止とキャンセル**: Worker が処理中は検索・準備の重複送信を防ぎ、進捗とキャンセルを受け付けます。検索条件を変更すると以前の結果を消してキャンセルを要求し、処理終了後に再検索できます。遅れて届いた変更前の結果は表示しません。実行中の ONNX 推論は現在のバッチ終了時にキャンセルされます。モデルの精度を切り替えると読み込み済みのモデルを解放し、次の検索で選択したモデルを読み込みます。
- **埋め込みキャッシュの仕組み**: 差分テキストの SHA-256 と、モデル名・リビジョン・量子化形式・前処理バージョンをキーとして保存します。検索範囲を変更しても同一の本文は再利用します。保存先は VS Code が拡張機能に割り当てる `globalStorage/owl-diff-search-local.owl-diff-search` 配下の `models/` と `embeddings/` です。コマンドパレットの `OwlDiffSearch: Clear Embedding Cache` は埋め込みだけを削除し、取得済みモデルを保持します。

## サンプルリポジトリ（Flask）で試す

動作確認用として、以下のコマンドで `pallets/flask` リポジトリをクローンして試すことができます。クローンしたフォルダを VS Code で開き、コミットツリーから From と To を選択すると、その範囲の差分検索を体験できます。

```bash
mkdir -p demo_repositories
git clone --depth 50 https://github.com/pallets/flask.git demo_repositories/flask
```

> **日本語クエリの英訳機能を利用する場合**:
> VS Code の設定（Settings）で `owlDiffSearch.geminiApiKey` に API キーを設定し、拡張機能サイドバーの `Settings` 内にある `Japanese-to-English translation` を有効にしてください（`Keyword` モードでは翻訳を行いません）。

## 開発

### 初回セットアップ

事前に Node.js（npm を含む）、Git、VS Code をインストールしてください。リポジトリをクローン後、プロジェクトルートで以下のコマンドを実行します。

```powershell
npm ci --include=dev
npm run watch
```

`git clone` だけでは依存パッケージはインストールされません。`npm ci --include=dev` を実行して `package-lock.json` に基づく TypeScript などの開発用パッケージをインストールしてください（`node_modules` は Git 管理外のため、このコマンドで復元されます）。

`Found 0 errors. Watching for file changes.` と表示されれば準備完了です。`watch` はファイルの変更を監視して自動で再コンパイルを行います（終了時は `Ctrl+C`）。

VS Code 上で拡張機能をデバッグする場合は、依存関係のインストール後に `F5`（`Run Extension`）キーを押してください。デバッグ起動時に `watch` タスクが自動実行されるため、手動で `npm run watch` を立ち上げる必要はありません。

※ `'tsc' は、内部コマンドまたは外部コマンド…として認識されていません` というエラーが出た場合も、リポジトリ直下で `npm ci --include=dev` を実行してから再度お試しください。

### ビルドとテスト

```bash
npm run compile
npm run lint
npm test
npm run test:extension # VS Code / Electron を実行可能な環境で実行
npx @vscode/vsce package
```

実際の ONNX モデルによる検索検証（初回はモデルをダウンロード）:

```bash
npm run test:onnx
# 35M版（キャッシュ保存先、モデル、精度の順に指定）
npm run test:onnx -- /tmp/owl-onnx-test Shuu12121/NightOwl-CodeEmbedding-35M q8
# 同じキャッシュを使い、追加のネット接続なしで再検証
OWL_ONNX_OFFLINE=1 npm run test:onnx
```

`npm test` はモデルを取得せず、実 Git リポジトリによる範囲・マージ・ブランチ・ファイル名・フィルターの検証と、キャッシュ・キャンセル・Worker の検証を実行します。`test:onnx` は3つの固定クエリの順位、語彙検索の該当なし、再起動後のキャッシュ、長文の SEP、バッチ内パディングを実モデルで検証します。検証用モデルは OS の一時ディレクトリ内 `owl-onnx-smoke-cache/` に保存され、`OWL_ONNX_CACHE_DIR` で変更できます。

`model_server/` は旧実装の参照用としてソースに残していますが、拡張機能から呼び出さず、VSIX にも含めません。ネイティブ ONNX Runtime を含むため、配布用 VSIX は対象 OS / CPU 上で依存関係をインストールして作成してください（例: Apple Silicon では `npx @vscode/vsce package --target darwin-arm64`）。

## ライセンス

MIT ライセンス。詳細は `LICENSE` ファイルを参照してください。
