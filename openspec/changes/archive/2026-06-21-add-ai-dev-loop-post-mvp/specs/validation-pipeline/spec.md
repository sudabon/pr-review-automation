## MODIFIED Requirements

### Requirement: 検証コマンドの順次実行
システムは設定 `commands` の `install`（ループ 1 のみ、定義時）・`lint` / `typecheck` / `test` / `build` を定義された順に実行しなければならない（SHALL）。各コマンドの標準出力・標準エラーを `validation/<name>.log` に保存しなければならない（SHALL）。設定でコマンドが未定義（空）の項目は実行せず `skipped` として扱わなければならない（SHALL）。

#### Scenario: install を含む全コマンドの実行
- **WHEN** ループ 1 で install / lint / typecheck / test / build がすべて設定されている
- **THEN** install が最初に実行され、続けて各検証コマンドが順に実行される

#### Scenario: 2 ループ目以降は install をスキップ
- **WHEN** ループ 2 以降で install が設定されている
- **THEN** install は実行されず skipped として記録される

#### Scenario: 未定義コマンドのスキップ
- **WHEN** `commands.build` が空である
- **THEN** build は実行されず、結果は `skipped` として記録される

### Requirement: 検証結果の機械判定
システムは各検証ステップの結果を `validation/validation-result.json` に保存しなければならない（SHALL）。各項目は `status`（passed | failed | skipped）と `exit_code`、失敗時は `log_path` を含めなければならない（SHALL）。終了コード 0 を `passed`、非ゼロを `failed` と判定しなければならない（SHALL）。`allPassed` プロパティを追加し、lint / typecheck / test がすべて `passed` かつ build が skipped または passed の場合に true としなければならない（SHALL）。

#### Scenario: 成功と失敗の判定
- **WHEN** lint が終了コード 0、typecheck が終了コード 1 で終了する
- **THEN** validation-result.json で lint は `passed`、typecheck は `failed` となり `allPassed` は false である

#### Scenario: allPassed の判定
- **WHEN** lint / typecheck / test がすべて passed で build が skipped である
- **THEN** `allPassed` は true である
