# loop-control Specification

## Purpose
TBD - created by archiving change add-ai-dev-loop-mvp. Update Purpose after archive.
## Requirements
### Requirement: ループ継続条件
1 ループ完了後、以下のいずれかに該当する場合、システムは次ループへ進まなければならない（SHALL）: Claude 最終判定が `needs_changes`、lint / typecheck / test のいずれかが失敗、blocker / critical / major の指摘が残っている。

#### Scenario: needs_changes による継続
- **WHEN** Claude 最終判定が `needs_changes` で、かつ終了条件に該当しない
- **THEN** 次のループが開始される

#### Scenario: 重要指摘の残存による継続
- **WHEN** blocker / critical / major の指摘が残っており、かつ終了条件に該当しない
- **THEN** 次のループが開始される

### Requirement: ループ終了条件
以下のいずれかに該当する場合、システムはループを終了しなければならない（SHALL）: Claude 最終判定が `approved`、最大ループ回数に到達、同一指摘が設定回数（既定 2 回）連続で残存、Git 差分が異常に大きくなる、テストが連続して悪化する。

#### Scenario: 承認による終了
- **WHEN** Claude 最終判定が `approved` になる
- **THEN** ループを終了し、成功として扱う（コミット条件は cli-orchestration に従う）

#### Scenario: 最大ループ到達
- **WHEN** ループ回数が max_loops に達しても `approved` にならない
- **THEN** ループを終了し、未承認のまま結果を記録する

### Requirement: 同一指摘の連続検出
システムは各ループの残課題を比較し、同一指摘が連続して残存する回数を追跡しなければならない（SHALL）。同一指摘が `limits.max_same_issue_repeats`（既定 2）連続で残った場合、ループを停止しなければならない（SHALL）。

#### Scenario: 同一指摘の連続による停止
- **WHEN** 同一の指摘が 2 ループ連続で remaining_issues に残る
- **THEN** これ以上の自動修正は無効と判断し、ループを停止する

### Requirement: 人間レビューへの差し戻し
以下のいずれかに該当する修正が必要と判断された場合、システムは自動修正を停止し人間レビューへ差し戻さなければならない（SHALL）: 認証・課金・外部サービス連携、DB マイグレーション、セキュリティ設計の変更、大規模な設計変更、仕様判断が必要な UI/UX 変更、本番データに影響する変更。Claude 最終判定が `human_review_required` の場合もループを停止しなければならない（SHALL）。

#### Scenario: human_review_required による停止
- **WHEN** Claude 最終判定が `human_review_required` になる
- **THEN** 自動修正を停止し、人間レビューが必要である旨を記録して終了する

### Requirement: ループ状態の永続化
システムは各ループの状態（現在のループ番号・最終判定・残課題・継続/終了の判断）を `meta/loop-state.json` に保存しなければならない（SHALL）。これにより `--resume` での再開を可能にしなければならない（SHALL）。

#### Scenario: ループ状態の保存
- **WHEN** 1 ループが完了する
- **THEN** 現在のループ番号と判定結果が `meta/loop-state.json` に反映される

