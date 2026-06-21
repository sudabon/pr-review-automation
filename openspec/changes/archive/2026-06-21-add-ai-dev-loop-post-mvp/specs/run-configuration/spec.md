## MODIFIED Requirements

### Requirement: 設定ファイルのスキーマと読み込み
システムは `.ai-dev-loop/config.yml` を YAML として読み込み、スキーマ検証（zod 等）を行わなければならない（SHALL）。設定は最低限 `project`（name / package_manager / base_branch）、`agents`（main_reviewer / fixers / fixer_mode）、`limits`（max_loops / max_same_issue_repeats / stop_on_validation_failure / test_failure_degradation_limit / max_changed_files / max_diff_lines / lockfile_change_warn_lines / abnormal_diff_line_threshold）、`commands`（install / lint / typecheck / test / build）、`git`（use_worktree / commit_on_success / create_pr_on_success / pr_command）、`safety`（important_file_patterns）、`claude` / `codex` / `cursor`（command / timeout）の各セクションを表現できなければならない（SHALL）。`claude` には `review_timeout_sec` と `final_review_timeout_sec` を個別に設定できなければならない（SHALL）。

#### Scenario: 妥当な設定の読み込み
- **WHEN** スキーマに適合する `.ai-dev-loop/config.yml` が存在する状態で `run` を実行する
- **THEN** 設定が読み込まれ、型付きの設定オブジェクトとして後続処理に渡される

#### Scenario: 不正な設定の検出
- **WHEN** 必須フィールドが欠落、または型が不正な設定で `run` を実行する
- **THEN** どのフィールドが不正かを示すエラーを表示し、非ゼロ終了コードで終了する

### Requirement: 設定の既定値
設定ファイルで省略されたフィールドに対し、システムは妥当な既定値を適用しなければならない（SHALL）。既定値には少なくとも `limits.max_loops = 3`、`limits.max_same_issue_repeats = 2`、`limits.test_failure_degradation_limit = 2`、`limits.max_changed_files = 50`、`limits.max_diff_lines = 5000`、`limits.lockfile_change_warn_lines = 200`、`git.use_worktree = true`、`git.commit_on_success = true`、`git.create_pr_on_success = false`、`git.pr_command = "gh pr create --fill"`、`agents.fixer_mode = sequential`、`limits.stop_on_validation_failure = false` を含めなければならない（SHALL）。

#### Scenario: 省略フィールドへの既定適用
- **WHEN** `limits.max_loops` が設定ファイルに存在しない
- **THEN** 既定値 3 が適用される

#### Scenario: fixer_mode の既定
- **WHEN** `agents.fixer_mode` が設定ファイルに存在しない
- **THEN** 既定値 `sequential` が適用される

#### Scenario: stop_on_validation_failure の既定
- **WHEN** `limits.stop_on_validation_failure` が設定ファイルに存在しない
- **THEN** 既定値 `false` が適用される（原典仕様 §6 に準拠）
