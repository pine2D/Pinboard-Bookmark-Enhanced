# Bookmark Enhanced

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | **Русский**

Расширение Chrome для [Pinboard](https://pinboard.in), [Karakeep](https://karakeep.app) и [linkding](https://linkding.link): AI-теги и краткое содержание, режим чтения с переводом и выделениями, а также 13 тем для pinboard.in.

> **Примечание:** Выберите сервис закладок в настройках. Karakeep и linkding работают без аккаунта Pinboard. Pinboard — независимый **платный** сервис, для которого нужны собственный аккаунт и API-токен. Это стороннее расширение не связано с Pinboard, не спонсируется и не одобряется им.

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Сохранение с AI-тегами и резюме, тёмная и светлая темы](docs/screenshots/readme/hero.webp)

[![Минутное видео: сохранить, прочитать, оставить себе](docs/screenshots/readme/promo-video.webp)](https://youtu.be/f3F8Se2rnoc)

---

## Возможности

### Сохранение
- **Сохраняйте в выбранный сервис** — Pinboard, Karakeep или linkding, с уже заполненными заголовком, описанием и выделенным текстом.
- **AI-теги и краткое содержание** — подбираются по самой статье с вашим собственным API-ключом.
- **Сохраняйте без сети** — закладки подождут и отправятся, когда вы снова будете в сети.

### Чтение
- **Чистый режим чтения для любой страницы** — без рекламы и боковых панелей, с выделениями и заметками.
- **Читайте на двух языках** — переведите всю страницу, а оригинал останется рядом.
- **Спросите страницу** — ответы ссылаются на статью, а один клик переносит к процитированному предложению.
- **Ищите слова по ходу чтения** — смотрите определения и произношение, не уходя со страницы, и отправляйте сохранённые слова в Anki.
- **Смотрите, пока читаете** — видео с YouTube и bilibili идут рядом с расшифровкой, которая следует за воспроизведением.

![Режим чтения с двуязычным переводом и выделениями](docs/screenshots/readme/reader.webp)

![Задайте странице вопрос — ответы ссылаются на источник](docs/screenshots/readme/ask.webp)

![Видео YouTube в режиме чтения с расшифровкой, которая следует за воспроизведением](docs/screenshots/readme/video.webp)

### Хранение
- **Всё важное в одной библиотеке** — выделения, заметки, словарик и прошлые вопросы синхронизируются через ваш собственный Google Диск.
- **Отправить или скачать** — отправьте в [Obsidian](https://obsidian.md), Notion и другие сервисы либо скачайте файлом `.md`, `.html` или `.epub`.

![Страница заметок: выделения из одной статьи единой выдержкой](docs/screenshots/readme/notes.webp)

![Сохранённое слово с контекстом и колонкой словаря](docs/screenshots/readme/vocab.webp)

### Pinboard под себя
- **13 тем для pinboard.in** — светлое и тёмное оформление сайта, плюс собственный CSS.
- **Порядок в тегах** — объединяйте почти одинаковые теги и убирайте те, что почти не используете.
- **Автоархив в [Wayback Machine](https://web.archive.org)** — сохранённые страницы можно будет прочитать, даже когда исходная ссылка перестанет работать.

![13 тем для pinboard.in](docs/screenshots/readme/themes.webp)

## Установка

**[→ Установить из Chrome Web Store](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** — рекомендуется

Или загрузите распакованное расширение из ZIP с релизом:
1. Скачайте последний [ZIP с релизом](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. Распакуйте
3. `chrome://extensions/` → включите **Режим разработчика** → **Загрузить распакованное расширение** → выберите распакованную папку

Затем откройте **Настройки → Аккаунт** и подключите сервис закладок: для Pinboard нужен [API-токен](https://pinboard.in/settings/password), для Karakeep (версии 0.31 или новее) и linkding — адрес сервера и API-токен.

## Конфиденциальность

Расширение не отслеживает вас и не собирает данные об использовании. Настройки и ключи остаются на этом устройстве, пока вы не включите синхронизацию; синхронизируемые ключи только обфусцированы, но не зашифрованы. AI-запросы уходят только настроенному вами провайдеру и только тогда, когда вы пользуетесь AI-функцией. Для любого сайта, кроме Pinboard, расширение запрашивает доступ, когда вы впервые пользуетесь функцией, которой он нужен. Копии на Google Диске хранятся в закрытой папке приложения и не защищены сквозным шифрованием. Полная политика: <https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## Лицензия

MIT — см. [LICENSE](LICENSE).
