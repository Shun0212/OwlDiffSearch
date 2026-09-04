# Flask diff-search evaluation

`pallets/flask` の実際の履歴を使い、検索クエリに対する結果の関連性を確認した記録です。

> この数値は、コミット内の全hunkを一括評価していた旧方式の記録です。現在の `Commits` は同一コミット・同一ファイルのdiff hunkをまとめ、ファイル別スコアの最大値を採用します。再評価するまでは参考値として扱ってください。

## Dataset

- Repository: `demo_repositories/flask`（READMEのclone手順で作成）
- Source: `https://github.com/pallets/flask.git`
- Clone: shallow clone, depth 50
- Range: `e4e4bf65 → d318b683`
- History in range: 29 commits
- Searchable Python changes: 41 hunks / 15 commit units
- Language: automatically detected as Python
- Reproduction: `HF_HUB_OFFLINE=1 model_server/.venv/bin/python scripts/analyze_flask_diff_search.py`

正解はクエリごとに関連するコミット件名のパターンを先に定義し、Top 5で最初に現れる順位を測定しました。検索対象テキストにはコミット件名を入れていないため、順位はdiff本文から計算されています。

## Results

明示的な語を含む次の3クエリは、Hunks / Commits と Semantic / Hybrid / BM25 の全組み合わせで正解が1位でした。

- `add an HTTP QUERY route decorator to the application`
- `correctly parse IPv6 server names and ports`
- `replace use of the private pytest monkeypatch fixture API`

語を直接書かない意図クエリの最初の正解順位は次の通りです。列内の順序は route / IPv6 / fixture API です。

| Search unit | Mode | First relevant ranks | Mean reciprocal rank |
|---|---|---:|---:|
| Hunks | Semantic | 2 / 1 / 1 | 0.833 |
| Hunks | Hybrid | 1 / 2 / 1 | 0.833 |
| Hunks | BM25 | 2 / 2 / 1 | 0.667 |
| Commits | Semantic | 1 / 1 / 1 | 1.000 |
| Commits | Hybrid | 2 / 2 / 1 | 0.667 |
| Commits | BM25 | 3 / 2 / 1 | 0.611 |

評価した意図クエリ:

- `let class-based views handle a newly supported HTTP method`
- `avoid breaking host addresses that contain several colon characters`
- `clean up tests to use public fixture helpers instead of internal state`

## Concrete examples

| Query and setup | Top result | Assessment |
|---|---|---|
| QUERY route, Hunks + Semantic | `89992954`, `src/flask/sansio/scaffold.py` | 正解。`query()` decorator本体を直接返した。 |
| IPv6 host intent, Commits + Semantic | `7203feab`, `Fix IPv6 server name parsing` | 正解。`IPv6`をクエリに書かなくても1位。 |
| Public fixture helper intent, Commits + Semantic | `5ce121dd`, monkeypatch API cleanup | 正解。`monkeypatch`をクエリに書かなくても1位。 |
| Class-based view intent, Hunks + Semantic | `8b4fd5d1`, `tests/test_views.py` | 誤り。`views`という局所的な語に引かれ、正解 `2a8a38b0` は2位。 |
| Class-based view intent, Commits + Semantic | `2a8a38b0`, `support query in methodview` | 正解。コミット全体の文脈で誤一致を解消。 |

## Interpretation

- 高水準の「何を変更したか」を探す場合は `Commits + Semantic` が最も安定しました。
- 実装上の具体的な変更行をすぐ開きたい場合は `Hunks + Semantic` または `Hunks + Hybrid` が向いています。
- 固有語が分かっている場合はBM25でも十分ですが、言い換えクエリでは順位が下がりました。
- Hybridは常にSemanticより良いわけではありません。一般語の一致が別のdiffを押し上げる場合があります。
- UIのスコアは候補集合内で正規化した相対値なので、異なるクエリ間で絶対値として比較できません。

## Try it in VS Code

1. VS Codeで `demo_repositories/flask` をフォルダとして開きます。
2. Owl Diff Searchを開くと `Detected languages: Python` と表示されます。
3. Baseに `e4e4bf65`、Headに `d318b683` を設定します。
4. `Commits` と `Semantic` を選び、上記の意図クエリを検索します。
