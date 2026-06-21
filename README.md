# ai-dev-loop

`ai-dev-loop` は、制御された開発ループを自動化するローカル CLI です。

1. Git の差分を収集する
2. Claude にレビューを依頼する
3. 設定された fixer にレビューコメントの対応を依頼する。既定では Codex → Cursor を各ループで逐次実行する。MVP 互換の先頭 fixer のみ実行は `agents.fixer_mode: failover` を指定する
4. 検証コマンドを実行する
5. Claude に最終判断を依頼する
6. 承認・停止・人間によるレビューへの引き渡しのいずれかになるまで繰り返す

このツールは、ローカルで認証済みのサブスクリプション CLI をラップします。有料 API エンドポイントを直接呼び出すことはありません。

## 必要条件

- Node.js 20+
- Git
- ローカルで認証済みの `claude` CLI
- Codex を fixer として有効にする場合は、ローカルで認証済みの `codex` CLI
- Cursor Agent を fixer として有効にする場合は、ローカルで認証済みの `agent` CLI
- レビュー／修正スキルで PR コンテキストが必要な場合は、認証済みの `gh`
- エージェント環境で `pr-review-toolkit:review-pr` と `fix-pr-comments` が利用可能であること

## セットアップ

依存関係のインストールとビルド:

```bash
pnpm install
pnpm run build
```

ローカル設定の作成:

```bash
pnpm cli init
```

これにより、`.ai-dev-loop/config.yml` がまだ存在しない場合に書き込まれます。既存の設定ファイルは上書きされません。

## 使い方

設定されたベースブランチに対してフルループを実行:

```bash
pnpm cli run
```

fixer、検証、最終レビューなしでレビューのみ実行:

```bash
pnpm cli run --only-review
```

fixer の変更を適用せずに実行:

```bash
pnpm cli run --dry-run
```

ベースブランチとループ回数を上書き:

```bash
pnpm cli run --base main --max-loops 1
```

以前の実行を再開:

```bash
pnpm cli run --resume 2026-06-19T10-00-00-000Z-abc123
```

成功時のコミットを無効化:

```bash
pnpm cli run --no-commit
```

自動コミット成功後にプルリクエストを作成するには、`git.create_pr_on_success: true` を設定してください。設定された `git.pr_command` は `gh pr create` で始まる必要があります。デフォルトは `gh pr create --fill` です。PR 作成結果は `meta/pr-result.json` に記録され、PR 作成に失敗しても run 全体の成功ステータスは取り消されません。

### fixer_mode

- `sequential`（既定）: 各ループで設定された fixer をすべて順に実行する（Codex → Cursor）
- `failover`: 先頭 fixer のみを実行し、トークン上限などの失敗時に次の fixer へ交代する

### 安全策

ループは修正前と検証後に安全策チェックを適用します。

- `.ai-dev-loopignore` でレビュー入力から除外するパターンを指定できます。ファイルがない場合は `node_modules/`、lockfile、ビルド成果物などの既定パターンが使われます。
- `limits.max_changed_files` と `limits.max_diff_lines` を超えるとループを停止します。
- `safety.important_file_patterns` に一致する重要ファイル（`.env*`、migrations、workflow など）の変更時は自動修正を止め、人間レビューを要求します。
- lockfile の大規模変更は `meta/safety-warnings.json` に警告として記録し、最終レビューへ渡します。

### dry-run

`--dry-run` では Claude レビューと `fix/codex-prompt.md` / `fix/cursor-prompt.md` の生成まで行い、Codex / Cursor CLI は起動しません。

リンクされた worktree の代わりに、現在のチェックアウトで一時ブランチを使うには、`git.worktree_mode: branch` を設定してください。このモードではクリーンな作業ツリーが必要です。

## 成果物

各実行は `.ai-dev-loop/runs/<run_id>/` 配下にファイルを書き込みます。

- `input/diff.patch`
- `input/status.txt`
- `input/project-summary.md`
- `review/claude-review.md`
- `review/review.json`
- `fix/codex-prompt.md` と `fix/codex-output.md`
- `fix/cursor-prompt.md` と `fix/cursor-output.md`
- `validation/*.log`
- `validation/validation-result.json`
- `final/claude-final-review.md`
- `final/final-result.json`
- `meta/command-log.jsonl`
- `meta/loop-state.json`
- lockfile などの警告がある場合は `meta/safety-warnings.json`
- 自動 PR 作成が有効な場合は `meta/pr-result.json`

## 検証

```bash
pnpm run verify
```
