# validation-pipeline Specification

## Purpose
TBD - created by archiving change add-ai-dev-loop-mvp. Update Purpose after archive.
## Requirements
### Requirement: 検証コマンドの順次実行
システムは設定 `commands` の `lint` / `typecheck` / `test` / `build` を定義された順に実行しなければならない（SHALL）。各コマンドの標準出力・標準エラーを `validation/<name>.log` に保存しなければならない（SHALL）。設定でコマンドが未定義（空）の項目は実行せず `skipped` として扱わなければならない（SHALL）。

#### Scenario: 全コマンドの実行
- **WHEN** lint / typecheck / test / build がすべて設定されている
- **THEN** 各コマンドが順に実行され、対応する `validation/*.log` が生成される

#### Scenario: 未定義コマンドのスキップ
- **WHEN** `commands.build` が空である
- **THEN** build は実行されず、結果は `skipped` として記録される

### Requirement: 検証結果の機械判定
システムは各検証ステップの結果を `validation/validation-result.json` に保存しなければならない（SHALL）。各項目は `status`（passed | failed | skipped）と `exit_code`、失敗時は `log_path` を含めなければならない（SHALL）。終了コード 0 を `passed`、非ゼロを `failed` と判定しなければならない（SHALL）。

#### Scenario: 成功と失敗の判定
- **WHEN** lint が終了コード 0、typecheck が終了コード 1 で終了する
- **THEN** validation-result.json で lint は `passed`、typecheck は `failed` となり typecheck に `log_path` が記録される

### Requirement: 検証失敗時の継続方針
設定 `limits.stop_on_validation_failure` が true の場合、検証失敗時点でシステムはそのループの後続ステップ（最終レビュー）に失敗を伝え、ループ制御に判断を委ねなければならない（SHALL）。false の場合は検証失敗があっても最終レビューまで処理を継続しなければならない（SHALL）。

#### Scenario: 失敗時継続
- **WHEN** `stop_on_validation_failure` が false で typecheck が失敗する
- **THEN** 処理は最終レビューまで継続し、検証失敗は最終判定の入力として渡される

