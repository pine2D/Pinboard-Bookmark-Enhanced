# Pinboard Bookmark Enhanced

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | **日本語** | [Polski](README.pl.md) | [Русский](README.ru.md)

[Pinboard](https://pinboard.in) ブックマークを AI タグ・要約と完全カスタマイズ可能なテーマで強化する Chrome 拡張機能。

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Popup demo](docs/screenshots/demo-popup.png)

---

## 機能

- **スマート取り込み** — タイトル、URL、メタディスクリプション、リファラー、選択テキストを自動入力。AI には広告・メニュー・サイドバーを除去した記事本文だけが渡されます
- **AI タグ・要約** — 自前の API キーで 13 プロバイダーに対応（OpenAI · Anthropic · Gemini · DeepSeek · Qwen · Kimi · Zhipu · Groq · Mistral · MiniMax · Cohere · OpenRouter · Ollama）または OpenAI 互換エンドポイント
- **一括保存** — 開いているすべてのタブを一度に保存、タブごとの AI タグ付けと進捗表示付き
- **既保存検知** — ツールバーアイコンが切り替わり、現在のページが既にブックマーク済みかすぐ分かります
- **`pinboard.in` 用テーマ** — 13 種のキュレートされたパレット（Dracula · Nord · Catppuccin · Solarized · Flexoki · Gruvbox · …）+ デバイス間で同期するカスタム CSS オーバーレイ
- **オフラインキュー** — 下書きはローカル保存され、再接続時に自動同期
- **ページを Markdown に** — 現在のページをクリーンな Markdown に変換 — プレビュー、クリップボードにコピー、または `.md` としてダウンロード。[defuddle](https://github.com/kepano/defuddle) + [Turndown](https://github.com/mixmark-io/turndown)（ローカル）または [Jina Reader](https://jina.ai/reader)（クラウド）から選択
- **9 言語対応**、カスタマイズ可能なショートカット、トラッキング一切なし

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
