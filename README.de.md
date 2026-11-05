# Bookmark Enhanced

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | **Deutsch** | [Français](README.fr.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md)

Eine Chrome-Erweiterung für [Pinboard](https://pinboard.in), Karakeep und linkding: KI-Tags und Zusammenfassungen, ein Reader mit Übersetzung und Markierungen sowie 13 Themes für pinboard.in.

> **Hinweis:** Wähle deinen Lesezeichendienst in den Einstellungen. Karakeep und linkding funktionieren ohne Pinboard-Konto. Pinboard ist ein unabhängiger, **kostenpflichtiger** Dienst und erfordert ein eigenes Konto mit API-Token. Diese Erweiterung stammt von einem Drittanbieter, steht in keiner Verbindung zu Pinboard und wird von Pinboard weder gesponsert noch befürwortet.

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Speichern mit KI-Tags und Zusammenfassung, in dunklem und hellem Theme](docs/screenshots/readme/hero.webp)

[![1-Minuten-Video: speichern, lesen, behalten](docs/screenshots/readme/promo-video.webp)](https://youtu.be/f3F8Se2rnoc)

---

## Funktionen

### Speichern
- **Beim Dienst deiner Wahl speichern**: Pinboard, Karakeep oder linkding; Titel, Beschreibung und markierter Text werden automatisch übernommen.
- **KI-Tags und Zusammenfassungen**: direkt aus dem Artikel vorgeschlagen, mit deinem eigenen API-Schlüssel.
- **Offline speichern**: Was du offline speicherst, wartet und wird gesendet, sobald du wieder online bist.

### Lesen
- **Eine saubere Leseansicht für jede Seite**: ohne Werbung und Seitenleisten, mit Markierungen und Notizen.
- **Zweisprachig lesen**: die ganze Seite übersetzen und das Original daneben behalten.
- **Seite befragen**: Antworten zitieren den Artikel, und ein Klick bringt dich zum zitierten Satz.
- **Wörter beim Lesen nachschlagen**: Definitionen und Aussprache sehen, ohne die Seite zu verlassen, und gespeicherte Wörter an Anki senden.
- **Lesen und zuschauen**: YouTube- und bilibili-Videos laufen neben einem Transkript, das der Wiedergabe folgt.

![Leseansicht mit zweisprachiger Übersetzung und Markierungen](docs/screenshots/readme/reader.webp)

![Die Seite befragen, Antworten zitieren die Quelle](docs/screenshots/readme/ask.webp)

![YouTube-Vorschau mit mitlaufendem Transkript](docs/screenshots/readme/video.webp)

### Behalten
- **Eine Bibliothek für alles, was du behältst**: Markierungen, Notizen, gespeicherte Wörter und frühere Fragen, synchronisiert über dein eigenes Google Drive.
- **Senden oder herunterladen**: an [Obsidian](https://obsidian.md), Notion und weitere Ziele senden oder als `.md`, `.html` oder `.epub` herunterladen.

![Notizseite: die Markierungen eines Artikels als durchgehender Auszug](docs/screenshots/readme/notes.webp)

![Gespeichertes Wort mit Kontext und Wörterbuchspalte](docs/screenshots/readme/vocab.webp)

### Pinboard nach deinem Geschmack
- **13 Themes für pinboard.in**: helle und dunkle Designs für die Website, dazu dein eigenes CSS.
- **Tags aufräumen**: ähnliche Tags zusammenführen und selten genutzte ausmisten.
- **Automatisch in die [Wayback Machine](https://web.archive.org) archivieren**: Gespeicherte Seiten bleiben lesbar, auch wenn der Originallink nicht mehr funktioniert.

![13 Themes für pinboard.in](docs/screenshots/readme/themes.webp)

## Installation

**[→ Im Chrome Web Store installieren](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** (empfohlen)

Oder als entpackte Erweiterung aus einem Release-ZIP laden:
1. Lade das neueste [Release-ZIP](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest) herunter
2. Entpacken
3. `chrome://extensions/` → **Entwicklermodus** aktivieren → **Entpackte Erweiterung laden** → entpackten Ordner auswählen

Öffne danach **Einstellungen → Konto** und verbinde deinen Lesezeichendienst: für Pinboard mit deinem [API-Token](https://pinboard.in/settings/password), für Karakeep (ab Version 0.31) oder linkding mit Serveradresse und API-Token.

## Datenschutz

Die Erweiterung verfolgt dich nicht und sammelt keine Nutzungsdaten. Einstellungen und Schlüssel bleiben auf diesem Gerät, solange du die Synchronisierung nicht aktivierst; synchronisierte Schlüssel sind nur verschleiert, nicht verschlüsselt. KI-Anfragen gehen nur an den von dir eingerichteten Anbieter, und nur dann, wenn du eine KI-Funktion nutzt. Für alle Websites außer Pinboard fragt die Erweiterung erst dann nach Zugriff, wenn du zum ersten Mal eine Funktion nutzt, die ihn braucht. Kopien in Google Drive liegen im privaten App-Ordner der Erweiterung und sind nicht Ende-zu-Ende-verschlüsselt. Vollständige Richtlinie: <https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## Lizenz

MIT. Siehe [LICENSE](LICENSE).
