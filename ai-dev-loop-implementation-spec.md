# AIコードレビュー・修正ループ自動化システム 実装仕様書

作成日: 2026-06-16  
対象: Webアプリケーション開発におけるレビュー・修正ループの自動化  
前提: Claude / Codex / Cursor のサブスクリプション利用を優先し、APIキー課金をできるだけ避ける

---

## 1. 目的

Webアプリケーション開発において、以下の往復作業を自動化する。

1. Claude がコード差分をレビューする
2. Claude が修正タスクを構造化する
3. Codex CLI が修正を実施する
4. Cursor CLI Agent が補助修正・追加レビューを実施する
5. lint / typecheck / test / build を実行する
6. Claude が最終レビューを行う
7. 合格ならコミットまたはPull Request作成、未合格なら最大回数まで再実行する

本仕様では、Claudeをメインエージェント、CodexとCursor Agentを実装修正エージェントとして扱う。

---

## 2. 開発すべきもの

開発対象は、単一の「ローカルAI開発オーケストレーター」である。

名称例:

```text
ai-dev-loop
```

これはWebサービスではなく、まずはローカルCLIツールとして実装する。

```bash
ai-dev-loop run --base main --target feature/foo
```

このCLIが、Claude Code / Codex CLI / Cursor CLI Agent / Git / テストコマンドを順番に制御する。

---

## 3. 実現方針

### 3.1 APIではなくCLIラップ方式を採用する

APIキーを使うと別課金になるため、以下を前提にする。

- Claude Code はサブスクリプション認証済みCLIを利用する
- Codex CLI はChatGPTアカウント認証を利用する
- Cursor CLI Agent は既存サブスクリプションまたはCLI認証済み環境を利用する
- それぞれのCLIをローカルプロセスとして実行する

### 3.2 完全自律化ではなく、制御された自動化にする

AIエージェントを無制限に会話させない。必ず以下で制御する。

- Git worktree または一時ブランチで作業する
- 各ステップの入出力をファイルに保存する
- テスト結果を機械的に判定する
- ループ回数に上限を設ける
- 同一指摘が繰り返されたら停止する
- 本番ブランチへの直接pushは禁止する

---

## 4. 全体アーキテクチャ

```text
┌────────────────────────────┐
│ ai-dev-loop CLI             │
└─────────────┬──────────────┘
              │
              ▼
┌────────────────────────────┐
│ Git差分収集                 │
│ git diff / git status       │
└─────────────┬──────────────┘
              │
              ▼
┌────────────────────────────┐
│ Claude Review Runner        │
│ レビュー・タスク分解         │
└─────────────┬──────────────┘
              │ review.json
              ▼
┌────────────────────────────┐
│ Codex Fix Runner            │
│ 主要修正                     │
└─────────────┬──────────────┘
              │
              ▼
┌────────────────────────────┐
│ Cursor Fix Runner           │
│ 補助修正・不足対応           │
└─────────────┬──────────────┘
              │
              ▼
┌────────────────────────────┐
│ Validation Runner           │
│ lint / typecheck / test      │
└─────────────┬──────────────┘
              │
              ▼
┌────────────────────────────┐
│ Claude Final Review Runner  │
│ 最終判定                     │
└─────────────┬──────────────┘
              │
              ▼
┌────────────────────────────┐
│ Commit / PR / Stop          │
└────────────────────────────┘
```

---

## 5. ディレクトリ構成

対象リポジトリに以下の管理ディレクトリを作成する。

```text
.ai-dev-loop/
  config.yml
  runs/
    2026-06-16T10-00-00/
      input/
        diff.patch
        status.txt
        project-summary.md
      review/
        claude-review.md
        review.json
      fix/
        codex-prompt.md
        codex-output.md
        cursor-prompt.md
        cursor-output.md
      validation/
        lint.log
        typecheck.log
        test.log
        build.log
        validation-result.json
      final/
        claude-final-review.md
        final-result.json
      meta/
        loop-state.json
        command-log.jsonl
```

---

## 6. 設定ファイル仕様

ファイル: `.ai-dev-loop/config.yml`

```yaml
project:
  name: sample-web-app
  package_manager: npm
  base_branch: main

agents:
  main_reviewer: claude
  fixers:
    - codex
    - cursor

limits:
  max_loops: 3
  max_same_issue_repeats: 2
  stop_on_validation_failure: false

commands:
  install: "npm ci"
  lint: "npm run lint"
  typecheck: "npm run typecheck"
  test: "npm test -- --runInBand"
  build: "npm run build"

git:
  use_worktree: true
  commit_on_success: true
  create_pr_on_success: false
  pr_command: "gh pr create --fill"

claude:
  command: "claude"
  review_timeout_sec: 1800
  final_review_timeout_sec: 1800

codex:
  command: "codex"
  timeout_sec: 1800

cursor:
  command: "agent"
  timeout_sec: 1800
  apply_changes_flag: "--force"
  output_format: "text"
```

