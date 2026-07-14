# Pinboard Bookmark Enhanced

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [日本語](README.ja.md) | **Polski** | [Русский](README.ru.md)

Rozszerzenie Chrome, które wzbogaca zakładki [Pinboard](https://pinboard.in) o tagi i streszczenia AI oraz w pełni konfigurowalny interfejs.

> **Uwaga:** Wymaga konta Pinboard.in — [Pinboard](https://pinboard.in) to niezależna, **płatna** usługa zakładek. To rozszerzenie jest klientem innej firmy, który łączy się z Twoim istniejącym kontem Pinboard za pomocą Twojego własnego tokena API Pinboard. Nie jest powiązane z Pinboard, sponsorowane ani autoryzowane przez Pinboard. Aby korzystać z tego rozszerzenia, musisz już mieć (lub założyć) płatne konto Pinboard.in.

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Popup demo](docs/screenshots/demo-popup.png)

---

## Funkcje

- **Inteligentne przechwytywanie** — automatycznie wypełnia tytuł, URL, meta-opis, referrer i zaznaczony tekst, a przy przechwytywaniu lub wklejaniu usuwa z zapisywanego adresu parametry śledzące (`utm_*`, `gclid`, `fbclid`, …) — z trybem agresywnym i własnymi listami parametrów do zachowania lub usunięcia
- **Zapis pojedynczy i zbiorczy** — zapisz stronę (lub odłóż ją *na później*) skrótem klawiszowym, bez otwierania okna; albo zapisz naraz wszystkie otwarte karty — z osobnym tagowaniem AI każdej z nich, postępem na żywo i spięciem ich w Zestaw kart (który również można przypisać do własnego skrótu klawiszowego); szkice offline pozostają w lokalnej kolejce, a po powrocie połączenia zapis w Pinboard jest automatycznie ponawiany
- **Tagi i streszczenia AI** — podłącz własny klucz do 13 dostawców LLM lub dowolnego endpointu zgodnego z OpenAI; do AI trafia oczyszczona treść artykułu — bez reklam, menu i pasków bocznych
- **Narzędzia do tagów** — autouzupełnianie z Twoich własnych tagów, tagów sugerowanych przez Pinboard oraz gotowych zestawów dodawanych jednym dotknięciem, a do tego panel porządkowania, który wychwytuje zduplikowane i rzadko używane tagi (heurystyka + grupowanie AI na żądanie) i scala je partiami w kontrolowanym tempie, z postępem na żywo
- **Szybkie odnośniki i status** — jednym dotknięciem do stron Nieprzeczytane, Sieć, Notatki i Popularne; ikona na pasku od razu pokazuje, czy bieżąca strona jest niezapisana, zapisana, czy zapisana *na później*
- **Strona do Markdown** — zamień bieżącą stronę w czysty Markdown z wbudowanym podglądem (widok renderowany/źródłowy, spis treści, statystyki czytania); skopiuj lub pobierz jako `.md`, stylizowany `.html` albo pojedynczy `.epub` (czytelny na Kindle/Kobo/KOReader), dopasuj frontmatter (w tym autora, datę publikacji, witrynę, obraz okładki i liczbę słów), sposób obsługi obrazów (zachowaj, usuń albo osadź offline) i spis treści lub wyślij stronę prosto do [Obsidian](https://obsidian.md), GitHub Gist lub dowolnego webhooka (kompatybilnego z Readwise). Ekstrakcja dopasowana do witryny zachowuje czytelność pytań i odpowiedzi, postów społecznościowych oraz wątków na forach (Zhihu, Hacker News, Stack Overflow, X/Twitter, …); wybierz [defuddle](https://github.com/kepano/defuddle) + [Turndown](https://github.com/mixmark-io/turndown) (lokalnie) lub [Jina Reader](https://jina.ai/reader) (w chmurze). Obrazy zablokowane przez ochronę przed hotlinkowaniem są wykrywane w podglądzie i przywracane jednym kliknięciem. Eksport ostrzega, gdy zachowane linki do obrazów już się nie wczytują — „Osadź” pakuje, co się da, do pobieranego pliku i zgłasza resztę.
- **Pytaj o stronę i tłumacz ją** — prosto z podglądu Markdown zadawaj pytania i otrzymuj odpowiedzi na bieżąco, ze zweryfikowanymi cytatami, które przenoszą cię do źródła; wyjaśnij lub przetłumacz na miejscu dowolny zaznaczony fragment (i zachowaj odpowiedź jako notatkę), albo przetłumacz całą stronę z własnym glosariuszem, zużyciem tokenów na żywo i widokami: oryginał / dwujęzyczny / tłumaczenie
- **Narzędzia czytelnika** — zaznaczaj tekst w pięciu kolorach z notatkami, które przetrwają ponowne renderowanie, tłumaczenie, a nawet zmiany treści strony (przesunięty tekst jest odnajdywany automatycznie; jeśli nie da się go zlokalizować, notatka zostaje zachowana i oznaczona — nigdy nie przepada), przeglądaj zaznaczenia w panelu notatnika, przeszukuj artykuł (`/`, opcjonalnie wyrażeniem regularnym — Twoje notatki też są przeszukiwane), podglądaj przypisy w miejscu, wróć dokładnie tam, gdzie skończyłeś, dostosuj rozmiar czcionki i interlinię w panelu Aa, wybierz szerokość czytania (680/880/1080 px), przejdź w tryb skupienia bez rozpraszaczy albo dodaj opcjonalne podsumowanie kluczowych punktów AI (domyślnie wyłączone); naciśnij `?`, aby zobaczyć pełną listę skrótów
- **Automatyczna archiwizacja** — jeśli zechcesz, każdy zapis trafi też do [Wayback Machine](https://web.archive.org) Internet Archive — z dziennikiem archiwizacji i ponawianiem prób, dzięki czemu Twoje linki przetrwają, nawet gdy oryginalna strona zniknie
- **Motywy dla `pinboard.in`** — 13 dopracowanych palet (Dracula · Nord · Catppuccin · Solarized · Flexoki · Gruvbox · …) plus własna nakładka CSS synchronizowana między urządzeniami, regulowana szerokość okna oraz sortowanie według popularności na stronach tagów
- **Kopia zapasowa ustawień** — wyeksportuj i zaimportuj wszystkie ustawienia (a opcjonalnie także zaznaczenia) jako plik albo automatycznie twórz kopię zapasową na własnym serwerze WebDAV (np. Nextcloud), dzięki czemu Twoja konfiguracja i własne motywy przenoszą się między urządzeniami
- **9 języków** · konfigurowalne skróty · pamięć lokalna w pierwszej kolejności · zero śledzenia

## Instalacja

**[→ Zainstaluj z Chrome Web Store](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** — zalecane

Lub załaduj rozpakowane z ZIP-a release:
1. Pobierz najnowszy [ZIP z release](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. Rozpakuj
3. `chrome://extensions/` → włącz **Tryb dewelopera** → **Załaduj rozpakowane** → wybierz rozpakowany folder

Po instalacji: kliknij ikonę paska narzędzi → wklej swój [token API Pinboard](https://pinboard.in/settings/password) → zapisz

## Prywatność

Bez śledzenia, bez analityki, bez telemetrii. W przypadku nowych użytkowników ustawienia i dane uwierzytelniające pozostają domyślnie na tym urządzeniu. Synchronizację zwykłych ustawień włącza się osobno na każdym urządzeniu. Synchronizacja danych uwierzytelniających jest jednym wyborem dla całego konta Chrome, ale uczestniczą w niej tylko urządzenia z włączoną synchronizacją ustawień; pozostałe nadal używają lokalnych danych uwierzytelniających. Dla nowych użytkowników jest domyślnie wyłączona. Jeśli podczas aktualizacji w Chrome Sync są już niepuste dane uwierzytelniające, pozostaje włączona, aby uniknąć utraty danych. Po włączeniu klucze API, tokeny, hasła i dane uwierzytelniające eksportu są udostępniane przez Chrome Sync; są jedynie zaciemnione, a nie zaszyfrowane. Zapisane zakładki, zawartość stron i kolejka offline nigdy nie trafiają do Chrome Sync. Zapytania AI są wysyłane **tylko** przez funkcje, które włączysz lub wywołasz — Tagi AI/Streszczenie AI, pytania o stronę, tłumaczenie, wyjaśnienie zaznaczenia lub opcjonalne podsumowanie kluczowych punktów — i trafiają bezpośrednio do skonfigurowanego dostawcy. Podczas instalacji przyznawany jest tylko dostęp do Pinboard; AI, Jina, witryny wybrane do przetwarzania wsadowego oraz opcjonalne miejsca docelowe eksportu, archiwizacji i kopii zapasowych proszą tylko o uprawnienie do konkretnej witryny podczas wykonywania odpowiedniej operacji. Niestandardowe punkty końcowe sieci muszą używać HTTPS; HTTP jest dozwolone tylko dla `localhost`, `127.0.0.1` i `[::1]`. Strony rozszerzenia egzekwują restrykcyjną politykę Content-Security-Policy (bez zdalnego kodu). Pełna polityka: <https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## Licencja

MIT — patrz [LICENSE](LICENSE).
