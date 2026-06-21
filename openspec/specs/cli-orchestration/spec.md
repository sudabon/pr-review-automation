# cli-orchestration Specification

## Purpose
TBD - created by archiving change add-ai-dev-loop-mvp. Update Purpose after archive.
## Requirements
### Requirement: CLI コマンド体系
`ai-dev-loop` CLI は `init` と `run` の 2 つのサブコマンドを提供しなければならない（SHALL）。未知のコマンドや不正なオプションが渡された場合は、使用法を表示して非ゼロ終了コードで終了しなければならない（SHALL）。

#### Scenario: init コマンドの実行
- **WHEN** ユーザーが対象リポジトリで `ai-dev-loop init` を実行する
- **THEN** `.ai-dev-loop/config.yml` が存在しなければ既定設定で生成され、終了コード 0 で終了する

#### Scenario: 不正なコマンド
- **WHEN** ユーザーが未定義のサブコマンド（例 `ai-dev-loop foo`）を実行する
- **THEN** 使用法メッセージを表示し、非ゼロ終了コードで終了する

### Requirement: run コマンドのオプション
`run` コマンドは以下のオプションを受け付けなければならない（SHALL）: `--base`（比較元ブランチ）、`--target`（作業対象ブランチ）、`--max-loops`（最大ループ数）、`--no-commit`（成功時にコミットしない）、`--dry-run`（修正させずレビューと計画のみ）、`--only-review`（Claude レビューのみ）、`--resume <run_id>`（中断 run の再開）。オプション未指定時は設定ファイルの値、または既定値を用いなければならない（SHALL）。

#### Scenario: base 未指定時の既定
- **WHEN** ユーザーが `--base` を指定せず `ai-dev-loop run` を実行する
- **THEN** 設定ファイルの `git.base_branch`（既定 `main`）を比較元として用いる

#### Scenario: max-loops のオプション優先
- **WHEN** ユーザーが `--max-loops 1` を指定する
- **THEN** 設定ファイルの `limits.max_loops` より `--max-loops` の値が優先される

### Requirement: 実行前提条件の検証
`run` 実行時、システムはカレントディレクトリが Git リポジトリであることを確認しなければならない（SHALL）。Git リポジトリでない場合はエラーメッセージを表示し、非ゼロ終了コードで終了しなければならない（SHALL）。

#### Scenario: 非 Git ディレクトリでの実行
- **WHEN** Git リポジトリではないディレクトリで `ai-dev-loop run` を実行する
- **THEN** 「Git リポジトリではない」旨のエラーを表示し、処理を開始せず非ゼロ終了コードで終了する

### Requirement: run ライフサイクルの初期化
`run` の開始時、システムは一意な run ディレクトリ `.ai-dev-loop/runs/<run_id>/` を作成し、`input/` `review/` `fix/` `validation/` `final/` `meta/` のサブディレクトリを用意しなければならない（SHALL）。`run_id` はタイムスタンプ由来の一意な識別子でなければならない（SHALL）。設定で worktree が有効な場合は作業用 worktree または一時ブランチを作成しなければならない（SHALL）。

#### Scenario: run ディレクトリの作成
- **WHEN** `ai-dev-loop run` が初期化フェーズに入る
- **THEN** `.ai-dev-loop/runs/<run_id>/` 配下に input/review/fix/validation/final/meta の各サブディレクトリが作成される

#### Scenario: worktree 有効時
- **WHEN** 設定 `git.use_worktree` が true である
- **THEN** 作業用 worktree または一時ブランチが作成され、本番ブランチ上で直接修正されない

### Requirement: ランナー実行順序の制御
1 ループ内で、システムは「git 差分収集 → 安全策チェック → Claude レビュー → Cursor 修正 → Codex 修正 → 検証 → Claude 最終レビュー」の順にランナーを実行しなければならない（SHALL）。`agents.fixer_mode` が `sequential`（既定）の場合、設定 `agents.fixers` に列挙された全エージェントを順に実行しなければならない（SHALL）。`failover` の場合は先頭エージェントのみを実行し、トークン超過時に次へ交代する（MVP 互換）。`--only-review` 指定時は Claude レビューまでで停止しなければならない（SHALL）。`--dry-run` 指定時は修正 CLI を実行してはならないが、修正プロンプトファイルの生成は行わなければならない（SHALL）。

#### Scenario: 通常実行の順序（sequential）
- **WHEN** `fixer_mode` が sequential（既定）で 1 ループが実行される
- **THEN** 差分収集・安全策チェック・Claude レビュー・Cursor 修正・Codex 修正・検証・Claude 最終レビューがこの順序で実行される

#### Scenario: failover モード
- **WHEN** `fixer_mode` が failover で Cursor が正常完了する
- **THEN** Codex 修正はスキップされ、検証フェーズに進む

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

### Requirement: 中断した run の再開
`--resume <run_id>` が指定された場合、システムは該当 run ディレクトリの `meta/loop-state.json` を読み込み、中断したループから処理を再開しなければならない（SHALL）。指定した run_id が存在しない場合はエラーで終了しなければならない（SHALL）。

#### Scenario: 既存 run の再開
- **WHEN** `--resume 2026-06-16T10-00-00` を指定し、その run ディレクトリと loop-state.json が存在する
- **THEN** 保存されたループ状態から処理を再開する

#### Scenario: 存在しない run の再開
- **WHEN** 存在しない run_id を `--resume` に指定する
- **THEN** エラーメッセージを表示し非ゼロ終了コードで終了する

