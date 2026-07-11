# Pinboard Bookmark Enhanced

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | **日本語** | [Polski](README.pl.md) | [Русский](README.ru.md)

[Pinboard](https://pinboard.in) ブックマークを AI タグ・要約と完全カスタマイズ可能なテーマで強化する Chrome 拡張機能。

> **注意:** Pinboard.in アカウントが必要です。[Pinboard](https://pinboard.in)（pinboard.in）は独立した**有料**のブックマークサービスです。本拡張機能は、ご自身の Pinboard API token を使って既存の Pinboard アカウントに接続するサードパーティ製クライアントであり、Pinboard との提携・出資・公式の承認は一切ありません。本拡張機能を利用するには、有料の Pinboard.in アカウントを既にお持ちであるか、新たに登録する必要があります。

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Popup demo](docs/screenshots/demo-popup.png)

---

## 機能

- **スマート取り込み** — タイトル、URL、メタディスクリプション、リファラー、選択テキストを自動入力。取り込み時や貼り付け時に、保存する URL からトラッキングパラメーター（`utm_*`、`gclid`、`fbclid`、…）を除去。アグレッシブモードや独自の保持・除去リストにも対応
- **クイック保存・一括保存** — ポップアップを開かず、キーボードショートカットからページを保存（または*あとで読む*として保存）。開いているすべてのタブをまとめて保存することもでき、タブごとの AI タグ付け、リアルタイムの進捗表示、ひとつのタブセットへのまとめにも対応。オフライン時の下書きはローカルキューに保持され、再接続後に Pinboard への保存が自動で再試行されます
- **AI タグ・要約** — 自前の API キーで主要な LLM プロバイダー 13 種、または OpenAI 互換エンドポイントに対応。AI には広告・メニュー・サイドバーを除去した記事本文だけが渡されます
- **タグツール** — 自分のタグ、Pinboard のおすすめタグ、ワンタップのタグプリセットから補完。さらにガバナンスパネルが重複タグや使用回数の少ないタグを洗い出し（ヒューリスティック＋必要に応じた AI クラスタリング）、負荷を抑えながら少しずつバッチ処理で統合。進捗もリアルタイムに確認できます
- **クイックリンク・ステータス** — 未読 / ネットワーク / メモ / 人気の各ページへワンタップ。現在のページが既にブックマーク済みならツールバーアイコンが切り替わります
- **ページを Markdown に** — 現在のページをクリーンな Markdown に変換し、プレビューを内蔵（レンダリング/ソース表示の切り替え、目次、閲覧統計）。`.md` またはスタイル付き `.html` としてコピー・ダウンロードでき、frontmatter（著者、公開日、サイト、カバー画像、文字数を含む）・画像の扱い・目次を調整したり、そのまま [Obsidian](https://obsidian.md)・GitHub Gist・任意の Webhook（Readwise 互換）へ送ることも可能。サイトに合わせた抽出で、Q&A、ソーシャル投稿、フォーラムのスレッドも読みやすく整形されます（知乎、Hacker News、Stack Overflow、X/Twitter、…）。抽出エンジンは [defuddle](https://github.com/kepano/defuddle) + [Turndown](https://github.com/mixmark-io/turndown)（ローカル）と [Jina Reader](https://jina.ai/reader)（クラウド）から選べます
- **ページへの質問・翻訳** — 同じ Markdown プレビュー上で、ページについて質問すると回答がストリーミングで返り、出典の該当箇所へジャンプできる検証済みの引用も付きます。選択した文章をその場で解説・翻訳したり（回答はメモとして保存可能）、独自の用語集・リアルタイムのトークン使用量表示・原文 / 対訳 / 訳文の切り替え表示でページ全体を翻訳したりできます
- **リーダーツール** — 5色でハイライトでき、メモは再描画や翻訳をまたいでも保持されます。ハイライトはノートブックパネルで一覧表示し、記事内を検索でき（`/`、正規表現にも対応 — メモも検索対象です）、脚注をその場でのぞき見表示し、続きから再開でき、集中モードで気を散らさず読み進められ、オプトインの AI 要点スキム（既定でオフ）も追加できます。`?` キーでショートカット一覧を表示
- **自動アーカイブ** — 保存のたびに Internet Archive の [Wayback Machine](https://web.archive.org) へ自動送信（オン/オフ切り替え可）。アーカイブログとリトライにも対応しているので、元のページが消えてもリンクは残り続けます
- **`pinboard.in` 用テーマ** — 13 種のキュレートされたパレット（Dracula · Nord · Catppuccin · Solarized · Flexoki · Gruvbox · …）+ デバイス間で同期するカスタム CSS オーバーレイ、ポップアップ幅の調整、タグページの人気順ソート
- **9 言語対応** · カスタマイズ可能なショートカット · ローカルファースト保存 · トラッキング一切なし

## インストール

**[→ Chrome ウェブストアからインストール](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** — 推奨

またはリリース ZIP からアンパック読み込み:
1. 最新の [リリース ZIP](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest) をダウンロード
2. 解凍
3. `chrome://extensions/` → **デベロッパーモード** を有効化 → **パッケージ化されていない拡張機能を読み込む** → 解凍したフォルダを選択

インストール後: ツールバーのアイコンをクリック → [Pinboard API トークン](https://pinboard.in/settings/password) を貼り付け → 保存

## プライバシー

トラッキング、解析、テレメトリは一切ありません。新規ユーザーでは、設定と認証情報は既定でこのデバイスに保存されます。通常の設定同期はデバイスごとに個別に有効化します。認証情報の同期は Chrome アカウント全体のひとつの選択ですが、設定同期を有効にしたデバイスだけが参加し、それ以外のデバイスはローカルの認証情報を使い続けます。新規ユーザーでは認証情報の同期は既定で無効です。アップグレード時に Chrome Sync に空でない認証情報がすでに存在する場合は、データ損失を避けるため有効のまま維持されます。有効にすると、API キー、トークン、パスワード、エクスポート先の認証情報が Chrome Sync 経由で共有されますが、難読化されるだけで暗号化はされません。保存済みブックマーク、ページ内容、オフラインキューは Chrome Sync には入りません。AI リクエストは、AI タグ・要約、ページへの質問、翻訳、選択範囲の解説、オプトインの要点スキムといった、有効にした、または呼び出した機能を通じて**のみ**発生し、設定したプロバイダーに直接送信されます。インストール時に許可されるのは Pinboard へのアクセスだけです。AI、Jina、Batch で選択したサイト、および任意のエクスポート・アーカイブ・バックアップ先は、対応する操作を行うときに、その正確なサイトへの権限だけを要求します。カスタムのネットワークエンドポイントには HTTPS が必要で、HTTP は `localhost`、`127.0.0.1`、`[::1]` に限り許可されます。拡張機能の各ページは厳格な Content-Security-Policy（リモートコードを禁止）を適用しています。詳細ポリシー: <https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## ライセンス

MIT — [LICENSE](LICENSE) を参照。
