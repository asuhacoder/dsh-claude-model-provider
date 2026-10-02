# DSH Session Provider

DSHの履歴・ツール・権限を使いながら、改変しない公式Claude SDK/CLIで推論する非公式プラグインです。MITの既存実装を土台に、最新版DSHへの対応とアカウント管理を追加しました。

**実験版です。** DSH 0.2.0-rc.2、SDK 0.3.286、公式CLI 2.1.283、Node 24.14.0、macOS arm64でテキスト応答・DSHツール往復・同一queryの維持を確認しました。すべての受入条件が完了した製品とは扱っていません。[実装報告](IMPLEMENTATION_REPORT.md)で実測・未検証を区別しています。

```sh
dsh plugin --profile web add @asuha/dsh-claude-model-provider@next --ignore-scripts
claude auth login
```

npmの`next`版を公開し、実際に使用中のDSHへの導入と動作確認を完了しました。検証結果と残る配布設定は[リリース状況](RELEASE_STATUS.md)で確認できます。固定バージョンのGitHub配布物からも導入できます。

```sh
dsh plugin --profile web add https://github.com/asuhacoder/dsh-claude-model-provider/releases/download/v0.1.0-next.3/asuha-dsh-claude-model-provider-0.1.0-next.3.tgz --ignore-scripts
```

DSHを再起動し、設定の「Claude 公式SDK」で既存の公式ログインを接続してください。CLIで登録する場合はDSH停止中に `dsh plugin --profile web exec dsh-claude-model-provider accounts add primary --extra-usage-off` を実行します。

`0.1.0-next.3` では、推論強度を選べないモデルが原因でClaude全体がモデル一覧から消える不具合を修正しました。既存のDSH Web環境で、実際の会話への応答とDSHのファイル読取ツールの往復を確認しています。

`--extra-usage-off`は追加使用量がOFFであることを本人が確認してから指定します。トークンを読み出したり、従量APIへ切り替えたりしません。DSHを再起動し、`Claude (official SDK) / opus`を選んでください。導入だけでは既存のモデル設定やSubscription Pluginを変更しません。

正常なセッションは同じアカウントに固定します。残量不明を0%や100%にはしません。履歴・system prompt・ツール集合が変わったらDSHの正本から再構築します。副作用の完了が不明なツールは勝手に再実行しません。

ローカル診断は`doctor --offline`、疎通は`doctor --live --extra-usage-off --budget-generations 1`です。実2アカウントの認証分離、独立環境での自動修復・自動公開、長期canaryは未検証です。これらを実施済みとは扱わず、`next`の試験版として提供します。公式SDKで動いたことと、あらゆる第三者向け配布が許諾されることは別です。[初回設定](BOOTSTRAP_CHECKLIST.md)、[利用条件](COMPLIANCE.md)、[英語の詳細](README.md)を参照してください。

## next.2 の追加機能

DSH の設定に「Claude 公式SDK」が追加されます。公式ログインの接続、接続確認・解除、既定モデル、利用量、残量が不明な枠を確認できます。待機・キャンセル、出力前の利用枠エラーからの安全な切替、失敗した処理の利用量保存に対応しました。

短い実機試験で、履歴編集、指示・モデル変更、ツール拒否、キャンセル後の再開、プロセス再起動後の継続を確認しています。予測ルーターは観測専用です。実2アカウントの検証は未実施です。詳細は実装報告を参照してください。
