# Bookmark Enhanced

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | **Français** | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md)

Une extension Chrome pour [Pinboard](https://pinboard.in), Karakeep et linkding : étiquettes et résumés par IA, lecteur avec traduction et surlignage, et 13 thèmes pour pinboard.in.

> **Remarque :** Choisissez votre service de signets dans les paramètres. Karakeep et linkding fonctionnent sans compte Pinboard. Pinboard est un service indépendant **payant**, qui nécessite votre propre compte et votre jeton API. Cette extension tierce n’est ni affiliée à Pinboard, ni sponsorisée ou approuvée par Pinboard.

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Enregistrement avec étiquettes et résumé par IA, en thème sombre et clair](docs/screenshots/readme/hero.webp)

[![Vidéo d’une minute : enregistrer, lire, garder](docs/screenshots/readme/promo-video.webp)](https://youtu.be/f3F8Se2rnoc)

---

## Fonctionnalités

### Enregistrer
- **Enregistrez dans le service de votre choix** : Pinboard, Karakeep ou linkding, avec le titre, la description et le texte sélectionné déjà remplis.
- **Étiquettes et résumés par IA** : suggérés à partir de l’article lui-même, avec votre propre clé API.
- **Aucun enregistrement perdu** : les enregistrements faits hors ligne patientent dans une file d’attente et partent dès que la connexion revient.

### Lire
- **Un lecteur épuré pour chaque page** : sans publicités ni barres latérales, avec surlignage en cinq couleurs et notes.
- **Lisez en deux langues** : traduisez toute la page en gardant l’original à côté.
- **Interrogez la page** : les réponses citent l’article et renvoient directement à la phrase citée.
- **Consultez le dictionnaire sur place** : définitions et prononciation sans quitter la page ; envoyez les mots enregistrés vers Anki.
- **Regarder en lisant** : les vidéos YouTube et Bilibili s’affichent à côté d’une transcription qui suit la lecture.

![Lecture claire avec traduction bilingue et surlignages](docs/screenshots/readme/reader.webp)

![Posez vos questions à la page, les réponses citent la source](docs/screenshots/readme/ask.webp)

![Aperçu YouTube avec une transcription qui suit la lecture](docs/screenshots/readme/video.webp)

### Garder
- **Une bibliothèque pour tout ce que vous gardez** : surlignages, notes, mots enregistrés et questions passées, synchronisés via votre propre Google Drive.
- **Envoyer ou télécharger** : vers [Obsidian](https://obsidian.md), Notion et d’autres services, ou en `.md`, `.html` ou `.epub`.

![Page des notes : les surlignages d’un article réunis en un seul extrait](docs/screenshots/readme/notes.webp)

![Mot enregistré avec son contexte et une colonne de dictionnaire](docs/screenshots/readme/vocab.webp)

### Un Pinboard à votre image
- **13 thèmes pour pinboard.in** : Dracula, Nord, Catppuccin et d’autres, plus votre propre CSS.
- **Nettoyage des étiquettes** : fusionnez les étiquettes quasi identiques et élaguez celles qui servent peu.
- **Archivage automatique dans la [Wayback Machine](https://web.archive.org)** : les pages enregistrées restent lisibles même quand le lien d’origine disparaît.

![13 thèmes pour pinboard.in](docs/screenshots/readme/themes.webp)

## Installation

**[→ Installer depuis le Chrome Web Store](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** (recommandé)

Ou chargez une version décompressée depuis un ZIP de release :
1. Téléchargez le dernier [ZIP de release](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. Décompressez
3. `chrome://extensions/` → activez le **Mode développeur** → **Charger l’extension non empaquetée** → sélectionnez le dossier décompressé

Ouvrez ensuite **Paramètres → Compte** et connectez votre service de signets : un [jeton API](https://pinboard.in/settings/password) pour Pinboard, ou l’adresse de votre serveur et un jeton API pour Karakeep (version 0.31 ou ultérieure) ou linkding.

## Confidentialité

Aucun pistage, aucune analytique, aucune télémétrie. Les paramètres et les clés restent sur cet appareil, sauf si vous activez la synchronisation ; les clés synchronisées sont obfusquées, pas chiffrées. Les requêtes IA ne partent que vers le fournisseur que vous avez configuré, et seulement lorsque vous utilisez une fonctionnalité IA. En dehors de Pinboard, l’extension demande l’accès à chaque site dont elle a besoin, un par un, la première fois que vous utilisez la fonctionnalité concernée. Les copies Google Drive sont stockées dans le dossier d’application privé de l’extension et ne sont pas chiffrées de bout en bout. Politique complète : <https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

## Licence

MIT. Voir [LICENSE](LICENSE).
