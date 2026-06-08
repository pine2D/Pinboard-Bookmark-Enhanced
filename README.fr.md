# Pinboard Bookmark Enhanced

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | **Français** | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md)

Une extension Chrome qui booste les signets [Pinboard](https://pinboard.in) avec tags et résumés par IA, et une interface entièrement personnalisable.

> **Remarque :** Nécessite un compte Pinboard.in — [Pinboard](https://pinboard.in) (pinboard.in) est un service de signets indépendant et **payant**. Cette extension est un client tiers qui se connecte à votre compte Pinboard existant à l'aide de votre propre jeton API Pinboard. Elle n'est ni affiliée à Pinboard, ni sponsorisée ou approuvée par Pinboard. Vous devez déjà posséder (ou souscrire à) un compte Pinboard.in payant pour utiliser cette extension.

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Popup demo](docs/screenshots/demo-popup.png)

---

## Fonctionnalités

- **Capture intelligente** — pré-remplit titre, URL, méta-description, referrer et texte sélectionné, et retire les paramètres de tracking (`utm_*`, `gclid`, `fbclid`, …) de l'URL enregistrée lors de la capture ou du collage, avec un mode agressif et des listes personnalisées à conserver ou supprimer
- **Tags et résumés IA** — votre propre clé pour 13 fournisseurs LLM populaires, ou tout endpoint compatible OpenAI ; l'IA reçoit le corps de l'article nettoyé — publicités, menus et barres latérales supprimés
- **Assistant de tags** — autocomplétion depuis vos propres tags, les tags suggérés par Pinboard et des presets de tags en un clic
- **Sauvegarde rapide** — enregistrez la page (ou en *à lire plus tard*) directement depuis un raccourci clavier, sans ouvrir la popup ; ou sauvegardez en groupe tous les onglets ouverts, avec tagging IA par onglet et progression en direct, et regroupez-les dans un Tab Set
- **Rechercher et retrouver** — cherchez dans vos signets, accédez aux Non lus / Réseau / Notes / Populaires et parcourez vos enregistrements récents ; l'icône de la barre d'outils change quand la page courante est déjà dans vos signets
- **File d'attente hors-ligne** — les brouillons persistent localement et se synchronisent à la reconnexion
- **Thèmes pour `pinboard.in`** — 13 palettes soignées (Dracula · Nord · Catppuccin · Solarized · Flexoki · Gruvbox · …) plus un calque CSS personnalisé synchronisé entre vos appareils, avec une largeur de popup ajustable
- **Page vers Markdown** — convertir la page courante en Markdown propre, avec un aperçu intégré (vues rendu/source, table des matières, statistiques de lecture) ; copier ou télécharger en `.md` ou en `.html` mis en forme, ajuster le frontmatter, la gestion des images et l'inclusion de la table des matières, ou exporter en option vers [Obsidian](https://obsidian.md) ; choisissez [defuddle](https://github.com/kepano/defuddle) + [Turndown](https://github.com/mixmark-io/turndown) (local) ou [Jina Reader](https://jina.ai/reader) (cloud)
- **9 langues** · raccourcis clavier configurables · aucun tracking

## Installation

**[→ Installer depuis le Chrome Web Store](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** — recommandé

Ou chargez une version décompressée depuis un ZIP de release :
1. Téléchargez le dernier [ZIP de release](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. Décompressez
3. `chrome://extensions/` → activez le **Mode développeur** → **Charger l'extension non empaquetée** → sélectionnez le dossier décompressé

Après l'installation : cliquez sur l'icône de la barre d'outils → collez votre [jeton API Pinboard](https://pinboard.in/settings/password) → enregistrez

## Confidentialité

Aucun tracking, aucune analytique, aucune télémétrie. Toutes les données sont stockées sur votre appareil via `chrome.storage` ; si vous activez la synchronisation des paramètres, vos paramètres (pas vos signets enregistrés) se synchronisent entre vos appareils via votre compte Chrome. Les requêtes IA se déclenchent **uniquement** quand vous cliquez sur « Tags IA » ou « Résumé IA » et vont directement au fournisseur configuré. Politique complète : <https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## Licence

MIT — voir [LICENSE](LICENSE).