---

## 7. CLI仕様

### 7.1 基本コマンド

```bash
ai-dev-loop run
```

現在のブランチとbase_branchとの差分を対象にレビュー・修正ループを実行する。

### 7.2 オプション

```bash
ai-dev-loop run \
  --base main \
  --target feature/foo \
  --max-loops 3 \
  --no-commit
```

| オプション | 内容 |
|---|---|
| `--base` | 比較元ブランチ |
| `--target` | 作業対象ブランチ |
| `--max-loops` | 最大ループ数 |
| `--no-commit` | 成功時にコミットしない |
| `--dry-run` | AIに修正させず、レビューと計画だけ実行 |
| `--only-review` | Claudeレビューのみ実行 |
| `--resume <run_id>` | 中断したrunを再開 |

---

## 8. 処理フロー詳細

### 8.1 初期化

1. Gitリポジトリであることを確認する
2. 未コミット差分を確認する
3. 必要なら作業用worktreeを作る
4. 実行ディレクトリを作成する
5. `git diff` を `input/diff.patch` に保存する
6. `git status` を `input/status.txt` に保存する

### 8.2 Claudeレビュー

Claudeに以下を依頼する。

- バグ
- セキュリティ
- 型安全性
- テスト不足
- 可読性
- 設計上の問題
- 破壊的変更
- 優先度付け
- 修正タスクのJSON化

出力ファイル:

```text
review/claude-review.md
review/review.json
```

### 8.3 review.json仕様

```json
{
  "summary": "レビュー概要",
  "overall_risk": "low | medium | high",
  "tasks": [
    {
      "id": "R001",
      "severity": "blocker | critical | major | minor | nit",
      "category": "bug | security | type | test | refactor | design | docs",
      "title": "問題の短い説明",
      "description": "詳細説明",
      "files": ["src/example.ts"],
      "suggested_fix": "修正方針",
      "acceptance_criteria": [
        "期待される完了条件"
      ]
    }
  ]
}
```

### 8.4 Codex修正

Codexには `review.json` を渡し、blocker / critical / major を優先して修正させる。

Codex向けプロンプトは自動生成する。

```text
あなたはWebアプリケーションの修正担当です。
review.json の指摘に従って修正してください。

制約:
- 既存仕様を壊さない
- 変更は最小限にする
- blocker / critical / major を優先する
- 必要なテストを追加する
- 修正後に要約を .ai-dev-loop/.../fix/codex-output.md に書く
```

### 8.5 Cursor Agent補助修正

Cursor Agentには、Codex後の差分と未解決タスクを渡す。

主な役割:

- Codexの修正漏れ確認
- UI周辺の補正
- 型エラーの補正
- テスト不足の補強
- リファクタリングのしすぎ検知

Cursor CLIは非対話用途ではprint modeを使い、必要に応じて変更適用フラグを使う。

例:

```bash
agent -p --force --output-format text "review.json と現在の差分を確認し、未解決の重要指摘のみ修正してください"
```

---

## 9. 検証処理

Validation Runner は設定ファイルのコマンドを順番に実行する。

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

結果を以下に保存する。

```json
{
  "lint": {
    "status": "passed",
    "exit_code": 0
  },
  "typecheck": {
    "status": "failed",
    "exit_code": 1,
    "log_path": "validation/typecheck.log"
  },
  "test": {
    "status": "passed",
    "exit_code": 0
  },
  "build": {
    "status": "skipped",
    "exit_code": null
  }
}
```

---

## 10. Claude最終レビュー

Claudeには以下を渡す。

- 初回レビュー
- 修正後diff
- validation-result.json
- 各AIの出力ログ

Claudeの最終判定はJSONで保存する。

```json
{
  "decision": "approved | needs_changes | human_review_required",
  "remaining_issues": [
    {
      "id": "F001",
      "severity": "major",
      "description": "残課題"
    }
  ],
  "reason": "判定理由"
}
```

---

## 11. ループ制御

### 11.1 継続条件

以下のいずれかなら次ループに進む。

- Claude最終レビューが `needs_changes`
- lint / typecheck / test が失敗
- blocker / critical / major が残っている

### 11.2 終了条件

以下のいずれかで終了する。

- Claude最終レビューが `approved`
- 最大ループ回数に到達
- 同一指摘が2回連続で残る
- AIが修正不能と判断
- Git差分が異常に大きくなる
- テストが連続して悪化する

### 11.3 人間レビューに戻す条件

以下の場合は自動修正を停止する。

- 認証・課金・外部サービス連携に関わる修正
- DBマイグレーションを伴う修正
- セキュリティ設計の変更
- 大規模な設計変更
- 仕様判断が必要なUI/UX変更
- 本番データに影響する変更

