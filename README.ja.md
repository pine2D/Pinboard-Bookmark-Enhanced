# Bookmark Enhanced

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | **日本語** | [Polski](README.pl.md) | [Русский](README.ru.md)

[Pinboard](https://pinboard.in)、Karakeep、linkding に対応した Chrome 拡張機能。AI タグと要約、翻訳・ハイライト付きリーダー、pinboard.in 用テーマ 13 種を備えています。

> **注意:** 設定でブックマークサービスを選択します。Karakeep と linkding は Pinboard アカウントなしで使えます。Pinboard は独立した**有料**サービスで、自分のアカウントと API トークンが必要です。本拡張機能は第三者製で、Pinboard との提携・出資・公式の承認はありません。

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![AI タグと要約を付けて保存（ダーク／ライトテーマ）](docs/screenshots/readme/hero.webp)

[![1 分の紹介動画：保存して、読んで、残す](docs/screenshots/readme/promo-video.webp)](https://youtu.be/f3F8Se2rnoc)

---

## 機能

### 保存
- **選んだサービスに保存**：Pinboard、Karakeep、linkding のいずれかに、タイトル・説明・選択テキストを自動入力して保存します。
- **AI タグ・要約**：自分の API キーを使い、記事の内容からタグと要約を提案します。
- **保存を取りこぼさない**：オフライン中の保存はキューで待機し、再接続すると送信されます。

### リーダー
- **どんなページもすっきりしたリーダーに**：広告やサイドバーを取り除き、5 色のハイライトとメモを付けられます。
- **2 か国語で読む**：ページ全体を翻訳し、原文と並べて表示します。
- **ページへの質問**：回答には記事からの引用が付き、引用した文へジャンプできます。
- **その場で単語を調べる**：ページを離れずに語義と発音を確認でき、保存した単語は Anki に送れます。
- **読みながら観る**：YouTube と Bilibili の動画を、再生に合わせて流れる字幕と並べて再生します。

![リーダー：対訳表示とハイライト](docs/screenshots/readme/reader.webp)

![ページへの質問、回答には出典引用付き](docs/screenshots/readme/ask.webp)

![YouTube プレビュー：再生に合わせて流れる字幕](docs/screenshots/readme/video.webp)

### 残す
- **残したものをひとつのライブラリに**：ハイライト、メモ、保存した単語、過去の質問を、自分の Google ドライブで同期します。
- **送信もダウンロードも**：[Obsidian](https://obsidian.md)・Notion などに送信したり、`.md`・`.html`・`.epub` でダウンロードしたりできます。

![メモページ：1 本の記事のハイライトを抜き書きとして通読](docs/screenshots/readme/notes.webp)

![保存した単語：文脈と辞書欄](docs/screenshots/readme/vocab.webp)

### カスタマイズ
- **pinboard.in 用テーマ 13 種**：Dracula、Nord、Catppuccin などに加え、自分の CSS も使えます。
- **タグ整理**：似たタグを統合し、ほとんど使わないタグを片付けます。
- **[Wayback Machine](https://web.archive.org) へ自動アーカイブ**：保存したページは、元のリンクが切れても読めます。

![pinboard.in 用テーマ 13 種](docs/screenshots/readme/themes.webp)

## インストール

**[→ Chrome ウェブストアからインストール](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)**（推奨）

または、リリース ZIP を解凍して読み込む:
1. 最新の [リリース ZIP](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest) をダウンロード
2. 解凍
3. `chrome://extensions/` → **デベロッパーモード** を有効化 → **パッケージ化されていない拡張機能を読み込む** → 解凍したフォルダを選択

インストール後は**設定 → アカウント**でブックマークサービスに接続します。Pinboard は [API トークン](https://pinboard.in/settings/password)、Karakeep（0.31 以降）と linkding はサーバーのアドレスと API トークンを使います。

## プライバシー

トラッキング、解析、テレメトリは一切ありません。同期をオンにしない限り、設定と認証情報はこのデバイスだけに保存され、同期した認証情報は難読化されるだけで暗号化はされません。AI リクエストは AI 機能を使ったときだけ発生し、設定したプロバイダーにのみ送信されます。Pinboard 以外に必要なサイトへのアクセスは、各機能を初めて使うときに 1 サイトずつ要求します。Google ドライブのコピーは拡張機能専用の非公開アプリフォルダーに保存され、エンドツーエンド暗号化はされません。詳細ポリシー: <https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## ライセンス

MIT。[LICENSE](LICENSE) を参照。
