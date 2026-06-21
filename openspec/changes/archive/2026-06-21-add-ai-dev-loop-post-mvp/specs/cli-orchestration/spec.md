## MODIFIED Requirements

### Requirement: ランナー実行順序の制御
1 ループ内で、システムは「git 差分収集 → 安全策チェック → Claude レビュー → Codex 修正 → Cursor 修正 → 検証 → Claude 最終レビュー」の順にランナーを実行しなければならない（SHALL）。`agents.fixer_mode` が `sequential`（既定）の場合、設定 `agents.fixers` に列挙された全エージェントを順に実行しなければならない（SHALL）。`failover` の場合は先頭エージェントのみを実行し、トークン超過時に次へ交代する（MVP 互換）。`--only-review` 指定時は Claude レビューまでで停止しなければならない（SHALL）。`--dry-run` 指定時は修正 CLI を実行してはならないが、修正プロンプトファイルの生成は行わなければならない（SHALL）。

#### Scenario: 通常実行の順序（sequential）
- **WHEN** `fixer_mode` が sequential（既定）で 1 ループが実行される
- **THEN** 差分収集・安全策チェック・Claude レビュー・Codex 修正・Cursor 修正・検証・Claude 最終レビューがこの順序で実行される

#### Scenario: failover モード
- **WHEN** `fixer_mode` が failover で Codex が正常完了する
- **THEN** Cursor 修正はスキップされ、検証フェーズに進む

#### Scenario: only-review モード
- **WHEN** `--only-review` を指定して実行する
- **THEN** Claude レビュー（review.json 生成）までで停止し、修正・検証・最終レビューは実行されない

#### Scenario: dry-run モード
- **WHEN** `--dry-run` を指定して実行する
- **THEN** レビューと修正プロンプト（`fix/codex-prompt.md`、`fix/cursor-prompt.md`）が生成されるが、Codex / Cursor による修正は適用されない

### Requirement: コマンド実行ログの記録
システムは実行した外部コマンド（claude / codex / agent / git / 検証コマンド）を `meta/command-log.jsonl` に追記形式で記録しなければならない（SHALL）。各エントリには `step`（claude_review / codex_fix / cursor_fix / validation_lint / validation_test / git_commit / pr_create 等）、`command`、開始時刻、終了コード、実行時間（`duration_ms`）を含めなければならない（SHALL）。

#### Scenario: 外部コマンドの記録
- **WHEN** Claude レビューコマンドが実行される
- **THEN** `step: claude_review` を含むエントリが `meta/command-log.jsonl` に 1 行追記される

### Requirement: 成功時のコミット
Claude 最終判定が `approved` かつ validation の lint / typecheck / test がすべて `passed` かつ blocker / critical / major が 0 件で、かつ `--no-commit` が指定されていない場合、システムは作業ブランチに変更をコミットしなければならない（SHALL）。コミット成功後、設定 `git.create_pr_on_success` が true の場合は github-integration の PR 作成要件に従わなければならない（SHALL）。本番ブランチへの直接 push を行ってはならない（SHALL NOT）。

#### Scenario: 承認時のコミット
- **WHEN** 成功条件をすべて満たし `--no-commit` 未指定
- **THEN** 作業ブランチへコミットされ、本番ブランチへ直接 push されない

#### Scenario: validation 失敗時はコミットしない
- **WHEN** Claude 最終判定が `approved` だが test が `failed` である
- **THEN** コミットは行われない

#### Scenario: no-commit 指定
- **WHEN** `--no-commit` を指定して実行し成功条件を満たす
- **THEN** コミットは行われず、変更は作業ツリー上に残る
