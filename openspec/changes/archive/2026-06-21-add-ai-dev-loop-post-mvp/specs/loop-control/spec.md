## MODIFIED Requirements

### Requirement: ループ終了条件
以下のいずれかに該当する場合、システムはループを終了しなければならない（SHALL）: Claude 最終判定が `approved` かつ validation の lint / typecheck / test がすべて `passed`（build は設定時のみ必須）かつ blocker / critical / major の残課題が 0 件、最大ループ回数に到達、同一指摘が設定回数（既定 2 回）連続で残存、Git 差分が異常に大きくなる、テストが連続して悪化する、変更ファイル数または diff 行数が上限を超過する。

#### Scenario: 承認による終了
- **WHEN** Claude 最終判定が `approved` かつ validation がすべて passed かつ blocker / critical / major が 0 件である
- **THEN** ループを終了し、成功として扱う（コミット条件は cli-orchestration に従う）

#### Scenario: validation 失敗時は成功扱いしない
- **WHEN** Claude 最終判定が `approved` だが typecheck が `failed` である
- **THEN** ループを成功終了せず、継続条件または最大ループ到達で終了する

#### Scenario: 最大ループ到達
- **WHEN** ループ回数が max_loops に達しても成功条件を満たさない
- **THEN** ループを終了し、未承認のまま結果を記録する

## ADDED Requirements

### Requirement: テスト連続悪化の検出
システムは各ループの test 検証結果を追跡し、連続して失敗した回数が `limits.test_failure_degradation_limit`（既定 2）に達した場合、ループを停止しなければならない（SHALL）。

#### Scenario: テスト連続失敗による停止
- **WHEN** test が 2 ループ連続で `failed` となる
- **THEN** ループを停止し、テスト連続悪化を理由として記録する

#### Scenario: テスト成功でカウンタリセット
- **WHEN** test が 1 ループ失敗後、次ループで `passed` となる
- **THEN** 連続失敗カウンタがリセットされ、ループは継続可能である

### Requirement: nit のみ残存時のループ継続禁止
システムは `remaining_issues` に severity が nit のみが残存し、blocker / critical / major / minor が 0 件の場合、Claude 最終判定が `needs_changes` であっても次ループに進んではならない（SHALL NOT）。この場合は `approved` 相当の成功として扱い、コミット条件を満たせば成功終了しなければならない（SHALL）。

#### Scenario: nit のみ残存時の終了
- **WHEN** `remaining_issues` が nit severity のみ 2 件で、validation がすべて passed である
- **THEN** 次ループに進まず、成功として終了する

#### Scenario: major が残存する場合は継続
- **WHEN** `remaining_issues` に major が 1 件含まれる
- **THEN** nit のみ終了ルールは適用されず、継続条件に従う

### Requirement: 修正前の高リスク変更検出
認証・課金・外部サービス連携、DB マイグレーション、セキュリティ設計の変更、大規模な設計変更、仕様判断が必要な UI/UX 変更、本番データに影響する変更について、システムは safety-guards の重要ファイル検出に加え、review.json の category が `security` かつ severity が `blocker` のタスクが存在する場合、修正フェーズ前に `human_review_required` で停止しなければならない（SHALL）。

#### Scenario: blocker セキュリティ指摘での停止
- **WHEN** review.json に severity `blocker`、category `security` のタスクが存在する
- **THEN** 修正フェーズ前にループを停止し、人間レビューが必要である旨を記録する
