# DSH Session Provider

DSHの履歴・ツール・権限を使いながら、改変しない公式Claude SDK/CLIで推論する非公式プラグインです。MITの既存実装を土台に、最新版DSHへの対応とアカウント管理を追加しました。

**実験版です。** DSH 0.2.0-rc.2、SDK 0.3.286、公式CLI 2.1.283、Node 24.14.0、macOS arm64でテキスト応答・DSHツール往復・同一queryの維持を確認しました。すべての受入条件が完了した製品とは扱っていません。[実装報告](IMPLEMENTATION_REPORT.md)で実測・未検証を区別しています。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm release:dry-run
dsh plugin --profile web add ./dist/asuhacoder-dsh-session-provider-0.1.0-next.1.tgz --ignore-scripts
claude auth login
node lib/provider-cli.js accounts add primary --extra-usage-off
node lib/provider-cli.js doctor --offline
```

`--extra-usage-off`は追加使用量がOFFであることを本人が確認してから指定します。トークンを読み出したり、従量APIへ切り替えたりしません。DSHを再起動し、`Claude (official SDK) / opus`を選んでください。導入だけでは既存のモデル設定やSubscription Pluginを変更しません。

正常なセッションは同じアカウントに固定します。残量不明を0%や100%にはしません。履歴・system prompt・ツール集合が変わったらDSHの正本から再構築します。副作用の完了が不明なツールは勝手に再実行しません。

ローカル診断は`doctor --offline`、疎通は`doctor --live --extra-usage-off --budget-generations 1`です。実2アカウントの認証分離、将来の自動修復・自動公開、npm公開設定は未完了です。npmにはまだ公開していません。公式SDKで動いたことと、あらゆる第三者向け配布が許諾されることは別です。[初回設定](BOOTSTRAP_CHECKLIST.md)、[利用条件](COMPLIANCE.md)、[英語の詳細](README.md)を参照してください。
