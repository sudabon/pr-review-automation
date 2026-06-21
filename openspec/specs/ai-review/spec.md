# ai-review Specification

## Purpose
TBD - created by archiving change add-ai-dev-loop-mvp. Update Purpose after archive.
## Requirements
### Requirement: Git 差分の収集
Claude レビューの前段として、システムは `--base` と作業対象との差分を `git diff` で取得し `input/diff.patch` に、`git status` を `input/status.txt` に保存しなければならない（SHALL）。差分が空の場合はレビューを実行せず、その旨を記録して正常終了しなければならない（SHALL）。

#### Scenario: 差分の保存
- **WHEN** base と作業対象の間に差分がある状態でループが開始される
- **THEN** `input/diff.patch` と `input/status.txt` が生成される

#### Scenario: 差分が空
- **WHEN** base と作業対象の間に差分がない
- **THEN** レビューを実行せず、差分なしを記録して正常終了する

### Requirement: Claude 初回レビューの実行
システムは Claude CLI を起動し、`pr-review-toolkit:review-pr` プラグイン（`/review-pr` コマンド）を用いてレビューを実施しなければならない（SHALL）。入力は git diff・git status・主要設定ファイル（対象 PR が存在する場合はその PR 情報）とする。レビュー観点にはバグ・セキュリティ・型安全性・テスト不足・可読性・設計上の問題・破壊的変更・過剰実装を含めなければならない（SHALL）。出力として Markdown レビューを `review/claude-review.md` に、レビューコメント由来の構造化タスクを `review/review.json` に保存しなければならない（SHALL）。

#### Scenario: レビュー成果物の生成
- **WHEN** `pr-review-toolkit:review-pr` によるレビューが正常に完了する
- **THEN** `review/claude-review.md` と `review/review.json` が生成され、レビューコメントが修正フェーズへ渡される

#### Scenario: Claude CLI の失敗
- **WHEN** Claude CLI が非ゼロ終了コードで終了する、またはタイムアウトする
- **THEN** エラーを記録し、当該ループを失敗として扱う

### Requirement: review.json のスキーマ検証
システムは `review/review.json` が定義スキーマに適合することを検証しなければならない（SHALL）。各タスクは `id` / `severity`（blocker | critical | major | minor | nit）/ `category`（bug | security | type | test | refactor | design | docs）/ `title` / `description` / `files` / `suggested_fix` / `acceptance_criteria` を含み、トップレベルに `summary` と `overall_risk`（low | medium | high）を含まなければならない（SHALL）。スキーマ不適合の場合はエラーとして扱わなければならない（SHALL）。

#### Scenario: 妥当な review.json
- **WHEN** Claude が生成した `review.json` がスキーマに適合する
- **THEN** 検証に成功し、修正フェーズへタスクが渡される

#### Scenario: 不正な review.json
- **WHEN** `review.json` の severity が許可値以外、または必須フィールドが欠落している
- **THEN** スキーマ検証に失敗し、当該ループを失敗として扱う

### Requirement: Claude 最終レビューと判定
修正・検証の後、システムは Claude に初回レビュー・修正後 diff・`validation-result.json`・各 AI の出力ログを渡して最終レビューを依頼しなければならない（SHALL）。最終判定は `final/claude-final-review.md` と `final/final-result.json` に保存し、`final-result.json` の `decision` は `approved` / `needs_changes` / `human_review_required` のいずれかでなければならない（SHALL）。判定には `remaining_issues` と `reason` を含めなければならない（SHALL）。

#### Scenario: 承認判定
- **WHEN** 修正後に残課題が無く検証が通っている
- **THEN** `final-result.json` の decision が `approved` となり、最終レビュー成果物が保存される

#### Scenario: 要修正判定
- **WHEN** blocker / critical / major の残課題があり、または検証が失敗している
- **THEN** decision が `needs_changes` となり、remaining_issues に残課題が列挙される

