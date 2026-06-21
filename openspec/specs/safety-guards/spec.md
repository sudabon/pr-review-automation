# safety-guards Specification

## Purpose
TBD - created by archiving change add-ai-dev-loop-post-mvp. Update Purpose after archive.
## Requirements
### Requirement: 除外ファイル設定の読み込み
システムは対象リポジトリ直下の `.ai-dev-loopignore` を読み込み、レビュー入力（`input/diff.patch`）から除外パターンに一致するファイルを除かなければならない（SHALL）。ファイルが存在しない場合は、仕様書 §20 に記載の既定除外パターン（`node_modules/`、`dist/`、`*.lock` 等）を適用しなければならない（SHALL）。

#### Scenario: ignore ファイルによる除外
- **WHEN** `.ai-dev-loopignore` に `node_modules/` が記載され、diff に `node_modules/pkg/index.js` の変更が含まれる
- **THEN** フィルタ後の `input/diff.patch` から当該ファイルの変更が除外される

#### Scenario: ignore ファイル未存在時の既定パターン
- **WHEN** `.ai-dev-loopignore` が存在せず、diff に `package-lock.json` の変更が含まれる
- **THEN** 既定除外パターンにより lockfile の変更がレビュー入力から除外される

### Requirement: 変更規模の上限チェック
システムは各ループ開始時および修正後に、変更ファイル数と diff 行数を計測し、設定 `limits.max_changed_files` および `limits.max_diff_lines` を超過した場合、ループを停止しなければならない（SHALL）。超過時は `meta/loop-state.json` に停止理由を記録しなければならない（SHALL）。

#### Scenario: 変更ファイル数の超過
- **WHEN** 修正後の変更ファイル数が `limits.max_changed_files`（既定 50）を超える
- **THEN** ループを停止し、変更規模超過を理由として記録する

#### Scenario: diff 行数の超過
- **WHEN** `input/diff.patch` の行数が `limits.max_diff_lines`（既定 5000）を超える
- **THEN** ループを停止し、diff 行数超過を理由として記録する

### Requirement: lockfile 大規模変更の警告
システムは `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` の diff 行数が `limits.lockfile_change_warn_lines`（既定 200）を超える場合、警告を `meta/safety-warnings.json` に記録し、最終レビュー入力に含めなければならない（SHALL）。警告のみではループを停止してはならない（SHALL NOT）。

#### Scenario: lockfile 大規模変更の検知
- **WHEN** `package-lock.json` の diff が 300 行ある
- **THEN** `meta/safety-warnings.json` に lockfile 大規模変更の警告が記録され、最終レビューに渡される

### Requirement: 重要ファイル変更の人間差し戻し
システムは diff 対象パスが `safety.important_file_patterns`（既定: `.env`、`.env.*`、`database/migrations/`、`infra/`、`terraform/`、`.github/workflows/`、`auth/`、`payment/`）に一致する変更を検出した場合、修正フェーズに入る前に自動修正を停止し、`human_review_required` として終了しなければならない（SHALL）。

#### Scenario: 環境変数ファイルの変更検知
- **WHEN** diff に `.env.production` の変更が含まれる
- **THEN** 修正フェーズ前にループを停止し、人間レビューが必要である旨を記録する

#### Scenario: マイグレーションファイルの変更検知
- **WHEN** diff に `database/migrations/001_add_users.sql` の変更が含まれる
- **THEN** 修正フェーズ前にループを停止し、人間レビューが必要である旨を記録する

### Requirement: プロジェクトサマリーの生成
システムはループ開始時に `input/project-summary.md` を生成し、package.json の name/scripts/dependencies 概要と主要設定ファイル（`tsconfig.json`、`.eslintrc` 等、存在するもの）のパス一覧を含めなければならない（SHALL）。

#### Scenario: project-summary の生成
- **WHEN** ループが初期化フェーズに入る
- **THEN** `input/project-summary.md` が生成され、package.json の概要が含まれる

