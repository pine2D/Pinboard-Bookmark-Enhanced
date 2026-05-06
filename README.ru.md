# Pinboard Bookmark Enhanced

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | **Русский**

Расширение Chrome, которое улучшает закладки [Pinboard](https://pinboard.in) AI-метками, аннотациями и полностью настраиваемым интерфейсом.

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Popup demo](docs/screenshots/demo-popup.png)

---

## Возможности

- **Умный захват** — автозаполнение заголовка, URL, мета-описания, реферера и выделенного текста. В AI отправляется очищенный текст статьи — без рекламы, меню и боковых панелей
- **AI-метки и аннотации** — свой ключ для 13 провайдеров (OpenAI · Anthropic · Gemini · DeepSeek · Qwen · Kimi · Zhipu · Groq · Mistral · MiniMax · Cohere · OpenRouter · Ollama) или любой OpenAI-совместимый эндпоинт
- **Пакетное сохранение** — захват всех открытых вкладок за раз, с AI-тегированием каждой вкладки и прогрессом в реальном времени
- **Определение сохранённых страниц** — иконка на панели меняется, когда текущая страница уже в ваших закладках
- **Темы для `pinboard.in`** — 13 тщательно подобранных палитр (Dracula · Nord · Catppuccin · Solarized · Flexoki · Gruvbox · …) плюс пользовательский CSS-оверлей, синхронизируемый между устройствами
- **Офлайн-очередь** — черновики сохраняются локально и синхронизируются при восстановлении связи
- **Страница в Markdown** — преобразуйте текущую страницу в чистый Markdown — предпросмотр, копирование в буфер или скачивание `.md`. Локально работает на [defuddle](https://github.com/kepano/defuddle) + [Turndown](https://github.com/mixmark-io/turndown), с [Jina Reader](https://jina.ai/reader) в качестве опционального облачного запасного варианта
- **9 языков**, настраиваемые горячие клавиши, никакого трекинга

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
