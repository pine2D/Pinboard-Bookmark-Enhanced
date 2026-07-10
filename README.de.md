# Pinboard Bookmark Enhanced

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | **Deutsch** | [Français](README.fr.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md)

Eine Chrome-Erweiterung, die [Pinboard](https://pinboard.in)-Lesezeichen mit KI-gestützten Tags, Zusammenfassungen und einer voll anpassbaren Oberfläche aufwertet.

> **Hinweis:** Erfordert ein Pinboard.in-Konto — [Pinboard](https://pinboard.in) ist ein unabhängiger, **kostenpflichtiger** Lesezeichendienst. Diese Erweiterung ist ein Drittanbieter-Client, der sich mit deinem eigenen API-Token mit deinem bestehenden Pinboard-Konto verbindet. Sie ist nicht mit Pinboard verbunden, wird nicht von Pinboard gesponsert oder unterstützt. Zur Nutzung dieser Erweiterung musst du bereits ein kostenpflichtiges Pinboard.in-Konto besitzen (oder eines anlegen).

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Popup demo](docs/screenshots/demo-popup.png)

---

## Funktionen

- **Intelligente Erfassung** — füllt Titel, URL, Meta-Beschreibung, Referrer und markierten Text automatisch aus und entfernt beim Erfassen oder Einfügen Tracking-Parameter (`utm_*`, `gclid`, `fbclid`, …) aus der gespeicherten URL – mit aggressivem Modus und eigenen Listen für „behalten" und „entfernen"
- **Schnell- & Stapelspeicherung** — die Seite (oder als *später lesen*) direkt per Tastenkürzel speichern, ohne das Popup zu öffnen; oder alle offenen Tabs auf einmal sichern, mit KI-Tagging pro Tab, Live-Fortschritt und einem Tab-Set-Bündel; offline gespeicherte Entwürfe wandern in eine Warteschlange und werden synchronisiert, sobald du wieder online bist
- **KI-Tags & Zusammenfassungen** — eigener API-Key für 13 LLM-Anbieter oder jeden OpenAI-kompatiblen Endpunkt; die KI liest den bereinigten Artikel-Text — Anzeigen, Menüs und Sidebars werden entfernt
- **Tag-Werkzeuge** — Autovervollständigung aus deinen eigenen Tags, Pinboards vorgeschlagenen Tags und Tag-Presets per Klick, plus ein Verwaltungs-Panel, das doppelte und selten genutzte Tags aufspürt (Heuristik + KI-Clustering auf Knopfdruck) und sie schubweise und mit Live-Fortschritt zusammenführt, um die Server nicht zu überlasten
- **Schnelllinks & Status** — mit einem Klick zu deinen Seiten „Ungelesen", „Netzwerk", „Notizen" und „Beliebt"; das Symbolleisten-Icon wechselt, sobald die aktuelle Seite bereits in deinen Lesezeichen liegt
- **Seite-zu-Markdown** — die aktuelle Seite in sauberes Markdown umwandeln, mit eingebauter Vorschau (gerenderte/Roh-Ansicht, Inhaltsverzeichnis, Lesestatistik); als `.md` oder gestyltes `.html` kopieren oder herunterladen, Frontmatter (inklusive Autor, Veröffentlichungsdatum, Website, Titelbild und Wortzahl), Bildbehandlung und Inhaltsverzeichnis anpassen oder direkt an [Obsidian](https://obsidian.md), ein GitHub Gist oder einen beliebigen Webhook (Readwise-kompatibel) senden. Eine seitenspezifische Extraktion hält Frage-Antwort-Seiten, Social Posts und Forenverläufe lesbar (Zhihu, Hacker News, Stack Overflow, X/Twitter, …); wahlweise mit [defuddle](https://github.com/kepano/defuddle) + [Turndown](https://github.com/mixmark-io/turndown) (lokal) oder [Jina Reader](https://jina.ai/reader) (Cloud)
- **Seite fragen & übersetzen** — stelle direkt in der Markdown-Vorschau Fragen und erhalte Antworten im Stream, mit geprüften Quellenangaben, die zur Fundstelle springen; lass dir eine markierte Passage direkt im Text erklären oder übersetzen (und die Antwort als Notiz speichern), oder übersetze die ganze Seite mit eigenem Glossar, Live-Tokenverbrauch und den Ansichten Original / zweisprachig / Übersetzung
- **Lesewerkzeuge** — markiere Text in fünf Farben, mit Notizen, die ein erneutes Rendern und Übersetzungen überstehen, behalte den Überblick über deine Markierungen im Notebook-Panel, durchsuche den Artikel (`/`, optional mit Regex — auch deine Notizen werden durchsucht), sieh dir Fußnoten direkt an Ort und Stelle an, mach dort weiter, wo du aufgehört hast, schalte mit dem Fokus-Modus in einen ablenkungsfreien Modus, oder aktiviere einen optionalen KI-gestützten Schnellüberblick über die wichtigsten Punkte (standardmäßig deaktiviert); drücke `?` für die vollständige Liste der Tastenkürzel
- **Automatische Archivierung** — auf Wunsch jede Speicherung an die [Wayback Machine](https://web.archive.org) des Internet Archive übergeben, samt Archiv-Protokoll und automatischem Wiederholversuch, damit deine Links erreichbar bleiben, auch wenn die Originalseite irgendwann verschwindet
- **Themes für `pinboard.in`** — 13 kuratierte Farbpaletten (Dracula · Nord · Catppuccin · Solarized · Flexoki · Gruvbox · …) plus ein eigenes CSS-Overlay, das geräteübergreifend synchronisiert wird, dazu eine einstellbare Popup-Breite und eine Sortierung nach Beliebtheit auf Tag-Seiten
- **9 Sprachen** · anpassbare Tastenkürzel · Speicherung primär lokal · kein Tracking

## Installation

**[→ Im Chrome Web Store installieren](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** — empfohlen

Oder als entpackte Erweiterung aus einem Release-ZIP laden:
1. Lade das neueste [Release-ZIP](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest) herunter
2. Entpacken
3. `chrome://extensions/` → **Entwicklermodus** aktivieren → **Entpackte Erweiterung laden** → entpackten Ordner auswählen

Nach der Installation: Auf das Symbol in der Symbolleiste klicken → deinen [Pinboard-API-Token](https://pinboard.in/settings/password) einfügen → speichern

## Datenschutz

Kein Tracking, keine Analytik, keine Telemetrie. Alle Daten werden standardmäßig über `chrome.storage` auf deinem Gerät gespeichert; wenn du die Einstellungssynchronisierung aktivierst, werden deine Einstellungen (nicht deine gespeicherten Lesezeichen) über dein Chrome-Konto zwischen deinen Geräten synchronisiert. KI-Anfragen werden **nur** über Funktionen gesendet, die du aktivierst oder nutzt — KI-Tags/-Zusammenfassung, Fragen zur Seite, Übersetzung, Erklärung einer markierten Passage oder der optionale Schnellüberblick über die wichtigsten Punkte — und gehen direkt an den von dir konfigurierten Anbieter. Bei der Installation wird nur der Zugriff auf Pinboard gewährt; KI, Jina, in Batch ausgewählte Websites sowie optionale Export-, Archivierungs- und Sicherungsziele fordern erst bei der jeweiligen Aktion nur die Berechtigung für die konkrete Website an. Benutzerdefinierte Netzwerkendpunkte müssen HTTPS verwenden; HTTP ist nur für `localhost`, `127.0.0.1` und `[::1]` zulässig. Die Seiten der Erweiterung setzen eine strikte Content-Security-Policy durch (kein Remote-Code). Vollständige Richtlinie: <https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## Lizenz

MIT — siehe [LICENSE](LICENSE).
