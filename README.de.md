# Pinboard Bookmark Enhanced

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | **Deutsch** | [Français](README.fr.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md)

Eine Chrome-Erweiterung, die [Pinboard](https://pinboard.in)-Lesezeichen mit KI-gestützten Tags, Zusammenfassungen und einer voll anpassbaren Oberfläche aufwertet.

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Popup demo](docs/screenshots/demo-popup.png)

---

## Funktionen

- **Intelligente Erfassung** — füllt Titel, URL, Meta-Beschreibung, Referrer und ausgewählten Text automatisch aus. Die KI bekommt den bereinigten Artikel-Text — Anzeigen, Menüs und Sidebars werden entfernt
- **KI-Tags & Zusammenfassungen** — eigener API-Key für 13 Anbieter (OpenAI · Anthropic · Gemini · DeepSeek · Qwen · Kimi · Zhipu · Groq · Mistral · MiniMax · Cohere · OpenRouter · Ollama) oder jeden OpenAI-kompatiblen Endpunkt
- **Stapel-Speicherung** — alle offenen Tabs auf einmal erfassen, mit KI-Tagging pro Tab und Live-Fortschritt
- **Erkennung gespeicherter Seiten** — das Symbolleisten-Icon wechselt, wenn die aktuelle Seite bereits in deinen Lesezeichen ist
- **Themes für `pinboard.in`** — 13 kuratierte Farbpaletten (Dracula · Nord · Catppuccin · Solarized · Flexoki · Gruvbox · …) plus eigenes CSS-Overlay, das geräteübergreifend synchronisiert wird
- **Offline-Warteschlange** — Entwürfe bleiben lokal gespeichert und synchronisieren sich, sobald du wieder online bist
- **Seite-zu-Markdown** — die aktuelle Seite in sauberes Markdown konvertieren — Vorschau, in die Zwischenablage kopieren oder als `.md` herunterladen. Wähle zwischen [defuddle](https://github.com/kepano/defuddle) + [Turndown](https://github.com/mixmark-io/turndown) (lokal) oder [Jina Reader](https://jina.ai/reader) (Cloud)
- **9 Sprachen**, anpassbare Tastenkürzel, kein Tracking

## Installation

**[→ Im Chrome Web Store installieren](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** — empfohlen

Oder als entpackte Erweiterung aus einem Release-ZIP laden:
1. Lade das neueste [Release-ZIP](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest) herunter
2. Entpacken
3. `chrome://extensions/` → **Entwicklermodus** aktivieren → **Entpackte Erweiterung laden** → entpackten Ordner auswählen

Nach der Installation: Auf das Symbol in der Symbolleiste klicken → deinen [Pinboard-API-Token](https://pinboard.in/settings/password) einfügen → speichern

## Datenschutz

Kein Tracking, keine Analytik, keine Telemetrie. Alle Daten bleiben über `chrome.storage` auf deinem Gerät. KI-Anfragen werden **nur** ausgelöst, wenn du auf „KI-Tags" oder „KI-Zusammenfassung" klickst, und gehen direkt an den von dir konfigurierten Anbieter. Vollständige Richtlinie: <https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## Lizenz

MIT — siehe [LICENSE](LICENSE).
