# Owl Diff Search

Git の変更箇所だけを、自然言語またはキーワードで検索する VS Code 拡張です。

検索と埋め込みはローカルのPythonサーバーで実行され、コードは外部へ送信されません。

## 機能

- `HEAD` とワーキングツリー、または任意の base / head ref を比較
- 実際の `git diff` を1 hunkずつ検索する `Hunks`
- 選択範囲内の各コミットについて、同じファイルのhunkをまとめ、最も高いファイルスコアを採用する `Commits`
- `Semantic` / `Hybrid` / `BM25` / `Keyword` の4モード
- 拡張子を問わず、Git差分に含まれる全テキストファイルをまとめて検索（バイナリ差分は除外）
- コミットグラフから base / head を選択
- 結果から VS Code 標準の左右 diff エディタを開く
- 同じ差分・モデル・検索単位の埋め込みをディスクへ保存し、次回以降とサーバー再起動後に再利用
- オプションで日本語クエリを Gemini により英訳

## インストール

1. リポジトリ直下で `npm ci && npx @vscode/vsce package` を実行して VSIX を作成します。
2. VS Code のコマンドパレットで `Extensions: Install from VSIX...` を実行します。
3. Activity Bar の Owl Diff Search を開きます。
4. `Setup / Start` を押します。

初回セットアップには [`uv`](https://docs.astral.sh/uv/getting-started/installation/) とネットワーク接続が必要です。Python 3.11、PyTorch、検索モデルなどをローカル環境へ導入します。モデルの初回ダウンロードには時間と数 GB 程度の空き容量が必要です。

## 使い方

- base / head を空欄にすると `HEAD → working tree` を検索します。
- base のみ指定すると `base → HEAD` を検索します。
- base / head の両方を指定すると、その範囲のコミット差分を検索します。
- コミット一覧ではクリックで base、Shift+クリックで head を設定します。
- コミットツリー上部の `Branch` では表示・検索するブランチを直接選べます。`More tree options` では、表示するブランチ先端の最大数と履歴のたどり方を指定できます。
- `Hunks` は追加・削除・contextを含む個々のunified diff hunkを検索します。
- `Commits` は1コミット内のhunkをファイルごとにまとめて検索し、最もスコアが高いファイルをそのコミットの代表値として扱います。ワーキングツリーもファイルごとに評価し、1つの `Working tree changes` として結果を返します。
- 検索結果または `Open diff` を押すと VS Code 標準 diff が開きます。
- 検索入力は英語が基準です。同じ差分を再検索した場合は保存済み埋め込みを使います。
- 言語選択は不要です。サイドバーの言語表示は参考情報であり、検索自体は依存定義、lockファイル、Markdown、YAML、拡張子なしファイルを含む全テキスト差分が対象です。

### 検索対象を絞る

`Target filters` を開き、リポジトリルートからのパスまたはglobをカンマ区切りで指定します。

- Include `.py`: Pythonファイルだけ
- Include `src/**`: `src` 以下だけ
- Include `src/**/*.py`: `src` 以下のPythonだけ
- Include `src/flask/app.py`: 特定ファイルだけ
- Exclude `tests/**, docs/**`: テストとドキュメントを除外

Includeを複数指定した場合はいずれかに一致するファイルが対象です。ExcludeはIncludeの結果から除外します。`Commits` では条件に一致するファイルを変更したコミットだけが残り、そのファイルのdiffだけを検索対象にします。空欄なら全テキストファイルを検索します。

### ブランチとマージ履歴を絞る

`Compare range` 内のコミットツリー上部からブランチを選び、必要な場合だけ `More tree options` を開きます。

- `Branch`: 1ブランチだけに絞ります。選択したブランチは Head 入力より優先され、コミットツリーとdiff検索の両方に適用されます。
- `Max branches`: `All visible branches` のとき、更新日時が新しいブランチ先端を何本までツリーへ読み込むかを制限します。現在のブランチは最優先です。
- `Full history`: merge commit の全parentをたどります。通常のmergeでdev側に複数コミットがあれば、その個別コミットもツリーと検索対象に入ります。
- `First parent`: 選択したブランチのmainlineだけをたどります。dev側の個別コミットは表示せず、取り込まれた変更をmerge commitのdiffとして扱います。

fast-forward merge と rebase では個別コミットが線形履歴に残ります。squash merge ではdev側の個別コミットはmainへ入らず、1つのsquash commitだけが対象です。

## Flaskで試す

次のコマンドで `pallets/flask` を用意できます。このフォルダをVS Codeで直接開き、Base `e4e4bf65`、Head `d318b683` を設定すると、評価に使った差分を検索できます。具体的なクエリと順位は `SEARCH_EVALUATION.md` にあります。

```bash
mkdir -p demo_repositories
git clone --depth 50 https://github.com/pallets/flask.git demo_repositories/flask
```

日本語クエリの英訳を使う場合は、VS Code Settings で `owlDiffSearch.geminiApiKey` を設定し、サイドバーの `Japanese-to-English translation` を有効にしてください。Keyword モードでは翻訳しません。

## 開発

```bash
npm install
npm run compile
npm run lint
npm test
npm run test:extension # VS Code/Electron を実行できる環境で
npx @vscode/vsce package
```

Python の構文チェック:

```bash
python3 -m py_compile model_server/*.py
```

## ライセンス

MIT。詳細は `LICENSE` を参照してください。
