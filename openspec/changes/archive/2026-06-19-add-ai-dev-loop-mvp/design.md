## Context

`ai-dev-loop` は、Claude / Codex / Cursor の各サブスクリプション CLI をローカルプロセスとして制御し、「レビュー → 修正 → 検証 → 最終レビュー」のループを自動化するローカル CLI ツールである。詳細要件は `proposal.md` と `specs/` を、原典は `ai-dev-loop-implementation-spec.md` を参照。

現状は新規プロジェクト（既存コードなし）。本 change は仕様書 §14 の MVP を対象とし、単一リポジトリ・逐次実行・ローカル CLI に限定する。前提として、対象環境には認証済みの `claude` / `codex` / `agent`(Cursor) CLI と Git が存在し、`pr-review-toolkit:review-pr` プラグイン・`fix-pr-comments` スキル・認証済み `gh` CLI が利用可能で、対象リポジトリに `lint` / `typecheck` / `test` / `build` の npm scripts がある。

## Goals / Non-Goals

**Goals:**
- API キー課金を避け、サブスクリプション認証済み CLI のラップでループを実現する。
- 各ステップの入出力を `.ai-dev-loop/runs/<run_id>/` 配下にファイルとして残し、再現性・監査性・`--resume` を担保する。
- AI 出力（review.json / final-result.json / validation-result.json）をスキーマ検証し、機械判定でループを制御する。
- worktree・ループ上限・同一指摘検出・人間差し戻し条件により暴走を防ぐ。
- レビューは `pr-review-toolkit:review-pr`、修正は `fix-pr-comments` を再利用し、トークン超過時は修正担当を自動交代して停止を回避する。

**Non-Goals:**
- Web UI、複数リポジトリ対応、並列実行、クラウド常駐、Slack 通知、GitHub Apps 化、自動マージ、本番デプロイ（いずれも MVP 外）。
- 本番ブランチへの直接 push。
- AI エージェント同士の無制限な対話。

## Decisions

### D1: 実装言語は Node.js + TypeScript
- **採用**: Node.js + TypeScript。Web アプリ開発環境との親和性、npm scripts 統合、JSON/YAML 処理の容易さ、CLI 配布のしやすさ。
- **代替案**: Go / Rust（単一バイナリ配布は強いが、対象リポジトリの npm エコシステムとの統合や JSON/YAML 取り回しで不利）、Python（候補だが対象が Web フロント中心のため TS を優先）。

### D2: API ではなく CLI ラップ方式
- **採用**: `claude` / `codex` / `agent` を子プロセスとして `execa` で起動し、タイムアウト付きで実行。
- **理由**: API キー課金回避（本仕様の最重要前提）。各 CLI の認証済みセッションをそのまま利用できる。
- **代替案**: 各社 API 直叩き → 課金が発生し前提に反するため不採用。

### D3: AI との契約はファイル + JSON スキーマ
- **採用**: 入出力を run ディレクトリのファイルで受け渡し、`review.json` / `final-result.json` / `validation-result.json` を zod で検証。
- **理由**: AI 出力の揺れを境界で吸収し、機械判定（ループ継続/終了）の信頼性を確保。失敗時のデバッグもファイルで追跡可能。
- **代替案**: 標準出力のパースのみ → 出力フォーマットの揺れに弱く不採用。

### D4: 作業隔離は Git worktree（既定）
- **採用**: `git.use_worktree = true` を既定とし、worktree（不可なら一時ブランチ）上で修正・検証を実施。
- **理由**: 本番/作業ブランチを汚さず、失敗時の破棄が容易。
- **代替案**: カレントブランチ直接編集 → 失敗時のロールバックが煩雑で危険。

### D5: ループ制御は明示的な状態機械 + loop-state.json 永続化
- **採用**: 各ループ後に継続/終了/差し戻しを判定し、状態を `meta/loop-state.json` に保存。`--resume` で復元。
- **理由**: 長時間実行の中断・再開、同一指摘の連続検出に状態の永続化が必要。

### D6: CLI フレームワークは Commander.js（oclif は候補）
- **採用**: 軽量さと学習コストの低さから Commander.js を第一候補。コマンドが増えれば oclif を再検討。
- **代替案**: oclif（プラグイン/生成機能は強いが MVP には重い）。

### D7: ディレクトリ構成は仕様書 §13 案に準拠
- `src/` 配下を `config/` `git/` `runners/` `prompts/` `loop/` `logs/` `utils/` に分割し、capability 境界（specs）と概ね対応させる。各 runner は単一責務で `execWithTimeout` / `safeJsonParse` を共有ユーティリティ経由で利用。

