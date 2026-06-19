## 1. プロジェクト基盤

- [x] 1.1 Node.js + TypeScript プロジェクトを初期化（package.json / tsconfig / ビルド設定）
- [x] 1.2 依存追加（commander, execa, zod, yaml, simple-git もしくは child_process 方針確定）
- [x] 1.3 `src/` のディレクトリ構成を作成（config / git / runners / prompts / loop / logs / utils / cli.ts / index.ts）
- [x] 1.4 共有ユーティリティ実装（`utils/execWithTimeout.ts`, `utils/safeJsonParse.ts`）
- [x] 1.5 lint / typecheck / test の自前 CI スクリプトを整備（自己適用できる状態にする）

## 2. 設定（run-configuration）

- [x] 2.1 config スキーマを zod で定義（`config/schema.ts`: project / agents / limits / commands / git / claude / codex / cursor）
- [x] 2.2 既定値の定義と適用（max_loops=3, max_same_issue_repeats=2, use_worktree=true, commit_on_success=true, create_pr_on_success=false）
- [x] 2.3 `config/loadConfig.ts` 実装（YAML 読み込み・検証・不正フィールドの明示エラー）
- [x] 2.4 設定未存在時に init を促すエラーで終了する処理
- [x] 2.5 単体テスト（妥当な設定 / 必須欠落 / 型不正 / 既定値適用）
- [x] 2.6 修正担当のフェイルオーバー設定（`agents.fixers` の優先順、トークン超過検知パターン）をスキーマ/既定に追加

## 3. CLI とランディング（cli-orchestration: コマンド/オプション）

- [x] 3.1 `cli.ts` で commander により `init` / `run` を定義
- [x] 3.2 `run` のオプション実装（--base / --target / --max-loops / --no-commit / --dry-run / --only-review / --resume）とオプション優先順位（CLI > 設定 > 既定）
- [x] 3.3 `init` コマンド実装（既定 config 生成・既存ファイルは上書きせず通知）
- [x] 3.4 不正コマンド/オプション時の使用法表示と非ゼロ終了
- [x] 3.5 単体テスト（init 新規生成 / 既存保護 / オプション解釈 / 不正コマンド）

## 4. run ライフサイクルと差分収集（cli-orchestration + ai-review 差分部）

- [x] 4.1 Git リポジトリ判定と前提チェック（claude/codex/agent CLI の存在確認）
- [x] 4.2 run_id 採番と run ディレクトリ作成（`logs/createRunDirectory.ts`: input/review/fix/validation/final/meta）
- [x] 4.3 worktree/一時ブランチ作成（`git/createWorktree.ts`、use_worktree に従う）
- [x] 4.4 差分収集（`git/collectDiff.ts`: diff.patch / status.txt 保存、差分が空なら正常終了）
- [x] 4.5 コマンド実行ログ（`logs/writeCommandLog.ts`: command-log.jsonl にコマンド/開始時刻/終了コード追記）
- [x] 4.6 単体テスト（非 Git ディレクトリ / 差分なし / ディレクトリ生成 / ログ追記）

## 5. Claude レビュー（ai-review）

- [x] 5.1 初回レビュー起動の実装（`prompts/buildClaudeReviewPrompt.ts` + `pr-review-toolkit:review-pr`(/review-pr) を Claude CLI から実行、観点と制約を反映）
- [x] 5.2 Claude レビューランナー（`runners/runClaudeReview.ts`: claude CLI 起動・/review-pr 実行・タイムアウト・claude-review.md / review.json / レビューコメント保存）
- [x] 5.3 review.json の zod スキーマと検証（summary / overall_risk / tasks[] の各フィールド・severity/category 列挙）
- [x] 5.4 Claude CLI 失敗・スキーマ不適合を当該ループ失敗として扱う処理
- [x] 5.5 単体テスト（成果物生成 / 妥当な review.json / 不正 severity / CLI 失敗）

