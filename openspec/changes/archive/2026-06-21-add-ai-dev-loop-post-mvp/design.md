## Context

`ai-dev-loop` MVP は `add-ai-dev-loop-mvp` change で実装済み。CLI・設定・Git worktree・Claude レビュー・Codex/Cursor 修正（フェイルオーバー型）・検証・ループ制御・コミットまで動作する。原典 `ai-dev-loop-implementation-spec.md` §7–23 のうち、安全策（§19–20）、PR 連携（§23）、成功判定の厳格化（§21）、ループ制御の未実装項目（§11）、レビュー入力拡充（§8, §16）、修正ランナーの逐次実行（§8.4–8.5）が残っている。

現状の既知ギャップ:
- `create_pr_on_success` / `pr_command` はスキーマのみで未使用
- `test_failure_degradation_limit` はスキーマのみで未使用
- `.ai-dev-loopignore` は未実装
- `approved` 単独で成功扱いとなり validation 失敗を見逃す可能性
- Codex 成功時は Cursor をスキップ（仕様は毎ループ連続実行）

## Goals / Non-Goals

**Goals:**
- 原典仕様 §19–20 の安全策を機械的に適用し、暴走・誤コミットを防ぐ
- §23 の PR 作成を `create_pr_on_success` で有効化できるようにする
- §21 の成功条件（validation 全 passed + approved + major 以下 0）をプログラムで強制する
- §11 のテスト連続悪化停止・nit のみ継続禁止を実装する
- レビュー品質向上のため入力コンテキスト（project-summary、前回ループ要約）を拡充する
- Codex → Cursor の逐次実行を既定とし、フェイルオーバーも維持する

**Non-Goals:**
- GitHub Actions 上での実行、Slack 通知、PR コメント自動返信（§26 将来拡張）
- Web UI、複数リポジトリ、並列実行
- 本番ブランチへの push、自動マージ
- Playwright E2E、スクリーンショット差分レビュー

## Decisions

### D1: 安全策モジュールを `src/safety/` に集約
- **採用**: `loadIgnorePatterns.ts`（`.ai-dev-loopignore` 読み込み）、`filterDiff.ts`（除外パターン適用）、`checkSafetyLimits.ts`（ファイル数・行数・lockfile・重要ファイル）を新設
- **理由**: `collectDiff.ts` とループ制御の両方から参照する横断関心事を一箇所にまとめる
- **代替案**: `git/` 配下に配置 → 安全策は Git 以外（レビュー入力）にも及ぶため不採用

### D2: `.ai-dev-loopignore` は gitignore 互換の glob
- **採用**: 1 行 1 パターン、仕様書 §20 の既定パターンを `init` 時にテンプレート生成（任意）
- **理由**: 開発者が既知の gitignore 形式で除外を定義できる
- **代替案**: config.yml 内に配列 → リポジトリごとの慣習に合わせファイル分離の方が自然

### D3: 重要ファイル変更は修正前に機械検出
- **採用**: diff 対象パスを `safety.important_file_patterns`（既定: `.env*`, `**/migrations/**`, `infra/**`, `terraform/**`, `.github/workflows/**`, `auth/**`, `payment/**`）と照合。一致時は `human_review_required` で即停止
- **理由**: §11.3 の「修正前停止」をプロンプト依存から脱却
- **代替案**: 最終レビューのみ → 修正が既に適用された後になり遅い

### D4: 成功条件は `shouldContinue` と `runLoop` の両方で検証
- **採用**: `isSuccess(finalReview, validation, review)` ヘルパを導入。`approved` かつ `validation.allPassed` かつ `!hasImportantIssues(remaining_issues)` の 3 条件を満たす場合のみ成功コミット/PR
- **理由**: §25 疑似コードの `validation.allPassed` チェックを復元
- **代替案**: Claude 判定のみ → validation 失敗時の誤コミットリスクが残る

### D5: Codex → Cursor 逐次実行 + フェイルオーバー併用
- **採用**: `agents.fixer_mode: sequential | failover` を追加。既定 `sequential` で全 fixer を順に実行。`failover` は MVP 互換（先頭のみ、超過時交代）
- **理由**: 仕様 §8.4–8.5 と MVP 既存挙動の両立
- **代替案**: 逐次のみ → 既存ユーザーへの破壊的変更が大きい

### D6: PR 作成は `src/git/createPullRequest.ts`
- **採用**: コミット成功後、`create_pr_on_success` かつ `gh` 利用可能時に `pr_command` を実行。本文は `final/claude-final-review.md` の要約を `--body` に追記（`--fill` との併用は shell 展開で対応）
- **理由**: 設定済みだが未使用の `git.pr_command` を活用
- **代替案**: 常に `gh pr create --fill` 固定 → 設定の意味がなくなる

### D7: dry-run はプロンプト生成まで実行
- **採用**: `--dry-run` 時も `buildCodexFixPrompt` / `buildCursorFixPrompt` を呼び `fix/codex-prompt.md` / `fix/cursor-prompt.md` を生成。CLI 実行と作業ツリー変更はスキップ
- **理由**: §7.2「レビューと計画だけ」の意図に合致

### D8: command-log に `step` フィールド追加（後方互換）
- **採用**: 新フィールド `step` を追加。既存 `started_at` / `ended_at` は維持
- **理由**: §22 仕様への近似。既存ログパーサへの影響を最小化

### D9: Claude タイムアウト分離
- **採用**: `claude.review_timeout_sec` / `claude.final_review_timeout_sec` を追加。未指定時は `claude.timeout_sec` にフォールバック
- **理由**: 初回レビューと最終レビューで所要時間が異なるため

## Risks / Trade-offs

- **逐次実行によるコスト増** → `fixer_mode: failover` で MVP 互換を維持。ループ上限で総コストを抑制
- **安全策の誤検知（重要ファイルパターン）** → パターンを設定で上書き可能にし、誤検知時は `human_review_required` で人間が判断
- **PR 本文生成の複雑さ** → 第一版はレビューサマリーの追記のみ。チェックリスト化は将来拡張
- **`.ai-dev-loopignore` と git diff の整合** → diff 生成後にフィルタを適用し、フィルタ後が空なら「差分なし」扱い
- **BREAKING: sequential が既定** → `fixer_mode` 明示で旧挙動に戻せる。README に移行ガイドを記載

## Migration Plan

1. 安全策モジュールと設定キーを追加（既存 config は既定値で動作継続）
2. `shouldContinue` / 成功判定を更新し、既存テストを修正
3. `runFix.ts` に sequential モードを追加、`fixer_mode` 既定を sequential に
4. PR 作成・dry-run プロンプト・レビュー入力拡充を順次実装
5. 統合テストで全 spec シナリオを検証
6. ロールバック: `fixer_mode: failover` に戻す、`create_pr_on_success: false` のまま

## Open Questions

- `commands.install` を毎ループ実行するか初回のみか（第一版: ループ 1 の validation 前のみ）
- diff ファイル分割の閾値（第一版: `safety.max_diff_lines` 超過時は警告のみ、分割は将来）
- PR 本文テンプレートの詳細（サマリー + remaining_issues チェックリストを含めるか）
