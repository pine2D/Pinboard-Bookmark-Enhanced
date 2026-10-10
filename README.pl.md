# Pinboard Bookmark Enhanced

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [日本語](README.ja.md) | **Polski** | [Русский](README.ru.md)

Rozszerzenie Chrome dla [Pinboard](https://pinboard.in): tagi i streszczenia od AI, wbudowany czytnik z tłumaczeniem i zakreśleniami oraz 13 motywów dla samej strony.

> **Uwaga:** Wymaga konta Pinboard.in — [Pinboard](https://pinboard.in) to niezależna, **płatna** usługa zakładek. To rozszerzenie jest klientem innej firmy, który łączy się z Twoim istniejącym kontem Pinboard za pomocą Twojego własnego tokena API Pinboard. Nie jest powiązane z Pinboard, sponsorowane ani autoryzowane przez Pinboard. Aby korzystać z tego rozszerzenia, musisz już mieć (lub założyć) płatne konto Pinboard.in.

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Zapis z tagami i streszczeniem od AI, w motywie ciemnym i jasnym](docs/screenshots/readme/hero.webp)

---

## Funkcje

### Zapisywanie
- **Jedno kliknięcie i wszystko wypełnione** — tytuł, opis i zaznaczony tekst trafiają na miejsce, a z adresu URL znikają parametry śledzące
- **Zapis skrótem klawiszowym** — bez otwierania okienka; można też zapisać naraz wszystkie otwarte karty
- **Działa offline** — zapisy trafiają do lokalnej kolejki i są ponawiane po odzyskaniu połączenia
- **Szkice nie przepadają** — zamknij okno w trakcie edycji i wróć do pisania w tym samym miejscu

### Tagi
- **Tagi i streszczenie od AI** — AI czyta treść artykułu bez reklam, menu i pasków bocznych; własny klucz API, 14 dostawców lub dowolny endpoint zgodny z OpenAI
- **Autouzupełnianie** — z własnych tagów, podpowiedzi Pinboarda i gotowych zestawów na jedno kliknięcie
- **Porządki w tagach** — znajdź duplikaty i rzadko używane tagi, po czym scal je partiami

### Czytanie
- **Każda strona staje się czytelna** — widok Markdown ze spisem treści, wyszukiwaniem i podglądem przypisów; wzory, diagramy i tabele wyświetlają się poprawnie
- **Zakreślenia w pięciu kolorach, z notatkami** — jedne i drugie przetrwają ponowne renderowanie, tłumaczenie, a nawet zmiany na stronie
- **Przetłumacz stronę albo zadaj jej pytanie** — tłumaczenie całości z widokiem dwujęzycznym; odpowiedzi cytują źródło i prowadzą prosto do niego
- **Sprawdzaj słownictwo podczas czytania** — słownik pokazuje najpierw znaczenie pasujące do bieżącego zdania; zapisane słówka wyślesz jednym kliknięciem do Anki lub Eudic, a do wyboru masz też słowniki offline chińsko-angielski i angielsko-chiński
- **Notatki i słówka mają własną stronę** — zapisane słówka i zakreślenia w jednym miejscu, z wyszukiwaniem w słowniku i zarządzaniem partiami
- **Wyślij albo pobierz** — do [Obsidiana](https://obsidian.md), Notion, NotebookLM, do serwisu GitHub Gist lub dowolnego webhooka; albo jako `.md`, `.html`, `.epub` na czytnik e-booków
- **Oglądaj podczas czytania** — filmy z YouTube i Bilibili wyświetlają się obok transkrypcji, która podąża za odtwarzaniem; tagi i podsumowania AI mogą czytać napisy

![Czytelny widok z tłumaczeniem dwujęzycznym i zakreśleniami](docs/screenshots/readme/reader.webp)

![Zadaj stronie pytanie — odpowiedzi cytują źródło](docs/screenshots/readme/ask.webp)

![Strona notatek: zakreślenia z jednego artykułu jako ciągły wypis](docs/screenshots/readme/notes.webp)

![Zapisane słówko z kontekstem i kolumną słownika](docs/screenshots/readme/vocab.webp)

![Podgląd YouTube z transkrypcją podążającą za odtwarzaniem](docs/screenshots/readme/video.webp)

### Personalizacja
- **13 motywów dla pinboard.in** (Dracula · Nord · Catppuccin · Solarized · …) oraz własny CSS
- **Automatyczna archiwizacja w [Wayback Machine](https://web.archive.org)** — opcjonalnie przy każdym zapisie; strony pozostają dostępne, nawet gdy oryginalny link przestanie działać
- **Kopie zapasowe i synchronizacja** — ustawienia przez Chrome Sync, słówka oraz opcjonalnie zaznaczenia i notatki przez własny Dysk Google; ręczna kopia JSON może zawierać zaznaczenia, notatki, słówka i klucze API; wszystko jest opcjonalne, zakres opisano niżej w sekcji „Prywatność”
- **9 języków** · konfigurowalne skróty · dane przede wszystkim lokalnie · zero śledzenia

![13 motywów dla pinboard.in](docs/screenshots/readme/themes.webp)

## Instalacja

**[→ Zainstaluj z Chrome Web Store](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** — zalecane

Lub załaduj rozpakowane z ZIP-a release:
1. Pobierz najnowszy [ZIP z release](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. Rozpakuj
3. `chrome://extensions/` → włącz **Tryb dewelopera** → **Załaduj rozpakowane** → wybierz rozpakowany folder

Katalog źródłowy ma osobny, stały identyfikator deweloperski, dlatego podczas testów może działać obok wersji z Chrome Web Store. ZIP z release używa identyfikatora Chrome Web Store i nie może działać jednocześnie z wersją sklepową w tym samym profilu Chrome. Ustawienia będą wspólne dzięki Chrome Sync, gdy na każdym urządzeniu włączysz ich synchronizację. Przed zastąpieniem starszego release wczytanego ręcznie wyeksportuj jego ustawienia, a po wczytaniu nowego release zaimportuj kopię zapasową.

Po instalacji: kliknij ikonę paska narzędzi → wklej swój [token API Pinboard](https://pinboard.in/settings/password) → zapisz

## Prywatność

Bez śledzenia, bez analityki, bez telemetrii. W przypadku nowych użytkowników ustawienia i dane uwierzytelniające pozostają domyślnie na tym urządzeniu. Synchronizację zwykłych ustawień włącza się osobno na każdym urządzeniu. Synchronizacja danych uwierzytelniających jest jednym wyborem dla całego konta Chrome, ale uczestniczą w niej tylko urządzenia z włączoną synchronizacją ustawień; pozostałe nadal używają lokalnych danych uwierzytelniających. Dla nowych użytkowników jest domyślnie wyłączona. Jeśli podczas aktualizacji w Chrome Sync są już niepuste dane uwierzytelniające, pozostaje włączona, aby uniknąć utraty danych. Po włączeniu klucze API, tokeny, hasła i dane uwierzytelniające eksportu są udostępniane przez Chrome Sync; są jedynie zaciemnione, a nie zaszyfrowane. Zapisane zakładki, zawartość stron i kolejka offline nigdy nie trafiają do Chrome Sync. Zapytania AI są wysyłane **tylko** przez funkcje, które włączysz lub wywołasz — Tagi AI/Streszczenie AI, pytania o stronę, tłumaczenie, wyjaśnienie zaznaczenia lub opcjonalne podsumowanie kluczowych punktów — i trafiają bezpośrednio do skonfigurowanego dostawcy. Podczas instalacji przyznawany jest tylko dostęp do Pinboard; AI, Jina, witryny wybrane do przetwarzania wsadowego oraz opcjonalne miejsca docelowe eksportu i archiwizacji proszą tylko o uprawnienie do konkretnej witryny podczas wykonywania odpowiedniej operacji. Niestandardowe punkty końcowe sieci muszą używać HTTPS; HTTP jest dozwolone tylko dla `localhost`, `127.0.0.1` i `[::1]`. Strony rozszerzenia egzekwują restrykcyjną politykę Content-Security-Policy (bez zdalnego kodu). Pełna polityka: <https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

Z Dyskiem Google łączysz się osobno na każdym urządzeniu. Synchronizowane są tylko wybrane dane bieżącego konta Pinboard: po połączeniu słówka są domyślnie wybrane, a zaznaczenia i notatki wymagają osobnego włączenia. Wybór pozostaje na urządzeniu. Kopie w prywatnym folderze appDataFolder Dysku są zapisane jawnym tekstem, bez szyfrowania end-to-end.

## Licencja

MIT — patrz [LICENSE](LICENSE).
