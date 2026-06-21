## 1. 設定スキーマ拡張（run-configuration）

- [x] 1.1 `config/schema.ts` に `agents.fixer_mode`（sequential | failover）、`safety.important_file_patterns`、`limits.max_changed_files` / `max_diff_lines` / `lockfile_change_warn_lines`、`claude.review_timeout_sec` / `final_review_timeout_sec` を追加
- [x] 1.2 既定値を更新（`fixer_mode: sequential`、`stop_on_validation_failure: false`、`pr_command: gh pr create --fill`、安全策上限の既定）
- [x] 1.3 `init` 生成テンプレートに新キーを反映
- [x] 1.4 単体テスト（新キーの読み込み・既定値・不正値）

## 2. 安全策モジュール（safety-guards）

- [x] 2.1 `src/safety/loadIgnorePatterns.ts` — `.ai-dev-loopignore` 読み込みと既定パターン
- [x] 2.2 `src/safety/filterDiff.ts` — diff.patch の除外フィルタ適用
- [x] 2.3 `src/safety/checkSafetyLimits.ts` — 変更ファイル数・diff 行数・lockfile 警告・重要ファイル検出
- [x] 2.4 `src/safety/buildProjectSummary.ts` — `input/project-summary.md` 生成
- [x] 2.5 `collectDiff.ts` にフィルタ統合、フィルタ後空 diff の正常終了
- [x] 2.6 `runLoop.ts` に修正前安全策チェック（重要ファイル・blocker security）を組み込み
- [x] 2.7 単体テスト（ignore 除外・上限超過・重要ファイル検出・project-summary）

## 3. 成功判定とループ制御（loop-control）

- [x] 3.1 `src/loop/isSuccess.ts` — approved + validation.allPassed + major 以下 0 の判定ヘルパ
- [x] 3.2 `shouldContinue.ts` を更新（validation 失敗時の成功禁止、nit のみ終了、テスト連続悪化）
- [x] 3.3 `runLoop.ts` のコミット条件を `isSuccess` に置換
- [x] 3.4 `detectRepeatedIssues.ts` / loop-state に test 連続失敗カウンタを追加
- [x] 3.5 単体テスト（validation 失敗 + approved、nit のみ終了、テスト連続悪化）

## 4. 修正ランナー逐次実行と dry-run（automated-fixing）

- [x] 4.1 `runFix.ts` に `fixer_mode: sequential` 分岐（全 fixer 順次実行）
- [x] 4.2 `fixer_mode: failover` を MVP 互換として維持
- [x] 4.3 dry-run 時に `buildCodexFixPrompt` / `buildCursorFixPrompt` でプロンプト生成（CLI 未実行）
- [x] 4.4 単体テスト（sequential / failover / dry-run プロンプト生成）

## 5. 検証パイプライン拡張（validation-pipeline）

- [x] 5.1 `runValidation.ts` にループ 1 のみ `commands.install` 実行を追加
- [x] 5.2 `validation-result.json` に `allPassed` プロパティを追加
- [x] 5.3 単体テスト（install 初回のみ / allPassed 判定）

## 6. レビュー入力拡充（ai-review）

- [x] 6.1 `buildClaudeReviewPrompt.ts` に project-summary・設定ファイルパス・前回ループ要約を追加
- [x] 6.2 `buildClaudeFinalPrompt.ts` に safety-warnings・fixer 出力ログを追加
- [x] 6.3 `runClaudeReview.ts` / `runClaudeFinalReview.ts` で個別タイムアウト適用
- [x] 6.4 単体テスト（プロンプト入力の拡充確認）

## 7. CLI オーケストレーション（cli-orchestration）

- [x] 7.1 `writeCommandLog.ts` / `execWithTimeout.ts` に `step` フィールド追加
- [x] 7.2 各 runner から step 名を渡す（claude_review / codex_fix / cursor_fix / validation_* 等）
- [x] 7.3 `runLoop.ts` のランナー順序に安全策チェックを挿入
- [x] 7.4 単体テスト（command-log の step フィールド）

## 8. GitHub PR 連携（github-integration）

- [x] 8.1 `src/git/createPullRequest.ts` — `pr_command` 実行、本文にレビューサマリー追記
- [x] 8.2 `meta/pr-result.json` への結果記録（URL / スキップ理由）
- [x] 8.3 `runLoop.ts` コミット成功後に PR 作成を呼び出し
- [x] 8.4 単体テスト（gh モックでの PR 作成 / 未認証スキップ）

## 9. 統合検証とドキュメント

- [x] 9.1 統合テスト更新（post-MVP シナリオ全体）
- [x] 9.2 README に `fixer_mode`・安全策・PR 作成・`.ai-dev-loopignore` の説明を追加
- [x] 9.3 全 spec シナリオを満たすことを確認（lint/typecheck/test/build グリーン）
