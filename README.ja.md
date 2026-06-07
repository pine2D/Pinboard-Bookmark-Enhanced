# Pinboard Bookmark Enhanced

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | **日本語** | [Polski](README.pl.md) | [Русский](README.ru.md)

[Pinboard](https://pinboard.in) ブックマークを AI タグ・要約と完全カスタマイズ可能なテーマで強化する Chrome 拡張機能。

> **注意:** 本拡張機能は [Pinboard](https://pinboard.in)（**有料**のブックマークサービス）の独立したサードパーティ製クライアントです。利用にはご自身の Pinboard.in アカウントと API トークンが必要です。Pinboard とは提携しておらず、公式の承認も受けていません。

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Popup demo](docs/screenshots/demo-popup.png)

---

## 機能

- **スマート取り込み** — タイトル、URL、メタディスクリプション、リファラー、選択テキストを自動入力。取り込み時や貼り付け時に、保存する URL からトラッキングパラメーター（`utm_*`、`gclid`、`fbclid`、…）を除去。アグレッシブモードや独自の保持・除去リストにも対応
- **AI タグ・要約** — 自前の API キーで主要な LLM プロバイダー 13 種、または OpenAI 互換エンドポイントに対応。AI には広告・メニュー・サイドバーを除去した記事本文だけが渡されます
- **タグアシスタント** — 自分のタグ、Pinboard のおすすめタグ、ワンタップのタグプリセットから補完
- **クイック保存** — ポップアップを開かず、キーボードショートカットからページを保存（または*あとで読む*として保存）。開いているすべてのタブを一括保存することもでき、タブごとの AI タグ付けと進捗表示付き、まとめてタブセットにできます
- **検索・再訪** — ブックマークを検索し、未読 / ネットワーク / メモ / 人気へジャンプ、最近の保存も閲覧可能。現在のページが既にブックマーク済みならツールバーアイコンが切り替わります
- **オフラインキュー** — 下書きはローカル保存され、再接続時に自動同期
- **`pinboard.in` 用テーマ** — 13 種のキュレートされたパレット（Dracula · Nord · Catppuccin · Solarized · Flexoki · Gruvbox · …）+ デバイス間で同期するカスタム CSS オーバーレイ、ポップアップ幅も調整可能
- **ページを Markdown に** — 現在のページをクリーンな Markdown に変換し、プレビューを内蔵（レンダリング/ソース表示の切り替え、目次、閲覧統計）。`.md` またはスタイル付き `.html` としてコピー・ダウンロードでき、front-matter・画像の扱い・目次の有無を調整したり、必要に応じて [Obsidian](https://obsidian.md) へ書き出すことも可能。バックエンドは [defuddle](https://github.com/kepano/defuddle) + [Turndown](https://github.com/mixmark-io/turndown)（ローカル）または [Jina Reader](https://jina.ai/reader)（クラウド）から選択
- **9 言語対応** · カスタマイズ可能なショートカット · トラッキング一切なし

## インストール

**[→ Chrome ウェブストアからインストール](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** — 推奨

またはリリース ZIP からアンパック読み込み:
1. 最新の [リリース ZIP](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest) をダウンロード
2. 解凍
3. `chrome://extensions/` → **デベロッパーモード** を有効化 → **パッケージ化されていない拡張機能を読み込む** → 解凍したフォルダを選択

インストール後: ツールバーのアイコンをクリック → [Pinboard API トークン](https://pinboard.in/settings/password) を貼り付け → 保存

## プライバシー

トラッキング、解析、テレメトリは一切ありません。すべてのデータは `chrome.storage` でデバイス上にのみ保存されます。AI リクエストは「AI タグ」または「AI 要約」をクリックしたときに**だけ**発生し、設定したプロバイダーに直接送信されます。詳細ポリシー: <https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## ライセンス

MIT — [LICENSE](LICENSE) を参照。
