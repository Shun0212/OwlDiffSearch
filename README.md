# OwlDiffSearch

Git の変更箇所だけを、自然言語またはキーワードで検索する VS Code 拡張です。

検索と埋め込みはローカルのPythonサーバーで実行され、コードは外部へ送信されません。

## 機能

- `HEAD` とワーキングツリー、または任意の base / head ref を比較
- 実際の `git diff` を1 hunkずつ検索する `Hunks`
- 選択範囲内の各コミットについて、同じファイルのhunkをまとめ、最も高いファイルスコアを採用する `Commits`
- 「こういう変更をしたブランチ」を変更内容から探す `Branches`。比較元に含まれないコミットの差分を検索し、一致したコミットを根拠として表示
- `Semantic` / `Hybrid` / `BM25` / `Keyword` の4モード
- 拡張子を問わずGit差分内のテキストファイルを検索し、既定ではドキュメントだけを除外（バイナリ差分は対象外）
- コミットグラフから base / head を選択し、対象範囲を行・ノード・接続線で強調表示
- 結果から VS Code 標準の左右 diff エディタを開く
- 同じ差分・モデル・検索単位の埋め込みをディスクへ保存し、次回以降とサーバー再起動後に再利用
- 差分内容とモデルが同じ埋め込みは検索範囲をまたいで再利用し、変更・追加された差分だけを再計算
- オプションで日本語クエリを Gemini により英訳

## インストール

1. リポジトリ直下で `npm ci && npx @vscode/vsce package` を実行して VSIX を作成します。
2. VS Code のコマンドパレットで `Extensions: Install from VSIX...` を実行します。
3. Activity Bar の OwlDiffSearch を開きます。
4. `Setup / Start` を押します。