## 6. 自動修正（automated-fixing）

- [x] 6.1 fix-pr-comments スキル連携（レビューコメント/review.json を入力に修正を駆動する `runners/runFix.ts` のコア）
- [x] 6.2 修正担当の優先順位制御（`agents.fixers` 順、既定 Codex→Cursor、先頭を active fixer に）
- [x] 6.3 トークン超過の検知（`utils/detectTokenLimit.ts`: CLI 終了コード/標準エラーのパターン判定）
- [x] 6.4 自動担当者交代（active fixer が超過時に次の担当へフェイルオーバー、未対応コメントから継続、交代を記録）
- [x] 6.5 全担当超過時に修正停止＋人間差し戻し（loop-control と連携）
- [x] 6.6 Codex 修正ランナー（`runners/runCodexFix.ts` + `prompts/buildCodexFixPrompt.ts`: codex-prompt.md / codex-output.md・制約・タイムアウト）
- [x] 6.7 Cursor 修正ランナー（`runners/runCursorFix.ts` + `prompts/buildCursorFixPrompt.ts`: print モード・適用フラグ・cursor-prompt.md / cursor-output.md・タイムアウト）
- [x] 6.8 `--dry-run` 時に修正をスキップする分岐
- [x] 6.9 単体テスト（fix-pr-comments 連携 / 優先順位 / トークン超過検知 / 自動交代 / 全超過時停止 / dry-run スキップ）

## 7. 検証（validation-pipeline）

- [x] 7.1 検証ランナー（`runners/runValidation.ts`: lint→typecheck→test→build を順次実行、各 log 保存）
- [x] 7.2 未定義コマンドの skipped 扱い
- [x] 7.3 validation-result.json 生成（status / exit_code / log_path、終了コードで passed/failed 判定）
- [x] 7.4 stop_on_validation_failure の継続方針反映
- [x] 7.5 単体テスト（成功/失敗判定 / skipped / 継続方針）

## 8. 最終レビューとループ制御（ai-review + loop-control）

- [x] 8.1 最終レビュー用プロンプト生成（`prompts/buildClaudeFinalPrompt.ts`: 初回レビュー/修正後 diff/validation-result/各ログを入力）
- [x] 8.2 最終レビューランナー（`runners/runClaudeFinalReview.ts`: claude-final-review.md / final-result.json 保存）
- [x] 8.3 final-result.json の zod スキーマ（decision: approved/needs_changes/human_review_required, remaining_issues, reason）
- [x] 8.4 継続/終了判定（`loop/shouldContinue.ts`: 継続条件・終了条件）
- [x] 8.5 同一指摘の連続検出（`loop/detectRepeatedIssues.ts`、max_same_issue_repeats で停止）
- [x] 8.6 人間差し戻し判定（human_review_required・対象カテゴリでの停止）
- [x] 8.7 ループ状態の永続化（`loop/runLoop.ts` + meta/loop-state.json）
- [x] 8.8 `--resume` による状態復元と再開（存在しない run_id はエラー）
- [x] 8.9 単体テスト（継続/終了条件 / 同一指摘停止 / 差し戻し / resume）

## 9. 仕上げ（cli-orchestration: コミット）と統合検証

- [x] 9.1 成功時コミット（`git/commitChanges.ts`: approved かつ --no-commit 未指定時のみ、本番ブランチへ push しない）
- [x] 9.2 `--only-review` で Claude レビューまでで停止する全体分岐の結線
- [x] 9.3 全 runner を結ぶ `loop/runLoop.ts` の統合（順序制御・1ループ→判定→次ループ）
- [x] 9.4 統合テスト（外部 CLI をモックして 1〜3 ループのフローを検証）
- [x] 9.5 README とコマンド実行例（init / run / --only-review / --resume）を整備
- [x] 9.6 全 spec のシナリオを満たすことを確認（lint/typecheck/test/build をグリーンにする）
