# Bookmark Enhanced

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [日本語](README.ja.md) | **Polski** | [Русский](README.ru.md)

Rozszerzenie Chrome dla [Pinboard](https://pinboard.in), [Karakeep](https://karakeep.app) i [linkding](https://linkding.link): tagi i streszczenia AI, czytnik z tłumaczeniem i wyróżnieniami oraz 13 motywów dla pinboard.in.

> **Uwaga:** Wybierz usługę zakładek w ustawieniach. Karakeep i linkding działają bez konta Pinboard. Pinboard to niezależna, **płatna** usługa, która wymaga własnego konta i tokenu API. To rozszerzenie jest klientem zewnętrznym, niepowiązanym z Pinboard, niesponsorowanym ani nieautoryzowanym przez ten serwis.

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Zapis z tagami i streszczeniem od AI, w motywie ciemnym i jasnym](docs/screenshots/readme/hero.webp)

[![Minutowy film: zapisz, przeczytaj, zachowaj](docs/screenshots/readme/promo-video.webp)](https://youtu.be/YWvA_Vux0CI)

---

## Funkcje

### Zapisywanie
- **Zapis w wybranej usłudze** — Pinboard, Karakeep lub linkding, z gotowym tytułem, opisem i zaznaczonym tekstem.
- **Tagi i streszczenia AI** — propozycje na podstawie samego artykułu, z użyciem Twojego klucza API.
- **Zapis offline** — zapisane zakładki czekają i trafiają na miejsce, gdy znów będziesz online.

### Czytanie
- **Czytelny widok każdej strony** — bez reklam i pasków bocznych, z zaznaczeniami i notatkami.
- **Czytaj w dwóch językach** — przetłumacz całą stronę i miej oryginał tuż obok.
- **Zapytaj stronę** — odpowiedzi cytują artykuł, a jedno kliknięcie przenosi do przytoczonego zdania.
- **Sprawdzaj słowa podczas czytania** — zobacz definicje i wymowę bez opuszczania strony i wysyłaj zapisane słówka do Anki.
- **Oglądaj podczas czytania** — filmy z YouTube i bilibili odtwarzają się obok transkrypcji, która podąża za nagraniem.

![Czytelny widok z tłumaczeniem dwujęzycznym i zaznaczeniami](docs/screenshots/readme/reader.webp)

![Zadaj stronie pytanie — odpowiedzi cytują źródło](docs/screenshots/readme/ask.webp)

![Podgląd YouTube z transkrypcją podążającą za odtwarzaniem](docs/screenshots/readme/video.webp)

### Przechowywanie
- **Jedna biblioteka na wszystko, co zachowasz** — zaznaczenia, notatki, zapisane słówka i wcześniejsze pytania, synchronizowane przez Twój własny Dysk Google.
- **Wyślij albo pobierz** — wyślij do [Obsidiana](https://obsidian.md), Notion i innych usług albo pobierz jako plik `.md`, `.html` lub `.epub`.

![Strona notatek: zaznaczenia z jednego artykułu jako ciągły wypis](docs/screenshots/readme/notes.webp)

![Zapisane słówko z kontekstem i kolumną słownika](docs/screenshots/readme/vocab.webp)

### Pinboard po Twojemu
- **13 motywów dla pinboard.in** — jasny i ciemny wygląd witryny, a do tego własny CSS.
- **Porządki w tagach** — scalaj niemal identyczne tagi i usuwaj te, których rzadko używasz.
- **Automatyczna archiwizacja w [Wayback Machine](https://web.archive.org)** — zapisane strony da się przeczytać nawet wtedy, gdy oryginalny link przestanie działać.

![13 motywów dla pinboard.in](docs/screenshots/readme/themes.webp)

## Instalacja

**[→ Zainstaluj z Chrome Web Store](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** — zalecane

Lub załaduj rozpakowane z ZIP-a release:
1. Pobierz najnowszy [ZIP z release](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. Rozpakuj
3. `chrome://extensions/` → włącz **Tryb dewelopera** → **Załaduj rozpakowane** → wybierz rozpakowany folder

Następnie otwórz **Ustawienia → Konto** i połącz usługę zakładek: dla Pinboard podaj [token API](https://pinboard.in/settings/password), a dla Karakeep (w wersji 0.31 lub nowszej) albo linkding adres serwera i token API.

## Prywatność

Rozszerzenie nie śledzi Cię i nie zbiera danych o użytkowaniu. Ustawienia i klucze pozostają na tym urządzeniu, dopóki nie włączysz synchronizacji; synchronizowane klucze są jedynie zaciemnione, a nie zaszyfrowane. Zapytania AI trafiają wyłącznie do skonfigurowanego przez Ciebie dostawcy i tylko wtedy, gdy korzystasz z funkcji AI. W przypadku każdej witryny innej niż Pinboard rozszerzenie prosi o dostęp, gdy po raz pierwszy użyjesz funkcji, która go wymaga. Kopie na Dysku Google są przechowywane w prywatnym folderze aplikacji rozszerzenia i nie są objęte szyfrowaniem end-to-end. Pełna polityka: <https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## Licencja

MIT — patrz [LICENSE](LICENSE).
