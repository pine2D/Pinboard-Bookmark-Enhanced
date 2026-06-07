# Pinboard Bookmark Enhanced

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | **Русский**

Расширение Chrome, которое улучшает закладки [Pinboard](https://pinboard.in) AI-метками, аннотациями и полностью настраиваемым интерфейсом.

> **Примечание:** Это независимый сторонний клиент для [Pinboard](https://pinboard.in) — **платного** сервиса закладок. Для использования нужны собственный аккаунт Pinboard.in и API-токен. Не связан с Pinboard и не одобрен им.

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Popup demo](docs/screenshots/demo-popup.png)

---

## Возможности

- **Умный захват** — автозаполнение заголовка, URL, мета-описания, реферера и выделенного текста, а также удаление трекинг-параметров (`utm_*`, `gclid`, `fbclid`, …) из сохраняемого URL при захвате или вставке, с агрессивным режимом и собственными списками сохраняемых и удаляемых параметров
- **AI-метки и аннотации** — свой ключ для 13 популярных LLM-провайдеров или любого OpenAI-совместимого эндпоинта; AI читает очищенный текст статьи — без рекламы, меню и боковых панелей
- **Помощник по меткам** — автодополнение из ваших меток, предложенных Pinboard меток и пресетов меток в одно нажатие
- **Быстрое сохранение** — сохраняйте страницу (или как *прочитать позже*) прямо с горячей клавиши, без открытия попапа; либо пакетно сохраняйте все открытые вкладки с AI-тегированием каждой вкладки и прогрессом в реальном времени, объединяя их в набор вкладок (Tab Set)
- **Поиск и возврат** — ищите по своим закладкам, переходите к Unread / Network / Notes / Popular и просматривайте недавние сохранения; иконка на панели меняется, когда текущая страница уже в ваших закладках
- **Офлайн-очередь** — черновики сохраняются локально и синхронизируются при восстановлении связи
- **Темы для `pinboard.in`** — 13 тщательно подобранных палитр (Dracula · Nord · Catppuccin · Solarized · Flexoki · Gruvbox · …) плюс пользовательский CSS-оверлей, синхронизируемый между устройствами, с регулируемой шириной попапа
- **Страница в Markdown** — преобразуйте текущую страницу в чистый Markdown со встроенным предпросмотром (режимы рендеринга/исходника, оглавление, статистика чтения); копируйте или скачивайте как `.md` или стилизованный `.html`, настраивайте front-matter, обработку изображений и включение оглавления либо по желанию экспортируйте в [Obsidian](https://obsidian.md); выберите [defuddle](https://github.com/kepano/defuddle) + [Turndown](https://github.com/mixmark-io/turndown) (локально) или [Jina Reader](https://jina.ai/reader) (облако)
- **9 языков** · настраиваемые горячие клавиши · никакого трекинга

## Установка

**[→ Установить из Chrome Web Store](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** — рекомендуется

Или загрузите распакованное расширение из ZIP с релизом:
1. Скачайте последний [ZIP с релизом](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. Распакуйте
3. `chrome://extensions/` → включите **Режим разработчика** → **Загрузить распакованное расширение** → выберите распакованную папку

После установки: нажмите на иконку в панели инструментов → вставьте свой [API-токен Pinboard](https://pinboard.in/settings/password) → сохраните

## Конфиденциальность

Никакого трекинга, аналитики или телеметрии. Все данные остаются на вашем устройстве через `chrome.storage`. AI-запросы срабатывают **только** при нажатии «AI-метки» или «AI-аннотация» и отправляются напрямую настроенному провайдеру. Полная политика: <https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## Лицензия

MIT — см. [LICENSE](LICENSE).
