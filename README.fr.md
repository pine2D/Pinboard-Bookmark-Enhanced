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

- **Capture intelligente** — pré-remplit le titre, l'URL, la méta-description, le référent et le texte sélectionné, et supprime les paramètres de suivi (`utm_*`, `gclid`, `fbclid`, …) de l'URL enregistrée, que vous la capturiez ou la colliez, avec un mode agressif et des listes personnalisées d'éléments à conserver ou à retirer
- **Sauvegarde rapide et groupée** — enregistrez la page (ou marquez-la *à lire plus tard*) d'un simple raccourci clavier, sans ouvrir la popup, ou sauvegardez d'un coup tous les onglets ouverts, avec un étiquetage IA propre à chaque onglet, une progression en temps réel et un regroupement en Tab Set ; hors ligne, les brouillons sont mis en file d'attente et se synchronisent dès le retour de la connexion
- **Tags et résumés IA** — utilisez votre propre clé avec 13 fournisseurs de LLM ou n'importe quel point d'accès compatible OpenAI ; l'IA lit le corps de l'article épuré de ses publicités, menus et barres latérales
- **Outils de tags** — autocomplétion à partir de vos propres tags, des tags suggérés par Pinboard et de préréglages applicables en un clic, ainsi qu'un panneau de gouvernance qui repère les tags en double ou peu utilisés (par heuristique et par regroupement IA à la demande) et les fusionne par lots échelonnés, avec progression en temps réel
- **Liens rapides et statut** — accédez en un clic à vos pages Non lus, Réseau, Notes et Populaires ; l'icône de la barre d'outils change d'apparence lorsque la page courante figure déjà dans vos signets
- **Page vers Markdown** — convertit la page courante en Markdown épuré, avec un aperçu intégré (affichage rendu ou source, table des matières, statistiques de lecture) ; copiez-la ou téléchargez-la en `.md` ou en `.html` mis en forme, ajustez le frontmatter (notamment l'auteur, la date de publication, le site, l'image de couverture et le nombre de mots), le traitement des images et la table des matières, ou envoyez-la directement dans [Obsidian](https://obsidian.md), un Gist GitHub, ou n'importe quel webhook (compatible Readwise). L'extraction adaptée à chaque site préserve la lisibilité des questions-réponses, des posts sociaux et des fils de discussion (Zhihu, Hacker News, Stack Overflow, X/Twitter, …) ; à vous de choisir [defuddle](https://github.com/kepano/defuddle) + [Turndown](https://github.com/mixmark-io/turndown) (en local) ou [Jina Reader](https://jina.ai/reader) (dans le cloud)
- **Interroger et traduire la page** — depuis cet aperçu Markdown, posez vos questions et recevez des réponses diffusées en continu, assorties de citations vérifiées qui renvoient à la source ; faites expliquer ou traduire sur place n'importe quel passage sélectionné (et conservez la réponse sous forme de note), ou traduisez la page entière à l'aide d'un glossaire personnalisé, avec suivi en temps réel de la consommation de tokens, au choix en affichage original, bilingue ou traduit
- **Outils de lecture** — surlignez en cinq couleurs, avec des notes qui résistent aux nouveaux rendus et à la traduction, parcourez vos surlignages dans un panneau Carnet, recherchez dans l'article (`/`, regex en option — vos notes sont aussi prises en compte), prévisualisez les notes de bas de page sur place, reprenez la lecture là où vous l'aviez laissée, passez en mode concentration pour une lecture sans distraction, ou ajoutez un survol des points clés par IA, facultatif et désactivé par défaut ; appuyez sur `?` pour la liste complète des raccourcis
- **Archivage automatique** — envoyez si vous le souhaitez chaque enregistrement vers la [Wayback Machine](https://web.archive.org) d'Internet Archive, avec journal d'archivage et nouvelle tentative en cas d'échec, pour que vos liens restent accessibles même si la page d'origine disparaît
- **`pinboard.in` personnalisable** — 13 palettes soignées (Dracula · Nord · Catppuccin · Solarized · Flexoki · Gruvbox · …), auxquelles s'ajoutent une surcouche CSS personnalisée synchronisée entre vos appareils, une largeur de popup réglable et un tri par popularité sur les pages de tags
- **9 langues** · raccourcis configurables · stockage local en priorité · aucun pistage

## Installation

**[→ Installer depuis le Chrome Web Store](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** — recommandé

Ou chargez une version décompressée depuis un ZIP de release :
1. Téléchargez le dernier [ZIP de release](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. Décompressez
3. `chrome://extensions/` → activez le **Mode développeur** → **Charger l'extension non empaquetée** → sélectionnez le dossier décompressé

Après l'installation : cliquez sur l'icône de la barre d'outils → collez votre [jeton API Pinboard](https://pinboard.in/settings/password) → enregistrez

## Confidentialité

Aucun tracking, aucune analytique, aucune télémétrie. Toutes les données sont stockées sur votre appareil via `chrome.storage` ; si vous activez la synchronisation des paramètres, vos paramètres (pas vos signets enregistrés) se synchronisent entre vos appareils via votre compte Chrome. Les requêtes IA se déclenchent **uniquement** lorsque vous déclenchez explicitement une action IA — tags/résumé IA, questions-réponses sur la page, traduction, explication de sélection, ou le survol des points clés facultatif — et vont directement au fournisseur que vous avez configuré. Les pages de l'extension appliquent une Content-Security-Policy stricte (aucun code distant). Politique complète : <https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## Licence

MIT — voir [LICENSE](LICENSE).
