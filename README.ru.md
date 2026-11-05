# Bookmark Enhanced

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | **Русский**

Расширение Chrome для [Pinboard](https://pinboard.in), Karakeep и linkding: AI-теги и краткое содержание, режим чтения с переводом и выделениями, а также 13 тем для pinboard.in.

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
- **Ни одна закладка не потеряется** — сохранённое без сети ждёт в очереди и отправляется, как только связь восстановится.

### Чтение
- **Чистый режим чтения для любой страницы** — без рекламы и боковых панелей, с выделениями пяти цветов и заметками.
- **Читайте на двух языках** — переведите всю страницу, а оригинал останется рядом.
- **Спросите страницу** — ответы ссылаются на статью и ведут прямо к процитированному предложению.
- **Ищите слова, не уходя со страницы** — определения и произношение под рукой, а сохранённые слова можно отправить в Anki.
- **Смотрите, пока читаете** — видео с YouTube и bilibili идут рядом с расшифровкой, которая следует за воспроизведением.

![Режим чтения с двуязычным переводом и выделениями](docs/screenshots/readme/reader.webp)

![Задайте странице вопрос — ответы ссылаются на источник](docs/screenshots/readme/ask.webp)

![Видео YouTube в режиме чтения с расшифровкой, которая следует за воспроизведением](docs/screenshots/readme/video.webp)

### Хранение
- **Всё важное в одной библиотеке** — выделения, заметки, словарик и прошлые вопросы синхронизируются через ваш собственный Google Диск.
- **Отправить или скачать** — в [Obsidian](https://obsidian.md), Notion и другие сервисы либо файлом `.md`, `.html` или `.epub`.

![Страница заметок: выделения из одной статьи единой выдержкой](docs/screenshots/readme/notes.webp)

![Сохранённое слово с контекстом и колонкой словаря](docs/screenshots/readme/vocab.webp)

### Pinboard под себя
- **13 тем для pinboard.in** — Dracula, Nord, Catppuccin и другие, плюс собственный CSS.
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

Никакого трекинга, аналитики или телеметрии. Настройки и ключи остаются на этом устройстве, пока вы не включите синхронизацию; синхронизируемые ключи только обфусцированы, но не зашифрованы. AI-запросы уходят только настроенному вами провайдеру и только тогда, когда вы пользуетесь AI-функцией. Помимо Pinboard, расширение запрашивает доступ к каждому нужному сайту по отдельности, когда вы впервые пользуетесь соответствующей функцией. Копии на Google Диске хранятся в закрытой папке приложения и не защищены сквозным шифрованием. Полная политика: <https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## Лицензия

MIT — см. [LICENSE](LICENSE).