---

## 12. 実装技術

推奨実装:

- Node.js + TypeScript
- Commander.js または oclif
- execa で外部コマンド実行
- zod でJSON検証
- yaml で設定読み込み
- simple-git または child_process でGit操作

理由:

- Webアプリケーション開発環境と相性が良い
- npm scriptsとの統合が容易
- CLIツールとして配布しやすい
- JSON/YAML処理が簡単

---

## 13. TypeScript構成案

```text
src/
  index.ts
  cli.ts
  config/
    loadConfig.ts
    schema.ts
  git/
    collectDiff.ts
    createWorktree.ts
    commitChanges.ts
  runners/
    runClaudeReview.ts
    runCodexFix.ts
    runCursorFix.ts
    runValidation.ts
    runClaudeFinalReview.ts
  prompts/
    buildClaudeReviewPrompt.ts
    buildCodexFixPrompt.ts
    buildCursorFixPrompt.ts
    buildClaudeFinalPrompt.ts
  loop/
    runLoop.ts
    shouldContinue.ts
    detectRepeatedIssues.ts
  logs/
    createRunDirectory.ts
    writeCommandLog.ts
  utils/
    execWithTimeout.ts
    safeJsonParse.ts
```

---

## 14. MVPスコープ

最初に作るべきMVPは以下。

### 必須機能

- 設定ファイル読み込み
- Git差分保存
- Claudeレビュー実行
- review.json生成
- Codex修正実行
- Cursor修正実行
- lint / typecheck / test 実行
- Claude最終レビュー実行
- 最大3回のループ
- 結果ログ保存
- 成功時のコミット

### MVPではやらないこと

- Web UI
- 複数リポジトリ対応
- 並列実行
- クラウド常駐実行
- Slack通知
- GitHub Apps化
- 完全自動マージ
- 本番デプロイ

---

## 15. コマンド実行例

```bash
# インストール
npm install -g ai-dev-loop

# 初期化
ai-dev-loop init

# 実行
ai-dev-loop run --base main --max-loops 3

# レビューのみ
ai-dev-loop run --only-review

# 前回runの再開
ai-dev-loop run --resume 2026-06-16T10-00-00
```

---

## 16. Claudeレビュー用プロンプト仕様

```text
あなたはWebアプリケーション開発のメインレビュー担当です。

目的:
現在のGit差分をレビューし、修正担当AIが実装できる粒度のタスクに分解してください。

入力:
- git diff
- git status
- package.json
- 主要設定ファイル
- 前回ループの結果があればその要約

レビュー観点:
- バグ
- セキュリティ
- 型安全性
- テスト不足
- パフォーマンス
- アクセシビリティ
- 保守性
- 仕様破壊
- 過剰実装

出力:
1. Markdownレビュー
2. review.json

制約:
- 推測で仕様を決めない
- 重要度を明確にする
- 修正担当AIが迷わないよう、受け入れ条件を書く
- nitだけでループを継続しない
```

---

## 17. Codex修正用プロンプト仕様

```text
あなたは修正担当エージェントです。

review.json の tasks を確認し、severity が blocker / critical / major のものを優先して修正してください。

制約:
- 変更は最小限
- 既存APIを不用意に変えない
- テストが必要な場合は追加する
- 関係ないリファクタリングをしない
- 修正できなかった項目は理由を書く
- 作業後に修正サマリーを書く
```

---

## 18. Cursor補助修正用プロンプト仕様

```text
あなたは補助修正・品質確認担当です。

Codex修正後の差分を確認し、以下を行ってください。

- 未解決の重要指摘が残っていないか確認
- 型エラーやlintエラーの原因になりそうな箇所を修正
- テスト不足が明らかな場合のみテスト追加
- 過剰な変更があれば最小化
- UI実装の破綻があれば修正

制約:
- 新しい大規模設計を始めない
- nitのみの変更は避ける
- 仕様判断が必要な場合は human_review_required として止める
```

---

## 19. 安全対策

### 19.1 Git安全対策

- 実行前に現在ブランチを保存
- worktreeまたは一時ブランチで実行
- 失敗時は変更を破棄できるようにする
- 自動pushは初期バージョンでは禁止

### 19.2 AI暴走対策

- 最大ループ数を設定
- 変更ファイル数の上限を設定
- diff行数の上限を設定
- package-lockなどの大規模変更は警告
- 重要ファイルの変更には確認を要求

重要ファイル例:

```text
.env
.env.production
database/migrations/
infra/
terraform/
.github/workflows/
auth/
payment/
```

### 19.3 コスト・使用量対策

API利用ではなくCLI利用でも、各サービスの利用制限に到達する可能性がある。

対策:

- Claudeに渡すdiffを必要範囲に絞る
- lockfileや生成物を除外する
- 大きな差分はファイル単位で分割する
- nitではループを継続しない
- final reviewは差分と検証結果だけ渡す