### D8: レビューは pr-review-toolkit:review-pr、修正は fix-pr-comments を再利用
- **採用**: 初回レビューは Claude CLI 経由で `pr-review-toolkit:review-pr`（`/review-pr`）を実行してレビューコメントと `review.json` を得る。修正フェーズは `fix-pr-comments` スキルでコメントを解消する。
- **理由**: 既存の専門レビュー/コメント修正ワークフローを再利用し、レビュー観点と「コメント → 修正」の対応を標準化。自前プロンプトの保守コストを削減。
- **含意**: コメントベースのため対象は PR（または PR に紐づくブランチ）を想定し、`gh` 認証を前提とする。
- **代替案**: 自前プロンプトのみで review.json を生成 → 既存ツールの品質・保守を捨てるため不採用。

### D9: 修正担当のフェイルオーバー（Codex → Cursor）
- **採用**: `agents.fixers` の並び順を優先度とし、先頭（既定 Codex）を active fixer とする。active fixer がサブスクのトークン超過（クォータ/レート上限）を示したら次の担当（既定 Cursor）へ自動交代し、未対応コメントから継続。全員超過なら人間差し戻し。
- **検知**: 各 CLI の終了コード/標準エラーのトークン超過パターンを判定する検知ヘルパ（`utils/detectTokenLimit.ts`）を設け、パターンは設定可能にする。
- **理由**: サブスク前提でトークン枯渇による全停止を避け、修正を継続させる。
- **代替案**: 超過時に即停止 → 自動化の価値を損なうため不採用。

## Risks / Trade-offs

- **外部 CLI の出力/挙動の不安定さ** → run ディレクトリへの全入出力保存とスキーマ検証で吸収し、検証失敗は当該ループを失敗扱いにして人間が追跡できるようにする。
- **CLI 認証切れ・未インストール** → `run` 開始時に各 CLI の存在/起動可否を事前チェックし、明確なエラーで早期終了する。
- **タイムアウト/ハング** → 各 runner に設定値（`*.timeout_sec`）でタイムアウトを設け、超過時は打ち切ってループ失敗扱い。
- **AI 修正の暴走・過剰変更** → プロンプト制約（最小変更・無関係リファクタ禁止）、Git 差分の異常拡大での停止条件、同一指摘 N 連続での停止、人間差し戻し条件で抑制。
- **誤った自動コミット** → コミットは `approved` かつ `--no-commit` 未指定時のみ。push は行わない。worktree 上で作業し本番ブランチに直接触れない。
- **TS 実装の配布手間（Go 比）** → MVP ではローカル利用前提のため許容。将来 `npm install -g` 配布で対応。
- **トークン超過の検知漏れ/誤検知** → CLI ごとのエラーパターンを設定可能にし、検知時は担当交代＋記録。判定不能なエラーは安全側で当該ループ失敗扱いにする。
- **PR 前提（review-pr / fix-pr-comments）** → 対象は PR（または PR 紐づきブランチ）を前提とし、`gh` 認証を事前チェック。PR 不在時の扱いは Open Questions 参照。

## Migration Plan

新規導入のためデータ移行は不要。

1. `ai-dev-loop` パッケージ（CLI）を実装・ビルドする。
2. 対象リポジトリで `ai-dev-loop init` を実行し `.ai-dev-loop/config.yml` を生成、コマンド/ブランチ設定を調整する。
3. まず `ai-dev-loop run --only-review`（または `--dry-run`）で安全に動作確認する。
4. 問題なければ `ai-dev-loop run --max-loops 3` で本フローを実行する。
5. ロールバック: 作業は worktree/一時ブランチ上のため、破棄は worktree 削除またはブランチ削除で完結。`.ai-dev-loop/` は成果物保存用で本番コードに影響しない。

## Open Questions

- run_id のフォーマット確定（ISO 風タイムスタンプ。並行実行は MVP 外だが衝突回避の余地）。
- Cursor CLI の正確な print/apply フラグ（`agent -p --force --output-format text` を初期値とし、実環境で検証）。
- 「Git 差分が異常に大きい」「テストが連続して悪化」の具体的しきい値（初期値を設定可能にするか固定にするか）。
- `create_pr_on_success` を MVP に含めるか（仕様書 §14 では PR 自動化は MVP 外。本 change では既定 false・コミットまでとする）。
- トークン超過の検知方法（CLI ごとの終了コード/標準エラーのパターン）の確定。
- `pr-review-toolkit:review-pr` / `fix-pr-comments` を Claude CLI 経由で実行するか、`gh` + スキルを直接実行するか。対象は PR 必須とするか、PR 不在時は diff ベースにフォールバックするか。
