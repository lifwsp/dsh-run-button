# dsh-run-button

<p align="center">
  <a href="README.md">English</a> · <b>日本語</b> · <a href="README.zh.md">中文</a>
</p>

**DSH の回答に出てくるシェルのコードブロックに、Run ボタンを付けるプラグインです。** 押すと、そのコマンドが手元のマシンで動きます。動く場所は、セッションのワークスペースとサンドボックスの中です。出力は右下の小さなドックに流れます。`yes/no` の確認や `sudo` のパスワードにも、DSH の画面から答えられます。

<p align="center">
  <img src="assets/interactive.png" alt="Run のドックで sudo のパスワードに答えているところ" width="560">
</p>

> DSH `0.2.1-rc.1`（macOS）で確認済み: コマンドの実行と停止、`read -p` / `sudo` / `ssh` のホスト鍵確認への応答、Dock と Panel への出力。

## インストール

**プラグインマーケットから:** 設定 → プラグインマーケット → `dsh-run-button` を検索 → インストール。

**`dsh` CLI から:**

```bash
dsh plugin --profile web add dsh-run-button
# 最新リリースやリポジトリのソースから入れる場合
dsh plugin --profile web add "https://github.com/lifwsp/dsh-run-button/releases/latest/download/dsh-run-button.tgz"
dsh plugin --profile web add github:lifwsp/dsh-run-button
```

外すときは `dsh plugin --profile web remove dsh-run-button` を実行します。`npm install` だけでは、DSH にプラグインとして読み込まれません。

## 使い方

1. エージェントにコマンドを出してもらうか、`bash` / `powershell` のコードブロックを自分で書きます。
2. ブロックの見出しにある **▶ Run** を押します。**▶ Run→AI** を押すと、コマンドが終わったあとにエージェントが結果を読んで返事をします。
3. 出力は右下の**ドック**に出ます。実行中なら止められます。出力の折りたたみや、カードを閉じることもできます。
4. 入力待ちになったら、出力の下の入力欄に答えを打って **Enter** を押します。
   - パスワードの入力（`Password:`、`パスワード:`、`passphrase` など）だと判断すると、入力欄は自動で伏せ字になります。**mask** で手動でも切り替えられます。
   - **^C** は、run を止めずにプログラムへ Ctrl-C を送ります。**^D** は入力の終わり（EOF）を送ります。
5. Run の隣の **cwd** を押すと、そのブロックだけ作業ディレクトリを変えられます。

メッセージ欄の上の帯には、実行中の run と、最後に終わった run が1つ出ます。それより前の run は **+N** にまとまり、そこから **Clear finished**（終わった run をまとめて消す）も選べます。何も実行していないあいだ、帯は薄く表示されます。帯の右のアイコンで出力先を選べます。マウスを乗せると名前が出ます。

| モード | 出力先 | 必要なもの |
| --- | --- | --- |
| **Dock**（既定） | 右下に浮かぶカード。run ごとに1枚 | なし |
| **Panel** | 右サイドバーか、下のワークベンチのタブ。run ごとに1つ | [`dsh-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar) |
| **Off** | どこにも出さない。Run ボタンに状態だけ出る | なし |

## 対応するコードブロック

| 言語タグ | ボタン |
| --- | --- |
| `bash`, `sh`, `zsh`, `shell`, `shellscript` | `▶ Run` |
| `console` | `▶ console` |
| `powershell`, `pwsh`, `ps1` | `▶ PowerShell` |
| `cmd`, `bat`, `batch`, `dos` | `▶ cmd` |

ほかの言語（`js`、`python` など）にはボタンを付けません。

## 安全性

- run にできることは、同じセッションのエージェントにできることと変わりません。セッションの**サンドボックス設定**と**ワークスペース**をそのまま使います。
- コマンドは、ブロックに書かれたとおりに実行します。モデルの出力を後から差し込むことはありません。
- 入力した内容は、**どこにも記録しません**。プラグインのログ、ブラウザーの保存領域、Run→AI の結果のどれにも残りません。パスワードの入力中は端末のエコーが止まるので、出力にも出ません。
- プラグインが止まるときや更新されるときは、実行中の run も止めます。再読み込みのあとに、プロセスが残り続けることはありません。

## 制約

- **`sudo` と `ssh` の入力に答えられるのは、`danger-full-access` のセッションだけです。** `read-only` と `workspace-write` では、macOS のサンドボックスが、これらが読む端末を使わせません。そのときは入力欄に案内が出ます。普通の入力を読むプロンプト（`read -p` やインストーラー）は、どのモードでも答えられます。
- 入力に答えるには、macOS か Linux の DSH 0.2 が必要です。それ以外の環境でもコマンドは動きますが、入力欄は出ません。
- 出力は文字だけです。色は取り除きます。`vim`、`less`、`top` のような全画面のプログラムは使えません。
- 出力は、run が終わってから10分間残ります。ページを再読み込みしても見られますが、DSH を再起動すると消えます。出力の上限は1つの出力につき 256 KB で、入力を受け付ける run は 1 MB です。入力を受け付ける run は、30分たつと止まります。

## 開発

仕組み、テスト、ホスト API の注意点は [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) にまとめています（英語）。

## ライセンス

MIT です。[LICENSE](LICENSE) を見てください。元のプラグインは [EdwardXiao-bit](https://github.com/EdwardXiao-bit/dsh-run-button) さんが作りました。このフォークでは、DSH 0.2 への対応、Run→AI、Panel を開く場所の選択、対話的な入力を足しています。
