## Why

`ai-dev-loop` の MVP（change `add-ai-dev-loop-mvp`）は CLI 土台・レビュー/修正/検証ループ・worktree 隔離・コミットまでを実装済みである。一方、原典仕様書 `ai-dev-loop-implementation-spec.md` の §7–23 には、安全策・除外ファイル・成功判定の厳格化・GitHub PR 連携・ループ制御の追加条件・レビュー入力の拡充など、MVP 後に実装すべき要件が残っている。これらを実装しないと、大規模 diff や重要ファイル変更の検知漏れ、validation 失敗時の誤コミット、PR 作成フローの手作業依存など、実運用でのリスクが残る。

## What Changes

- **安全策（§19–20）**: `.ai-dev-loopignore` によるレビュー入力除外、変更ファイル数・diff 行数の上限、lockfile 大規模変更の警告、重要ファイル（`.env` / migrations / infra 等）変更時の人間差し戻し、diff 絞り込み・ファイル分割
- **GitHub PR 連携（§23）**: `create_pr_on_success: true` 時に `gh pr create` を実行。PR 本文へ AI レビューサマリーを追記（将来拡張の第一歩）
- **成功判定の厳格化（§21）**: `approved` かつ validation 全 passed かつ blocker/critical/major 0 件を成功条件とする
- **ループ制御の補完（§11）**: `test_failure_degradation_limit` の実装、nit のみ残存時のループ継続禁止、修正前の高リスク変更の機械的検出
- **dry-run の計画出力（§7.2）**: 修正 CLI を実行せず Codex/Cursor 向けプロンプトファイルを生成
- **レビュー入力の拡充（§8, §16）**: `project-summary.md` 生成、package.json / 主要設定ファイルの添付、前回ループ結果の要約を次ループレビューに渡す
- **修正ランナーの逐次実行（§8.4–8.5）**: 毎ループ Codex → Cursor を連続実行（現状のフェイルオーバー専用から変更）
- **install コマンド実行（§9）**: validation 前に `commands.install` を任意実行
- **コマンドログの step フィールド（§22）**: `command-log.jsonl` に `step`（claude_review / codex_fix 等）を記録
- **Claude タイムアウト分離（§6）**: `review_timeout_sec` / `final_review_timeout_sec` を個別設定可能に

## Capabilities

### New Capabilities

- `safety-guards`: `.ai-dev-loopignore`、変更ファイル数・diff 行数上限、lockfile 警告、重要ファイル変更の人間差し戻し、diff 絞り込み
- `github-integration`: 成功時 PR 作成、`pr_command` 実行、PR 本文へのレビューサマリー追記

### Modified Capabilities

- `loop-control`: テスト連続悪化停止、nit のみでのループ継続禁止、成功条件に validation 合格を必須化
- `cli-orchestration`: dry-run 時の修正プロンプト生成、Codex→Cursor 逐次実行、install 実行、command-log の step フィールド
- `ai-review`: レビュー入力に project-summary・設定ファイル・前回ループ要約を含める
- `run-configuration`: 安全策関連の設定キー、Claude 個別タイムアウト、install 実行フラグ
- `automated-fixing`: フェイルオーバーに加え毎ループ Codex→Cursor 連続実行モード
- `validation-pipeline`: install コマンドの先行実行、成功判定との連携

## Impact

- 変更対象: `src/config/schema.ts`, `src/git/collectDiff.ts`, `src/loop/runLoop.ts`, `src/loop/shouldContinue.ts`, `src/runners/runFix.ts`, `src/runners/runValidation.ts`, `src/prompts/buildClaudeReviewPrompt.ts`, `src/logs/writeCommandLog.ts`, 新規 `src/safety/` または `src/git/filterDiff.ts`, `src/git/createPullRequest.ts`
- 既存 spec の delta を `openspec/changes/add-ai-dev-loop-post-mvp/specs/` に追加
- 既存テストの更新と新規テスト（安全策・PR 作成・成功判定）が必要
- **BREAKING**: Codex 成功時も Cursor を実行する挙動変更（`agents.fixers` の逐次実行が既定になる）。フェイルオーバーは維持しつつ、成功後も次の fixer を実行する
