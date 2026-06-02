# Pinboard Bookmark Enhanced

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [日本語](README.ja.md) | **Polski** | [Русский](README.ru.md)

Rozszerzenie Chrome, które wzbogaca zakładki [Pinboard](https://pinboard.in) o tagi i streszczenia AI oraz w pełni konfigurowalny interfejs.

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Popup demo](docs/screenshots/demo-popup.png)

---

## Funkcje

- **Inteligentne przechwytywanie** — automatyczne wypełnianie tytułu, URL, meta-opisu, referrera i zaznaczonego tekstu, a także usuwanie parametrów śledzących (`utm_*`, `gclid`, `fbclid`, …) z zapisywanego URL przy przechwytywaniu lub wklejaniu, z trybem agresywnym oraz własnymi listami zachowywania/usuwania
- **Tagi i streszczenia AI** — własny klucz dla 13 popularnych dostawców LLM lub dowolnego endpointu zgodnego z OpenAI; do AI trafia oczyszczona treść artykułu — bez reklam, menu i pasków bocznych
- **Asystent tagów** — autouzupełnianie z Twoich własnych tagów, tagów sugerowanych przez Pinboard oraz gotowych zestawów tagów dodawanych jednym dotknięciem
- **Szybki zapis** — zapisz stronę (lub jako *do przeczytania później*) bezpośrednio skrótem klawiszowym, bez otwierania okna; albo zapisz hurtowo wszystkie otwarte karty z tagowaniem AI dla każdej karty i postępem na żywo, łącząc je w Zestaw kart
- **Wyszukiwanie i powroty** — przeszukuj swoje zakładki, przejdź do Nieprzeczytanych / Sieci / Notatek / Popularnych i przeglądaj ostatnie zapisy; ikona na pasku zmienia się, gdy bieżąca strona jest już w Twoich zakładkach
- **Kolejka offline** — wersje robocze są zapisywane lokalnie i synchronizowane po ponownym połączeniu
- **Motywy dla `pinboard.in`** — 13 dopracowanych palet (Dracula · Nord · Catppuccin · Solarized · Flexoki · Gruvbox · …) plus własna nakładka CSS synchronizowana między urządzeniami, z regulowaną szerokością okna
- **Strona do Markdown** — przekonwertuj bieżącą stronę na czysty Markdown — podgląd, skopiuj do schowka lub pobierz jako `.md`. Wybierz [defuddle](https://github.com/kepano/defuddle) + [Turndown](https://github.com/mixmark-io/turndown) (lokalnie) lub [Jina Reader](https://jina.ai/reader) (w chmurze)
- **9 języków** · konfigurowalne skróty · zero śledzenia

## Instalacja

**[→ Zainstaluj z Chrome Web Store](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** — zalecane

Lub załaduj rozpakowane z ZIP-a release:
1. Pobierz najnowszy [ZIP z release](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. Rozpakuj
3. `chrome://extensions/` → włącz **Tryb dewelopera** → **Załaduj rozpakowane** → wybierz rozpakowany folder

Po instalacji: kliknij ikonę paska narzędzi → wklej swój [token API Pinboard](https://pinboard.in/settings/password) → zapisz

## Prywatność

Bez śledzenia, bez analityki, bez telemetrii. Wszystkie dane pozostają na Twoim urządzeniu przez `chrome.storage`. Zapytania AI uruchamiają się **tylko** po kliknięciu „Tagi AI" lub „Streszczenie AI" i trafiają bezpośrednio do skonfigurowanego dostawcy. Pełna polityka: <https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## Licencja

MIT — patrz [LICENSE](LICENSE).
