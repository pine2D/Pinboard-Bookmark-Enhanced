# Pinboard Bookmark Enhanced

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | **Deutsch** | [Français](README.fr.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md)

Eine Chrome-Erweiterung für [Pinboard](https://pinboard.in): KI-Tags und Zusammenfassungen, eine eingebaute Leseansicht mit Übersetzung und Markierungen sowie 13 Themes für die Website selbst.

> **Hinweis:** Erfordert ein Pinboard.in-Konto — [Pinboard](https://pinboard.in) ist ein unabhängiger, **kostenpflichtiger** Lesezeichendienst. Diese Erweiterung ist ein Drittanbieter-Client, der sich mit deinem eigenen API-Token mit deinem bestehenden Pinboard-Konto verbindet. Sie ist nicht mit Pinboard verbunden, wird nicht von Pinboard gesponsert oder unterstützt. Zur Nutzung dieser Erweiterung musst du bereits ein kostenpflichtiges Pinboard.in-Konto besitzen (oder eines anlegen).

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Speichern mit KI-Tags und Zusammenfassung, in dunklem und hellem Theme](docs/screenshots/readme/hero.webp)

[![30-Sekunden-Video: speichern, lesen, behalten](docs/screenshots/readme/promo-video.webp)](https://youtu.be/DMQS8LC09kU)

---

## Funktionen

### Speichern
- **Ein Klick, alles ausgefüllt**: Titel, Beschreibung und markierter Text werden übernommen, Tracking-Parameter aus der URL entfernt
- **Tastenkürzel und Stapelspeicherung**: speichern, ohne das Popup zu öffnen, oder alle Tabs des Fensters auf einmal als Lesezeichen anlegen
- **Funktioniert offline**: Gespeichertes landet in einer lokalen Warteschlange und wird gesendet, sobald du wieder online bist
- **Entwürfe bleiben erhalten**: Popup schließen, wieder öffnen und genau dort weiterschreiben

### Tags
- **KI-Tags und Zusammenfassung**: gelesen wird der Artikeltext ohne Werbung, Menüs und Seitenleisten; eigener API-Schlüssel, 14 Anbieter oder ein beliebiger OpenAI-kompatibler Endpunkt
- **Autovervollständigung**: aus deinen Tags, Pinboards Vorschlägen und Ein-Klick-Voreinstellungen
- **Tags aufräumen**: ähnliche Tags zusammenführen und selten genutzte ausmisten

### Lesen
- **Jede Seite wird zur Leseansicht**: Markdown-Ansicht mit Inhaltsverzeichnis, Suche und Fußnoten-Vorschau; Formeln, Diagramme und Tabellen werden sauber dargestellt
- **GitHub Discussions (Pilot)**: übernimmt den geladenen Ausgangsbeitrag und die Kommentare, erhält die Antwortstruktur und markiert die akzeptierte Antwort; zeigt den Umfang der erfassten Inhalte
- **Lesezeichen beim Lesen verwalten**: Pinboard-Lesezeichen direkt im Reader speichern, bearbeiten oder löschen, ohne zum Popup zurückzukehren
- **Markieren in fünf Farben, mit Notizen**: beide bleiben an ihrer Stelle, auch nach der Übersetzung und späteren Änderungen an der Seite
- **Seite übersetzen oder befragen**: Ganzseiten-Übersetzung mit zweisprachiger Ansicht; Antworten zitieren die Quelle, ein Klick führt direkt zur Fundstelle
- **Fragen und Antworten mit Quellen behalten**: fertige Antworten werden automatisch gespeichert und über Google Drive synchronisiert. Gespräche in der Bibliothek lesen, im Lesemodus fortsetzen oder einzeln bzw. mit dem Artikel exportieren. Temporäre Gespräche bleiben ungespeichert.
- **Wörter beim Lesen nachschlagen**: Definitionen und Aussprache im Wörterbuch anzeigen; gespeicherte Vokabeln gehen mit einem Klick an Anki oder Eudic, dazu auf Wunsch Offline-Wörterbücher für Chinesisch–Englisch und Englisch–Chinesisch. Wähle die Definitionssprache der KI-Einträge unabhängig von der Oberfläche und filtere gespeicherte Wörter nach Sprache. Ziehe an den Rändern, um das Nachschlagefenster zu vergrößern oder zu verkleinern, oder verschiebe es in die Seitenleiste; Ergebnisse, ausgewählte Definition und laufende Generierung bleiben dabei erhalten. Sieh Wörter in echten Sätzen aus Texten auf Wikisource, mit Autor und Quelle, ganz ohne KI.
- **Mehrsprachige Offline-Wörterbücher**: schlage Wörter mit Definitionen und Ausspracheangaben aus selbst importierten Yomitan-v3-ZIP-Dateien auf diesem Gerät nach; Wörterbuchpakete sind von der Drive-Synchronisierung und JSON-Sicherungen ausgeschlossen. Alle Offline-Wörterbücher, auch Chinesisch–Englisch und Englisch–Chinesisch, lassen sich deaktivieren, ohne ihre Daten zu löschen. Bei erkannter Struktur werden einzelne Definitionen getrennt von Beispielen und Wortherkunft angezeigt; andere Inhalte bleiben als vollständige Einträge lesbar. Importiere ältere Pakete erneut, um ihre Struktur neu auszuwerten. Gespeicherte Vokabeln und der Aktivierungsstatus bleiben dabei unverändert.
- **KI-Wörterbucheinträge**: Erhalte zunächst Definitionen, Aussprache und Beispiele in deiner Muttersprache oder einer gewählten Erklärungssprache und ergänze bei Bedarf Gebrauchshinweise und Wortherkunft. Gültige Teile einer unvollständigen Ergänzung bleiben erhalten und werden als unvollständig gekennzeichnet. Vollständige Ergebnisse werden bei verbundenem Google Drive synchronisiert, frühere Versionen bleiben bei Aktualisierungen erhalten. Wörterbuchergebnisse und KI-Inhalte stehen in einer Spalte, der Fortschritt der Erstellung ist laufend zu sehen, und die zu speichernde Definition bleibt unten sichtbar. Die automatische Erstellung von Basiseinträgen ist optional.
- **Ausgewählten Text im Zusammenhang verstehen**: Nutze „Erklären“, um ein Wort oder einen Abschnitt im aktuellen Artikel zu verstehen; Wörterbucheinträge beschreiben allgemeine Bedeutungen und Verwendung.
- **Deine Bibliothek**: Markierungen, Notizen, gespeicherte Wörter und Gespräche an einem Ort, mit Wörterbuchsuche und Stapelbearbeitung von Vokabeln. Wörter direkt aus Wörterbucheinträgen speichern, eine Definition auswählen und Wortformen über eine bearbeitbare Grundform verknüpfen. Jedes Wort behält eigene Notizen und seinen Lernstatus.
- **Vokabeln vollständig exportieren**: Ein eigener mehrsprachiger Anki-Notiztyp unterscheidet gleich geschriebene Wörter verschiedener Sprachen. Die vollständige TSV bewahrt Notizen, Grundformen und alle Kontexte mit ihren Quellen; die bisherigen Formate mit sechs Feldern bleiben verfügbar
- **Senden oder herunterladen**: an [Obsidian](https://obsidian.md), Notion, NotebookLM, ein GitHub Gist oder einen beliebigen Webhook; als `.md`, `.html` oder `.epub` für den E-Reader
- **Sehen beim Lesen**: YouTube- und Bilibili-Videos laufen neben einem Transkript, das der Wiedergabe folgt; KI-Tags und -Zusammenfassungen lesen auf Wunsch die Untertitel

![Leseansicht mit zweisprachiger Übersetzung und Markierungen](docs/screenshots/readme/reader.webp)

![Die Seite befragen, Antworten zitieren die Quelle](docs/screenshots/readme/ask.webp)

![Notizseite: die Markierungen eines Artikels als durchgehender Auszug](docs/screenshots/readme/notes.webp)

![Gespeichertes Wort mit Kontext und Wörterbuchspalte](docs/screenshots/readme/vocab.webp)

![YouTube-Vorschau mit mitlaufendem Transkript](docs/screenshots/readme/video.webp)

### Pinboard nach deinem Geschmack
- **13 Themes für pinboard.in** (Dracula · Nord · Catppuccin · Solarized · …) plus dein eigenes CSS
- **Automatisch in die [Wayback Machine](https://web.archive.org) archivieren**: von jeder gespeicherten Seite ein Snapshot, damit sie lesbar bleibt, auch wenn der Originallink tot ist
- **Sichern und synchronisieren**: Einstellungen über Chrome Sync, Vokabeln, Markierungen, Notizen, KI-Wörterbucheinträge und Gespräche über dein eigenes Google Drive; JSON-Backups enthalten Einstellungen, Vokabeln, Markierungen und Notizen
- **9 Sprachen** · anpassbare Tastenkürzel · Speicherung primär lokal · kein Tracking

![13 Themes für pinboard.in](docs/screenshots/readme/themes.webp)

## Installation

**[→ Im Chrome Web Store installieren](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** (empfohlen)

Oder als entpackte Erweiterung aus einem Release-ZIP laden:
1. Lade das neueste [Release-ZIP](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest) herunter
2. Entpacken
3. `chrome://extensions/` → **Entwicklermodus** aktivieren → **Entpackte Erweiterung laden** → entpackten Ordner auswählen

Der Quellcode verwendet eine eigene feste Entwicklungs-ID und kann deshalb zu Testzwecken neben der Version aus dem Chrome Web Store installiert werden. Das Release-ZIP verwendet dagegen die ID des Chrome Web Store und kann nicht gleichzeitig mit der Store-Version im selben Chrome-Profil installiert sein. Chrome Sync gleicht die Einstellungen ab, sobald die Einstellungssynchronisierung auf jedem Gerät aktiviert ist. Vor dem Wechsel von einem älteren entpackten Release in dessen Einstellungen auf **Sicherung exportieren** klicken und nach dem Laden des neuen Releases **Sicherung importieren** verwenden.

Nach der Installation: Auf das Symbol in der Symbolleiste klicken → deinen [Pinboard-API-Token](https://pinboard.in/settings/password) einfügen → **Anmelden**

## Datenschutz

Kein Tracking, keine Analytik, keine Telemetrie. Für neue Nutzer werden Einstellungen und Zugangsdaten standardmäßig auf diesem Gerät gespeichert. Die Synchronisierung gewöhnlicher Einstellungen wird auf jedem Gerät separat aktiviert. Die Synchronisierung von Zugangsdaten ist eine kontoweite Chrome-Option, an der aber nur Geräte mit aktivierter Einstellungssynchronisierung teilnehmen; andere Geräte verwenden weiterhin ihre lokalen Zugangsdaten. Bei neuen Nutzern ist die Synchronisierung von Zugangsdaten standardmäßig deaktiviert. Sind bei einem Upgrade bereits nicht leere Zugangsdaten in Chrome Sync vorhanden, bleibt sie zur Vermeidung von Datenverlust aktiviert. Wenn sie aktiviert ist, werden API-Schlüssel, Tokens, Passwörter und Export-Zugangsdaten über Chrome Sync geteilt; sie sind nur verschleiert, nicht verschlüsselt. Gespeicherte Lesezeichen, Seiteninhalte und die Offline-Warteschlange gelangen nicht in Chrome Sync. KI-Anfragen entstehen **nur** durch KI-Funktionen, die du aktivierst oder nutzt, und gehen direkt an den von dir konfigurierten Anbieter. Bei der Installation wird nur der Zugriff auf Pinboard gewährt. Jede weitere Website, die die Erweiterung braucht (ein KI-Anbieter, ein Export- oder Archivierungsziel, ein Wörterbuch, Google Drive, Video-Untertitel oder die Websites einer Stapelspeicherung), wird erst angefragt, wenn du die jeweilige Funktion zum ersten Mal nutzt, und zwar einzeln und nur für genau diese Website. Benutzerdefinierte Netzwerkendpunkte müssen HTTPS verwenden; HTTP ist nur für `localhost`, `127.0.0.1` und `[::1]` zulässig. Die Seiten der Erweiterung setzen eine strikte Content-Security-Policy durch (kein Remote-Code). Vollständige Richtlinie: <https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

Google Drive wird auf jedem Gerät separat verbunden und synchronisiert Vokabeln, Markierungen, Notizen, vollständige KI-Wörterbucheinträge samt Ergänzungen und gespeicherte Gespräche mit Quellenauszügen des aktuellen Pinboard-Kontos. Kopien im privaten appDataFolder liegen im Klartext vor, ohne Ende-zu-Ende-Verschlüsselung. Optionale Belege zur Wortherkunft stammen aus Wiktionary. Die Erweiterung gleicht sie mit dem Quelltext ab und sendet kurze Auszüge samt Quellenangaben an deinen KI-Anbieter. Die Beispiele in den Gebrauchshinweisen verfasst die KI. Originalbelege werden auf Wikisource gesucht und unverändert ohne Übersetzung angezeigt; sie gehen nie an die KI. Bereits bezahlte Ergebnisse bleiben erhalten; neue Versionen entstehen nur auf Anfrage.

Aktualisiere die Erweiterung auf allen Geräten, die Vokabeln synchronisieren. Diese Version liest vorhandene Vokabeldaten; ältere Versionen können jedoch keine Vokabeländerungen empfangen, die mit dieser Version gespeichert wurden.

## Lizenz

MIT. Siehe [LICENSE](LICENSE).
