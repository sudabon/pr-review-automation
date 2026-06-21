## ADDED Requirements

### Requirement: 設定ファイルのスキーマと読み込み
システムは `.ai-dev-loop/config.yml` を YAML として読み込み、スキーマ検証（zod 等）を行わなければならない（SHALL）。設定は最低限 `project`（name / package_manager / base_branch）、`agents`（main_reviewer / fixers）、`limits`（max_loops / max_same_issue_repeats / stop_on_validation_failure）、`commands`（install / lint / typecheck / test / build）、`git`（use_worktree / commit_on_success / create_pr_on_success / pr_command）、`claude` / `codex` / `cursor`（command / timeout）の各セクションを表現できなければならない（SHALL）。

#### Scenario: 妥当な設定の読み込み
- **WHEN** スキーマに適合する `.ai-dev-loop/config.yml` が存在する状態で `run` を実行する
- **THEN** 設定が読み込まれ、型付きの設定オブジェクトとして後続処理に渡される

#### Scenario: 不正な設定の検出
- **WHEN** 必須フィールドが欠落、または型が不正な設定で `run` を実行する
- **THEN** どのフィールドが不正かを示すエラーを表示し、非ゼロ終了コードで終了する

### Requirement: 設定の既定値
設定ファイルで省略されたフィールドに対し、システムは妥当な既定値を適用しなければならない（SHALL）。既定値には少なくとも `limits.max_loops = 3`、`limits.max_same_issue_repeats = 2`、`git.use_worktree = true`、`git.commit_on_success = true`、`git.create_pr_on_success = false` を含めなければならない（SHALL）。

#### Scenario: 省略フィールドへの既定適用
- **WHEN** `limits.max_loops` が設定ファイルに存在しない
- **THEN** 既定値 3 が適用される

### Requirement: 設定ファイルの未存在
`run` 実行時に `.ai-dev-loop/config.yml` が存在しない場合、システムは `ai-dev-loop init` の実行を促すエラーメッセージを表示し、非ゼロ終了コードで終了しなければならない（SHALL）。

#### Scenario: 設定未生成での run
- **WHEN** `.ai-dev-loop/config.yml` が存在しない状態で `ai-dev-loop run` を実行する
- **THEN** init を促すエラーを表示し、ループを開始せず非ゼロ終了コードで終了する

### Requirement: init による既定設定の生成
`ai-dev-loop init` は、対象リポジトリに既定値で埋めた `.ai-dev-loop/config.yml` を生成しなければならない（SHALL）。既に設定ファイルが存在する場合は上書きせず、その旨を通知しなければならない（SHALL）。

#### Scenario: 新規生成
- **WHEN** 設定ファイルが存在しない状態で `ai-dev-loop init` を実行する
- **THEN** 既定値の `.ai-dev-loop/config.yml` が生成される

#### Scenario: 既存設定の保護
- **WHEN** 既に `.ai-dev-loop/config.yml` が存在する状態で `ai-dev-loop init` を実行する
- **THEN** 既存ファイルは上書きされず、既に存在する旨が通知される
