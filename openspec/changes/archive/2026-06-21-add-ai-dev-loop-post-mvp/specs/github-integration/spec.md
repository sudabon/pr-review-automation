## ADDED Requirements

### Requirement: 成功時の Pull Request 作成
設定 `git.create_pr_on_success` が true で、かつ run が成功（approved + validation 全 passed）した場合、システムは設定 `git.pr_command` で Pull Request を作成しなければならない（SHALL）。`gh` CLI が利用できない、または認証されていない場合は PR 作成をスキップし警告を記録しなければならない（SHALL）。PR 作成の失敗は run 全体の成功ステータスを取り消してはならない（SHALL NOT）。

#### Scenario: PR 作成の実行
- **WHEN** `create_pr_on_success` が true で run が成功し、`gh` が認証済みである
- **THEN** `git.pr_command` が実行され、作成された PR の URL が `meta/pr-result.json` に記録される

#### Scenario: gh 未認証時のスキップ
- **WHEN** `create_pr_on_success` が true だが `gh` が未認証である
- **THEN** PR は作成されず、`meta/pr-result.json` にスキップ理由が記録される

#### Scenario: create_pr_on_success が false
- **WHEN** `create_pr_on_success` が false（既定）で run が成功する
- **THEN** PR 作成は実行されない

### Requirement: PR 本文への AI レビューサマリー追記
PR 作成時、システムは `final/claude-final-review.md` の要約と `final/final-result.json` の `remaining_issues`（存在する場合）を PR 本文に追記しなければならない（SHALL）。

#### Scenario: レビューサマリーの追記
- **WHEN** PR 作成が実行される
- **THEN** PR 本文に AI レビューサマリーと残課題チェックリスト（あれば）が含まれる
