## Why

Web アプリケーション開発では「コードレビュー → 修正 → 検証 → 再レビュー」の往復が手作業で繰り返され、時間とコンテキストスイッチのコストが大きい。`ai-dev-loop` は、サブスクリプション認証済みの Claude / Codex / Cursor の各 CLI をローカルプロセスとして制御し、このループを「制御された自動化」として実行する。API キー課金を避けつつ、worktree・ループ上限・機械的なテスト判定で暴走を防ぐことを狙う。

本 change は仕様書 `ai-dev-loop-implementation-spec.md` の §14「MVP スコープ」を対象とする。MVP 外の項目（Web UI / 複数リポジトリ / 並列実行 / 常駐実行 / Slack 通知 / GitHub Apps 化 / 自動マージ / 本番デプロイ）は本 change では扱わない。

## What Changes

- ローカル CLI ツール `ai-dev-loop` を新規実装する（Node.js + TypeScript）。
- `ai-dev-loop init` で対象リポジトリに `.ai-dev-loop/config.yml` を生成する。
- `ai-dev-loop run` で base ブランチとの差分に対してレビュー・修正ループを実行する。オプション: `--base` / `--target` / `--max-loops` / `--no-commit` / `--dry-run` / `--only-review` / `--resume`。
- 実行ごとに `.ai-dev-loop/runs/<run_id>/` を作成し、入力・レビュー・修正・検証・最終判定・メタ情報を全てファイルに保存する。
- Claude が初回レビューを担当し、`pr-review-toolkit:review-pr` プラグインでレビューを実施してレビューコメントと `review.json` を生成する。最終レビュー（判定 JSON 生成）も Claude が担当する。
- レビューコメントの修正は `fix-pr-comments` スキルで実施する。修正担当は 1 番手 Codex・2 番手 Cursor Agent の優先順とし、サブスクのトークン超過を検知した場合は自動で次の担当へ交代（フェイルオーバー）する。
- `lint` / `typecheck` / `test` / `build` を設定どおり順次実行し、結果を機械判定して `validation-result.json` に保存する。
- 最大ループ回数・同一指摘の連続検出・人間レビュー差し戻し条件に基づきループを制御する。
- 成功時（Claude 最終判定が `approved`）にコミットする（`--no-commit` 指定時は除く）。本番ブランチへの直接 push は行わない。

## Capabilities

### New Capabilities
- `cli-orchestration`: `ai-dev-loop` の CLI コマンド（`init` / `run`）とオプション、run ライフサイクル（Git 確認・worktree/一時ブランチ・run ディレクトリ作成・コマンドログ）、各ランナーの実行順序制御、成功時コミット、`--resume` による再開、`--dry-run` / `--only-review` モード。
- `run-configuration`: `.ai-dev-loop/config.yml` のスキーマ、読み込み、検証（zod）、既定値の適用。
- `ai-review`: Claude による初回レビュー（`pr-review-toolkit:review-pr` プラグインを使用）とレビューコメント/`review.json` の生成・検証、Claude による最終レビューと判定 JSON（`approved` / `needs_changes` / `human_review_required`）。
- `automated-fixing`: `fix-pr-comments` スキルによるコメント修正、修正担当の優先順位（1 番手 Codex / 2 番手 Cursor Agent）、トークン超過時の自動担当者交代（フェイルオーバー）、各エージェントの出力ログ保存。
- `validation-pipeline`: 設定された `lint` / `typecheck` / `test` / `build` コマンドの順次実行、ログ保存、`validation-result.json` への機械判定結果出力。
- `loop-control`: ループ継続・終了条件、同一指摘の連続検出、人間レビューへの差し戻し条件、最大ループ回数の適用、`loop-state.json` によるループ状態管理。

### Modified Capabilities
（既存 spec なし。新規プロジェクトのため変更対象の capability はない。）

## Impact

- 新規リポジトリ/パッケージとして `ai-dev-loop` CLI を構築（`src/` 配下に config / git / runners / prompts / loop / logs / utils を配置）。
- 想定依存: Commander.js または oclif、execa、zod、yaml、simple-git（または child_process）。
- 外部前提: 認証済みの `claude` / `codex` / `agent`(Cursor) CLI がローカルに存在すること。`pr-review-toolkit:review-pr` プラグインと `fix-pr-comments` スキルが利用可能であること。PR コメントの取得/解決に用いる `gh` CLI が認証済みであること。Git リポジトリであること。対象リポジトリ側に `lint` / `typecheck` / `test` / `build` の npm scripts が存在すること。
- 副作用: 対象リポジトリに `.ai-dev-loop/` ディレクトリと run 成果物を生成する。成功時に作業ブランチへコミットする（本番ブランチへの直接 push はしない）。