---

## 20. 除外ファイル設定

`.ai-dev-loopignore`

```text
node_modules/
dist/
build/
coverage/
.next/
.nuxt/
.cache/
*.lock
package-lock.json
pnpm-lock.yaml
yarn.lock
*.min.js
*.map
```

lockfileは必要に応じて含めるが、レビュー入力からは原則除外する。

---

## 21. 成功判定

成功条件:

- lint が成功
- typecheck が成功
- test が成功
- build が設定されていれば成功
- Claude最終レビューが approved
- blocker / critical / major が0件

失敗条件:

- 最大ループ回数に到達
- 同一課題が繰り返し残る
- テストが連続して失敗
- AIが仕様判断を要求
- Git差分が大きくなりすぎる

---

## 22. ログ仕様

各外部コマンドの実行結果をJSON Linesで保存する。

```json
{"timestamp":"2026-06-16T10:00:00Z","step":"claude_review","command":"claude ...","exit_code":0,"duration_ms":120000}
{"timestamp":"2026-06-16T10:03:00Z","step":"codex_fix","command":"codex ...","exit_code":0,"duration_ms":180000}
```

---

## 23. GitHub連携

MVPでは `gh` CLI が入っている場合のみPR作成する。

```bash
gh pr create --fill
```

将来的には以下を追加する。

- PR本文にAIレビューサマリーを追記
- 修正されたレビュー指摘一覧を記載
- 残課題がある場合はチェックリスト化
- GitHub Actions結果を取得して再ループ

---

## 24. 実装ステップ

### Step 1: CLI土台

- `ai-dev-loop init`
- `ai-dev-loop run`
- config読み込み
- runディレクトリ作成

### Step 2: Git差分収集

- `git diff`
- `git status`
- 対象ファイル一覧
- 除外ファイル処理

### Step 3: Claudeレビュー

- Claude起動
- レビュー保存
- review.json抽出
- JSONバリデーション

### Step 4: Codex修正

- Codexプロンプト生成
- Codex起動
- 出力保存

### Step 5: Cursor補助修正

- Cursorプロンプト生成
- Cursor起動
- 出力保存

### Step 6: 検証

- lint
- typecheck
- test
- build
- 結果JSON化

### Step 7: Claude最終レビュー

- final prompt生成
- approved / needs_changes / human_review_required 判定

### Step 8: ループ制御

- 最大回数
- 同一指摘検知
- 成功/失敗終了

### Step 9: コミット/PR

- 成功時コミット
- 任意でPR作成

---

## 25. 最小実装の疑似コード

```ts
async function runAiDevLoop(config: Config) {
  const run = await createRunDirectory();

  for (let loop = 1; loop <= config.limits.maxLoops; loop++) {
    await collectGitContext(run);

    const review = await runClaudeReview(run, config);
    validateReviewJson(review);

    await runCodexFix(run, config, review);
    await runCursorFix(run, config, review);

    const validation = await runValidation(run, config);

    const finalReview = await runClaudeFinalReview(run, config, {
      review,
      validation,
      diff: await getCurrentDiff()
    });

    if (finalReview.decision === "approved" && validation.allPassed) {
      await commitChanges(run, config);
      return {
        status: "success",
        runId: run.id
      };
    }

    if (finalReview.decision === "human_review_required") {
      return {
        status: "human_review_required",
        runId: run.id
      };
    }

    if (await isRepeatedIssue(run, finalReview)) {
      return {
        status: "stopped_repeated_issue",
        runId: run.id
      };
    }
  }

  return {
    status: "max_loops_reached",
    runId: run.id
  };
}
```

---

## 26. 将来拡張

- GitHub Actions上での実行
- Slack通知
- PRコメントへの自動返信
- Playwright E2E実行
- スクリーンショット差分レビュー
- 複数修正案の比較
- Claude / Codex / Cursor の担当領域切り替え
- 特定ディレクトリごとの専門エージェント設定
- 失敗パターンの学習
- チケット管理ツール連携

---

## 27. 注意点

この仕組みは「人間の最終責任」を置き換えるものではない。

特に以下は自動マージしない。

- 認証認可
- 決済
- 個人情報
- DBマイグレーション
- インフラ
- セキュリティポリシー
- 本番デプロイ
- 外部API契約に関わる変更

---

## 28. 採用判断

本仕様の推奨判断:

- まずはローカルCLIとして開発する
- Claudeをレビュー・監督役に固定する
- CodexとCursorを修正担当として使い分ける
- APIキーは使わず、認証済みCLIをラップする
- MVPではGitHub連携やWeb UIを作らない
- 3ループ以上は自動継続しない

これにより、サブスクリプション利用の範囲に寄せながら、レビュー・修正・検証の往復を大幅に自動化できる。
