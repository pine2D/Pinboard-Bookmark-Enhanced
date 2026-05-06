# Pinboard Bookmark Enhanced

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | **Français** | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md)

Une extension Chrome qui booste les signets [Pinboard](https://pinboard.in) avec tags et résumés par IA, et une interface entièrement personnalisable.

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Popup demo](docs/screenshots/demo-popup.png)

---

## Fonctionnalités

- **Capture intelligente** — pré-remplit titre, URL, méta-description, referrer et texte sélectionné. L'IA reçoit le corps de l'article nettoyé — publicités, menus et barres latérales supprimés
- **Tags et résumés IA** — votre propre clé pour 13 fournisseurs (OpenAI · Anthropic · Gemini · DeepSeek · Qwen · Kimi · Zhipu · Groq · Mistral · MiniMax · Cohere · OpenRouter · Ollama) ou tout endpoint compatible OpenAI
- **Sauvegarde groupée** — capturer tous les onglets ouverts d'un coup, avec tagging IA par onglet et progression en direct
- **Détection des pages déjà sauvegardées** — l'icône change quand la page courante est déjà dans vos signets
- **Thèmes pour `pinboard.in`** — 13 palettes soignées (Dracula · Nord · Catppuccin · Solarized · Flexoki · Gruvbox · …) plus un calque CSS personnalisé synchronisé entre vos appareils
- **File d'attente hors-ligne** — les brouillons persistent localement et se synchronisent à la reconnexion
- **Page vers Markdown** — convertir la page courante en Markdown propre — aperçu, copie dans le presse-papier ou téléchargement en `.md`. Propulsé localement par [defuddle](https://github.com/kepano/defuddle) + [Turndown](https://github.com/mixmark-io/turndown), avec [Jina Reader](https://jina.ai/reader) en repli cloud optionnel
- **9 langues**, raccourcis clavier configurables, aucun tracking

## Installation

**[→ Installer depuis le Chrome Web Store](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** — recommandé

Ou chargez une version décompressée depuis un ZIP de release :
1. Téléchargez le dernier [ZIP de release](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. Décompressez
3. `chrome://extensions/` → activez le **Mode développeur** → **Charger l'extension non empaquetée** → sélectionnez le dossier décompressé

Après l'installation : cliquez sur l'icône de la barre d'outils → collez votre [jeton API Pinboard](https://pinboard.in/settings/password) → enregistrez

## Confidentialité

Aucun tracking, aucune analytique, aucune télémétrie. Toutes les données restent sur votre appareil via `chrome.storage`. Les requêtes IA se déclenchent **uniquement** quand vous cliquez sur « Tags IA » ou « Résumé IA » et vont directement au fournisseur configuré. Politique complète : <https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## Licence

MIT — voir [LICENSE](LICENSE).
