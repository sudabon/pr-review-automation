## MODIFIED Requirements

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

### Requirement: dry-run 時の修正スキップ
`--dry-run` が指定された場合、システムは `fix-pr-comments` による修正（Codex / Cursor いずれの担当でも）を実行してはならない（SHALL NOT）。ただし Codex / Cursor 向けプロンプトファイル（`fix/codex-prompt.md`、`fix/cursor-prompt.md`）の生成は行わなければならない（SHALL）。

#### Scenario: dry-run でのプロンプト生成
- **WHEN** `--dry-run` を指定して実行する
- **THEN** `fix/codex-prompt.md` と `fix/cursor-prompt.md` が生成されるが、作業ツリーへの変更は適用されない

#### Scenario: dry-run での CLI 実行抑止
- **WHEN** `--dry-run` を指定して実行する
- **THEN** Codex / Cursor CLI は起動されない
