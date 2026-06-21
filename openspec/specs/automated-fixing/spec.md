# automated-fixing Specification

## Purpose
TBD - created by archiving change add-ai-dev-loop-mvp. Update Purpose after archive.
## Requirements
### Requirement: fix-pr-comments スキルによる修正
システムは、レビューで生成されたコメント（`pr-review-toolkit:review-pr` が付与したコメントおよび `review/review.json`）を入力として、`fix-pr-comments` スキルを用いて修正を実施しなければならない（SHALL）。修正対象は severity が blocker / critical / major のものを優先しなければならない（SHALL）。

#### Scenario: コメントに基づく修正
- **WHEN** review.json の検証に成功し修正フェーズに入る
- **THEN** `fix-pr-comments` スキルがレビューコメントを入力として起動され、重要度の高い指摘から修正が適用される

### Requirement: 修正担当エージェントの優先順位
修正担当エージェントは設定 `agents.fixers` の並び順で優先順位を持ち、既定は 1 番手 Codex・2 番手 Cursor Agent でなければならない（SHALL）。`agents.fixer_mode` が `sequential`（既定）の場合、各ループで fixers 配列の全エージェントを順に実行しなければならない（SHALL）。`failover` の場合は先頭エージェントのみを active fixer として実行し、トークン超過時に次へ交代する（SHALL）。

#### Scenario: sequential モードでの全担当実行
- **WHEN** `fixer_mode` が sequential で修正フェーズが開始される
- **THEN** Codex 修正の後に Cursor 修正が実行される

#### Scenario: failover モードでの先頭のみ実行
- **WHEN** `fixer_mode` が failover で Codex が正常完了する
- **THEN** Cursor は実行されない

#### Scenario: 既定の担当順
- **WHEN** 修正フェーズが開始され `agents.fixers` が未指定（既定）である
- **THEN** Codex が 1 番手、Cursor Agent が 2 番手として順に実行される（sequential 時）

### Requirement: トークン超過時の自動担当者交代
active fixer の CLI がサブスクリプションのトークン超過（クォータ超過・レート上限）を示した場合、システムは自動的に優先順位の次のエージェントへ担当を交代（フェイルオーバー）し、未対応のコメントから修正を継続しなければならない（SHALL）。担当交代の事実（交代元・交代先・時刻・理由）を run の記録（`meta/loop-state.json` または `meta/command-log.jsonl`）に残さなければならない（SHALL）。優先順位の全エージェントがトークン超過に達した場合、システムは修正を停止し、人間レビューへ差し戻さなければならない（SHALL）。

#### Scenario: Codex のトークン超過で Cursor へ交代
- **WHEN** active fixer の Codex がトークン超過を示す
- **THEN** 担当が自動的に Cursor Agent へ交代し、未対応コメントの修正が継続され、交代が記録される

#### Scenario: 全担当がトークン超過
- **WHEN** Codex と Cursor の両方がトークン超過に達する
- **THEN** 修正を停止し、人間レビューへ差し戻す（loop-control の差し戻し条件に従う）

### Requirement: Codex 修正ランナーの実行
Codex が active fixer の場合、システムは Codex CLI を起動し、`fix-pr-comments` の指示・レビューコメント・`review.json` を渡して修正を適用しなければならない（SHALL）。Codex 向けプロンプトを `fix/codex-prompt.md` に、出力サマリーを `fix/codex-output.md` に保存しなければならない（SHALL）。プロンプトには「既存仕様を壊さない」「変更は最小限」「blocker / critical / major を優先」「必要なテストを追加」「無関係なリファクタリングをしない」「修正できなかった項目は理由を書く」の制約を含めなければならない（SHALL）。設定の `codex.timeout_sec` を超えた場合はタイムアウトとして処理を打ち切らなければならない（SHALL）。

#### Scenario: Codex による修正
- **WHEN** Codex が active fixer として正常に完了する
- **THEN** 作業ツリーに修正が適用され、`fix/codex-prompt.md` と `fix/codex-output.md` が保存される

#### Scenario: タイムアウト
- **WHEN** Codex の実行が `codex.timeout_sec` を超える
- **THEN** 実行を打ち切り、タイムアウトを記録して当該ループを失敗扱いにする

### Requirement: Cursor 修正ランナーの実行
Cursor が active fixer（トークン超過による交代後、または設定で先頭）の場合、システムは Cursor CLI Agent を print モード（非対話）で起動し、`fix-pr-comments` の指示・未対応コメント・修正後 diff を渡して修正を適用しなければならない（SHALL）。変更適用には設定された適用フラグ（例 `--force`）を用い、プロンプトを `fix/cursor-prompt.md`、出力を `fix/cursor-output.md` に保存しなければならない（SHALL）。設定の `cursor.timeout_sec` を超えた場合はタイムアウトとして処理を打ち切らなければならない（SHALL）。

#### Scenario: Cursor による修正
- **WHEN** Cursor が active fixer として実行される
- **THEN** 未対応コメントに対する修正が適用され、`fix/cursor-prompt.md` と `fix/cursor-output.md` が保存される

### Requirement: dry-run 時の修正スキップ
`--dry-run` が指定された場合、システムは `fix-pr-comments` による修正（Codex / Cursor いずれの担当でも）を実行してはならない（SHALL NOT）。ただし Codex / Cursor 向けプロンプトファイル（`fix/codex-prompt.md`、`fix/cursor-prompt.md`）の生成は行わなければならない（SHALL）。

#### Scenario: dry-run でのプロンプト生成
- **WHEN** `--dry-run` を指定して実行する
- **THEN** `fix/codex-prompt.md` と `fix/cursor-prompt.md` が生成されるが、作業ツリーへの変更は適用されない

#### Scenario: dry-run での CLI 実行抑止
- **WHEN** `--dry-run` を指定して実行する
- **THEN** Codex / Cursor CLI は起動されない