初回セットアップには [`uv`](https://docs.astral.sh/uv/getting-started/installation/) とネットワーク接続が必要です。Python 3.11、PyTorch、検索モデルなどをローカル環境へ導入します。モデルの初回ダウンロードには時間と数 GB 程度の空き容量が必要です。

## 使い方

- base / head を空欄にすると `HEAD → working tree` を検索します。
- base のみ指定すると `base → HEAD` を検索します。
- base / head の両方を指定すると、その範囲のコミット差分を検索します。
- コミット一覧ではクリックで base、Shift+クリックで head を設定します。
- BaseからHeadまでの対象コミットは緑、Baseは青、Headは黄で表示され、ブランチラベルにはブランチごとの固定色が付きます。
- 同じコミットを指すブランチ・タグは、代表名と `+件数` にまとめます。マウスを重ねると全参照名を確認できます。現在のブランチを代表名として優先し、Gitの現在位置は独立した `HEAD` バッジ、比較範囲の端点は `Base` / `Head` バッジで表示します。
- `Settings` の `Commit history` では、表示・検索するブランチ、表示するブランチ先端の最大数、履歴のたどり方を指定できます。
- `Hunks` は追加・削除・contextを含む個々のunified diff hunkを検索します。
- `Commits` は1コミット内のhunkをファイルごとにまとめて検索し、最もスコアが高いファイルをそのコミットの代表値として扱います。ワーキングツリーもファイルごとに評価し、1つの `Working tree changes` として結果を返します。
- 検索結果または `Open diff` を押すと VS Code 標準 diff が開きます。
- 検索入力は英語が基準です。同じ差分を再検索した場合は保存済み埋め込みを使います。
- 言語選択は不要です。サイドバーの言語表示は参考情報であり、依存定義、lockファイル、YAML、拡張子なしファイルも検索できます。Markdownなどの文書は既定で除外され、設定から含められます。

### 検索対象を絞る

`Settings` を開き、`Target filters` でリポジトリルートからのパスまたはglobをカンマ区切りで指定します。

- Include `.py`: Pythonファイルだけ
- Include `src/**`: `src` 以下だけ
- Include `src/**/*.py`: `src` 以下のPythonだけ
- Include `src/flask/app.py`: 特定ファイルだけ
- Exclude `tests/**, docs/**`: テストとドキュメントを除外
- `Exclude documentation files`: `.md`、`.rst`、`.adoc`、`.org`などの文書と、拡張子なしのREADME・CHANGELOG・LICENSEなどを除外（既定でオン）

Includeを複数指定した場合はいずれかに一致するファイルが対象です。Excludeと文書除外設定はIncludeの結果から除外します。`Commits` では条件に一致するファイルを変更したコミットだけが残り、そのファイルのdiffだけを検索対象にします。文書除外をオフにしてInclude／Excludeを空欄にすると、全テキストファイルを検索します。`package.json`や`requirements.txt`などの依存定義は文書除外をオンにしても対象に残ります。

### ブランチとマージ履歴を絞る

`Settings` の `Commit history` からブランチと履歴のたどり方を選びます。BaseとHeadの直接入力は同じ `Settings` 内の `Compare range` にあります。

- `Branch`: 1ブランチだけに絞ります。選択したブランチは Head 入力より優先され、コミットツリーとdiff検索の両方に適用されます。
- `Max branches`: `All visible branches` のとき、更新日時が新しいブランチ先端を何本までツリーへ読み込むかを制限します。現在のブランチは最優先です。
- `Full history`: merge commit の全parentをたどります。通常のmergeでdev側に複数コミットがあれば、その個別コミットもツリーと検索対象に入ります。
- `First parent`: 選択したブランチのmainlineだけをたどります。dev側の個別コミットは表示せず、取り込まれた変更をmerge commitのdiffとして扱います。

fast-forward merge と rebase では個別コミットが線形履歴に残ります。squash merge ではdev側の個別コミットはmainへ入らず、1つのsquash commitだけが対象です。

### 変更内容からブランチを探す

1. 画面上部の `Find` で `Branches` を選びます。
2. `Changes not in` で比較元（例: `main`）を選びます。`Auto` はローカルの `main`、`origin/HEAD` が指すブランチ、`master` などから選びます。自動選択できない場合は比較元を指定してください。
3. 例えば `retry failed authentication` と入力して検索します。日本語で検索する場合は既存の日本語英訳設定を利用できます。
4. ブランチ名が関連度順に表示されます。`Matching changes` のコミットを押すと根拠のファイル差分、`Open Best Diff` で最も一致した差分を開けます。

検索対象はローカルブランチと、取得済みのリモート追跡ブランチです。各ブランチの `比較元..ブランチ` に含まれるコミットのファイル単位の差分を検索し、最も高いファイルスコアをブランチのスコアとします。Keyword は一致したブランチを名前順で表示します。結果には最大3コミットの根拠を表示します。ブランチ名やコミットメッセージ自体は検索スコアに使用しません。

同じコミットを含む複数ブランチでは検索用の埋め込みを共有します。ローカルブランチと設定済みの追跡先が同じコミットを指す場合は、追跡先を別名として1つの結果にまとめます。Include / Exclude のファイル条件はブランチ検索にも適用されます。

`Branches` では全ブランチを調べるため、従来のツリー用 `Branch`、`Max branches`、`History`、Base / Head の範囲指定は適用しません。履歴はマージ先のコミットもたどります。検索による checkout や fetch は行いません。

比較元に全コミットが取り込まれたブランチや、参照が削除されたブランチは結果に出ません。squash / rebase による取り込みはコミットIDが異なるため、同じ変更内容でも元ブランチが結果に残る場合があります。

### 検索中の操作とキャッシュ

検索中は Search ボタンと Enter による同じ検索の二重送信を防ぎます。検索文・比較元・検索単位・ファイル条件などを変更すると前の結果を消し、新しい条件で検索できます。変更前の結果・翻訳・エラーが遅れて届いても表示しません。同時に届いた検索や準備処理は順番に実行し、その間も進捗確認とキャンセルに応答します。

埋め込みは差分テキストとモデル設定をキーに保存するため、コミット追加後やサーバー再起動後も既存分を再利用できます。検索範囲・ファイル条件・検索単位を変更しても、実際にモデルへ渡す差分テキストが同じなら再計算しません。検索ステータスに `2 reused / 1 new embeddings` のように再利用分と新規計算分を表示します。従来のキャッシュも読み込み時に引き継ぎます。キャッシュは `Clear Cache` で削除できます。

## Flaskで試す

次のコマンドで `pallets/flask` を用意できます。このフォルダをVS Codeで直接開き、Base `e4e4bf65`、Head `d318b683` を設定すると、評価に使った差分を検索できます。具体的なクエリと順位は `SEARCH_EVALUATION.md` にあります。

```bash
mkdir -p demo_repositories
git clone --depth 50 https://github.com/pallets/flask.git demo_repositories/flask
```

日本語クエリの英訳を使う場合は、VS Code Settings で `owlDiffSearch.geminiApiKey` を設定し、サイドバーの `Settings` 内にある `Japanese-to-English translation` を有効にしてください。Keyword モードでは翻訳しません。

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
