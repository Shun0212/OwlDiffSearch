# OwlDiffSearch

Git の変更箇所だけを、自然言語またはキーワードで検索する VS Code 拡張です。

検索と埋め込みはローカルのPythonサーバーで実行され、コードは外部へ送信されません。

## 機能

- `HEAD` とワーキングツリー、または任意の From / To ref を比較
- 実際の `git diff` を1 hunkずつ検索する `Hunks`
- 選択範囲内の各コミットについて、同じファイルのhunkをまとめ、最も高いファイルスコアを採用する `Commits`
- 「こういう変更をしたブランチ」を変更内容から探す `Branches`。比較元に含まれないコミットの差分を検索し、一致したコミットを根拠として表示
- `Semantic` / `Hybrid` / `BM25` / `Keyword` の4モード
- 拡張子を問わずGit差分内のテキストファイルを検索し、既定ではドキュメントだけを除外（バイナリ差分は対象外）
- コミットグラフから From / To を選択し、対象範囲を行・ノード・接続線で強調表示
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

- From / To を空欄にすると `HEAD → working tree` を検索します。
- From のみ指定すると `From → HEAD` を検索します。
- From / To の両方を指定すると、その範囲のコミット差分を検索します。
- コミット一覧ではクリックで From、Shift+クリックで To を設定します。
- FromからToまでの対象コミットは緑、Fromは青、Toは黄で表示され、ブランチラベルにはブランチごとの固定色が付きます。
- 同じコミットを指すブランチ・タグは、代表名と `+件数` にまとめます。マウスを重ねると全参照名を確認できます。現在のブランチを代表名として優先し、Gitの現在位置（HEAD）は独立した `Current` バッジ、比較範囲の始点・終点は `From` / `To` バッジで表示します。
- `Settings` の `Commit history` では、表示・検索するブランチ、表示するブランチ先端の最大数、履歴のたどり方を指定できます。
- `Hunks` は追加・削除・contextを含む個々のunified diff hunkを検索します。
- `Commits` は1コミット内のhunkをファイルごとにまとめて検索し、最もスコアが高いファイルをそのコミットの代表値として扱います。ワーキングツリーもファイルごとに評価し、1つの `Working tree changes` として結果を返します。
- `Commits` の検索結果または青い `Open Commit Diff` を押すと、そのコミットで変更した全ファイルをVS Code標準の差分画面にまとめて開きます。検索に最も一致したファイルを先頭に表示し、検索フィルターで除外したファイルも含めて変更全体を確認できます。マージコミットは最初の親との差分を表示します。
- 結果内のファイル名を押すと、そのファイルだけの差分が開きます。`Hunks` の `Open Diff` は該当ファイル、`Branches` の `Open Best Diff` は最も一致したファイルを開きます。
- 検索入力は英語が基準です。同じ差分を再検索した場合は保存済み埋め込みを使います。
- `Semantic` はクエリと差分の埋め込みをL2正規化し、FAISSの `IndexFlatIP` でコサイン類似度を計算します。スコアは −1〜1 の値を小数3桁で表示し、候補集合内での再正規化は行いません。
- `Hybrid` はコサイン類似度と0〜1に正規化したBM25スコアを既定の重み0.6 / 0.4で合成します。`BM25` 単独の表示は正規化スコアの％、`Keyword` は一致を示す `Match` です。
- 旧L2インデックスは、保存済みの埋め込みからコサイン検索用に自動変換します。埋め込みの再計算や手動のキャッシュ削除は不要です。
- 言語選択は不要です。サイドバーの言語表示は参考情報であり、依存定義、lockファイル、YAML、拡張子なしファイルも検索できます。Markdownなどの文書は既定で除外され、設定から含められます。

### クエリの例

自然文で探すときは `Semantic` を選び、「何に対して、どんな動作を追加・修正したか」を短い英語で入力します。探したい変更に合わせて、次のように書けます。

| 探したい変更 | 入力例 |
|---|---|
| 必須項目がないリクエストを拒否する | `reject requests with missing required fields` |
| タイムアウトしたリクエストを再試行する | `retry requests after a timeout` |
| 認証トークンをログに出さないようにする | `redact authentication tokens from logs` |
| 入力が変わっていない場合にキャッシュを再利用する | `reuse cached results when the input has not changed` |
| 検索中の連打による重複リクエストを防ぐ | `prevent duplicate searches while a request is running` |
| テストで内部APIの利用を公開APIに置き換える | `replace private test helpers with public APIs` |

- 1つのクエリには1つの変更を記述します。例えば `fix bug` に「いつ・何が起きるか」を加え、`avoid crashing when the response body is empty` のようにします。
- 関数名・エラーメッセージ・HTTPメソッドなどが分かっていれば、その語も含めます。具体的な語で探す場合は `BM25` や `Keyword` も選べます。
- 変更内容からコミットを探すなら `Commits`、個々の差分箇所なら `Hunks`、その変更を含むブランチなら `Branches` を選びます。

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

`Settings` の `Commit history` からブランチと履歴のたどり方を選びます。FromとToの直接入力は同じ `Settings` 内の `Compare range` にあります。

- `Branch`: 1ブランチだけに絞ります。選択したブランチは To 入力より優先され、コミットツリーとdiff検索の両方に適用されます。
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

`Branches` では全ブランチを調べるため、従来のツリー用 `Branch`、`Max branches`、`History`、From / To の範囲指定は適用しません。履歴はマージ先のコミットもたどります。検索による checkout や fetch は行いません。

比較元に全コミットが取り込まれたブランチや、参照が削除されたブランチは結果に出ません。squash / rebase による取り込みはコミットIDが異なるため、同じ変更内容でも元ブランチが結果に残る場合があります。

### 検索中の操作とキャッシュ

検索中は Search ボタンと Enter による同じ検索の二重送信を防ぎます。検索文・比較元・検索単位・ファイル条件などを変更すると前の結果を消し、新しい条件で検索できます。変更前の結果・翻訳・エラーが遅れて届いても表示しません。同時に届いた検索や準備処理は順番に実行し、その間も進捗確認とキャンセルに応答します。

埋め込みは差分テキストとモデル設定をキーに保存するため、コミット追加後やサーバー再起動後も既存分を再利用できます。検索範囲・ファイル条件・検索単位を変更しても、実際にモデルへ渡す差分テキストが同じなら再計算しません。検索ステータスに `2 reused / 1 new embeddings` のように再利用分と新規計算分を表示します。従来のキャッシュも読み込み時に引き継ぎます。キャッシュは `Clear Cache` で削除できます。

## Flaskで試す

次のコマンドで `pallets/flask` を用意できます。このフォルダをVS Codeで直接開き、コミットツリーからFromとToを選ぶと、その範囲の差分を検索できます。

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
