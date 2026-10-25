# Pinboard Bookmark Enhanced

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [繁體中文（香港）](README.zh-HK.md) | [Deutsch](README.de.md) | **Français** | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md)

Une extension Chrome pour [Pinboard](https://pinboard.in) : étiquettes et résumés par IA, un mode lecture intégré avec traduction et surlignage, et 13 thèmes pour le site lui-même.

> **Remarque :** Nécessite un compte Pinboard.in — [Pinboard](https://pinboard.in) (pinboard.in) est un service de signets indépendant et **payant**. Cette extension est un client tiers qui se connecte à votre compte Pinboard existant à l'aide de votre propre jeton API Pinboard. Elle n'est ni affiliée à Pinboard, ni sponsorisée ou approuvée par Pinboard. Vous devez déjà posséder (ou souscrire à) un compte Pinboard.in payant pour utiliser cette extension.

[![Chrome](https://img.shields.io/badge/Chrome-MV3-brightgreen?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Version](https://img.shields.io/github/v/release/pine2D/Pinboard-Bookmark-Enhanced?label=version)](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Enregistrement avec étiquettes et résumé par IA, en thème sombre et clair](docs/screenshots/readme/hero.webp)

[![Vidéo de 30 secondes : enregistrer, lire, garder](docs/screenshots/readme/promo-video.webp)](https://youtu.be/DMQS8LC09kU)

---

## Fonctionnalités

### Enregistrer
- **Un clic, tout est rempli** : titre, description et texte sélectionné sont repris, les paramètres de suivi retirés de l'URL
- **Raccourcis et enregistrement groupé** : enregistrez sans ouvrir le popup, ou mettez d'un coup tous les onglets de la fenêtre en signets
- **Fonctionne hors ligne** : les enregistrements passent par une file d'attente locale et sont renvoyés au retour de la connexion
- **Brouillons préservés** : fermez la fenêtre en pleine saisie et reprenez là où vous en étiez

### Étiquettes
- **Étiquettes et résumé par IA** : l'IA lit le corps de l'article, débarrassé des publicités, des menus et des barres latérales ; votre propre clé API, 14 fournisseurs ou tout point de terminaison compatible OpenAI
- **Autocomplétion** : à partir de vos étiquettes, des suggestions de Pinboard et de préréglages en un clic
- **Nettoyage des étiquettes** : fusionnez les étiquettes quasi identiques et élaguez celles qui servent peu

### Lecture
- **Chaque page passe en mode lecture épuré** : vue Markdown avec table des matières, recherche et aperçu des notes de bas de page ; formules, diagrammes et tableaux s'affichent correctement
- **GitHub Discussions (phase pilote)** : conserve le message initial et les commentaires chargés, la structure des réponses et la réponse acceptée ; précise le contenu récupéré
- **Gérez vos signets pendant la lecture** : enregistrez, modifiez ou supprimez le signet Pinboard de l’article sans revenir au popup
- **Surlignage en cinq couleurs, avec notes** : les deux restent à leur place après une traduction, et même si la page change ensuite
- **Traduisez la page ou posez-lui vos questions** : traduction intégrale avec vue bilingue ; les réponses citent la source et y renvoient d'un clic
- **Conservez les questions et réponses avec leurs citations** : les réponses terminées sont enregistrées automatiquement et synchronisées via Google Drive. Retrouvez les conversations dans la bibliothèque, poursuivez-les dans le lecteur ou exportez-les seules ou avec l’article. Les conversations temporaires ne sont pas enregistrées.
- **Cherchez les mots au fil de la lecture** : consultez les définitions et la prononciation ; envoyez les mots enregistrés vers Anki ou Eudic en un clic, et ajoutez si vous le souhaitez des dictionnaires hors connexion chinois-anglais et anglais-chinois. Choisissez la langue des définitions des entrées IA indépendamment de l’interface et filtrez les mots enregistrés par langue. Redimensionnez la fenêtre de recherche en faisant glisser ses bords ou déplacez-la dans le panneau latéral : les résultats, la définition sélectionnée et la génération en cours sont conservés.
- **Dictionnaires multilingues hors connexion** : consultez les définitions et les prononciations sur cet appareil grâce aux fichiers ZIP Yomitan v3 que vous importez ; les dictionnaires sont exclus de la synchronisation Drive et des sauvegardes JSON. Tous les dictionnaires hors connexion, y compris chinois–anglais et anglais–chinois, peuvent être désactivés sans supprimer leurs données. Lorsque la structure est reconnue, les définitions sont séparées des exemples et de l’origine du mot ; les autres contenus restent lisibles sous forme d’entrées complètes. Réimporter les anciens dictionnaires permet de réanalyser leur structure sans modifier le vocabulaire enregistré ni leur état activé ou désactivé.
- **Entrées de dictionnaire IA**: obtenez d’abord les définitions, la prononciation et des exemples dans votre langue maternelle ou la langue choisie. Demandez séparément l’étymologie, les mots associés, des conseils d’usage et des exemples littéraires sourcés. Si un complément est incomplet, ses éléments valides restent disponibles et vous pouvez demander uniquement les éléments manquants. Google Drive synchronise les résultats complets une fois connecté ; les mises à jour conservent les versions précédentes. Choisissez le dictionnaire ou l’IA à l’ouverture ; la génération automatique des entrées de base reste facultative.
- **Comprenez la sélection dans son contexte** : utilisez Expliquer pour comprendre un mot ou un passage de l’article en cours ; le dictionnaire présente ses sens et usages généraux.
- **Votre bibliothèque** : retrouvez surlignages, notes, mots et conversations enregistrées au même endroit, avec consultation du dictionnaire et gestion du vocabulaire par lots. Enregistrez des mots directement depuis les résultats, choisissez une définition et reliez les formes d’un mot grâce à une forme de base modifiable. Chaque mot conserve ses notes et son état d’apprentissage.
- **Exporter le vocabulaire complet** : choisissez un type de note Anki multilingue distinct pour différencier les mots de même orthographe dans plusieurs langues. Le TSV complet conserve les notes, les formes de base et chaque contexte avec sa source ; les formats d’origine à six champs restent disponibles
- **Envoyer ou télécharger** : vers [Obsidian](https://obsidian.md), Notion, NotebookLM, un Gist GitHub ou n'importe quel webhook ; ou en `.md`, `.html`, `.epub` pour votre liseuse
- **Regarder en lisant** : les vidéos YouTube et Bilibili s'affichent à côté d'une transcription qui suit la lecture ; les tags et résumés IA peuvent lire les sous-titres

![Lecture claire avec traduction bilingue et surlignages](docs/screenshots/readme/reader.webp)

![Posez vos questions à la page, les réponses citent la source](docs/screenshots/readme/ask.webp)

![Page des notes : les surlignages d'un article réunis en un seul extrait](docs/screenshots/readme/notes.webp)

![Mot enregistré avec son contexte et une colonne de dictionnaire](docs/screenshots/readme/vocab.webp)

![Aperçu YouTube avec une transcription qui suit la lecture](docs/screenshots/readme/video.webp)

### Personnalisation
- **13 thèmes pour pinboard.in** (Dracula · Nord · Catppuccin · Solarized · …) plus votre CSS personnalisé
- **Archivage automatique dans la [Wayback Machine](https://web.archive.org)** : chaque page enregistrée est capturée et reste lisible même quand le lien d'origine disparaît
- **Sauvegarde et synchronisation**: Chrome Sync pour les réglages, votre Google Drive pour le vocabulaire, les surlignages, les notes, les entrées IA et les conversations ; les sauvegardes JSON couvrent les réglages, le vocabulaire, les surlignages et les notes
- **9 langues** · raccourcis configurables · stockage local en priorité · aucun pistage

![13 thèmes pour pinboard.in](docs/screenshots/readme/themes.webp)

## Installation

**[→ Installer depuis le Chrome Web Store](https://chromewebstore.google.com/detail/pinboard-bookmark-enhance/pnjndmjhljjbdlbejeenkepdalokfooh)** (recommandé)

Ou chargez une version décompressée depuis un ZIP de release :
1. Téléchargez le dernier [ZIP de release](https://github.com/pine2D/Pinboard-Bookmark-Enhanced/releases/latest)
2. Décompressez
3. `chrome://extensions/` → activez le **Mode développeur** → **Charger l'extension non empaquetée** → sélectionnez le dossier décompressé

Le répertoire source utilise un identifiant de développement distinct et fixe. Il peut donc coexister avec la version du Chrome Web Store pour les tests. Le ZIP de release utilise l'identifiant du Chrome Web Store et ne peut pas coexister avec la version du Store dans un même profil Chrome. Chrome Sync peut partager les paramètres dès que leur synchronisation est activée sur chaque appareil. Avant de remplacer une ancienne release chargée manuellement, cliquez sur **Exporter une sauvegarde** dans ses paramètres ; après avoir chargé la nouvelle release, utilisez **Importer une sauvegarde**.

Après l'installation : cliquez sur l'icône de la barre d'outils → collez votre [jeton API Pinboard](https://pinboard.in/settings/password) → **Se connecter**

## Confidentialité

Aucun tracking, aucune analytique, aucune télémétrie. Pour les nouveaux utilisateurs, les paramètres et identifiants restent par défaut sur cet appareil. La synchronisation des paramètres ordinaires s'active séparément sur chaque appareil. La synchronisation des identifiants est un choix unique à l'échelle du compte Chrome, mais seuls les appareils où la synchronisation des paramètres est activée y participent ; les autres continuent d'utiliser leurs identifiants locaux. Elle est désactivée par défaut pour les nouveaux utilisateurs. Si une mise à niveau trouve déjà des identifiants non vides dans Chrome Sync, elle reste activée afin d'éviter toute perte de données. Lorsqu'elle est activée, les clés API, jetons, mots de passe et identifiants d'exportation sont partagés via Chrome Sync ; ils sont obfusqués, pas chiffrés. Les signets enregistrés, le contenu des pages et la file d'attente hors ligne n'entrent jamais dans Chrome Sync. Les requêtes IA proviennent **uniquement** des fonctionnalités IA que vous activez ou utilisez, et vont directement au fournisseur que vous avez configuré. À l'installation, seul l'accès à Pinboard est accordé. Tout autre site dont l'extension a besoin (fournisseur d'IA, destination d'exportation ou d'archivage, dictionnaire, Google Drive, sous-titres vidéo ou sites d'un enregistrement groupé) est demandé un site précis à la fois, la première fois que vous utilisez la fonctionnalité concernée. Les points de terminaison réseau personnalisés doivent utiliser HTTPS ; HTTP n'est autorisé que pour `localhost`, `127.0.0.1` et `[::1]`. Les pages de l'extension appliquent une Content-Security-Policy stricte (aucun code distant). Politique complète : <https://pine2d.github.io/Pinboard-Bookmark-Enhanced/privacy.html>

Google Drive se connecte séparément sur chaque appareil, puis synchronise le vocabulaire, les surlignages, les notes, les entrées IA complètes avec leurs compléments et les conversations enregistrées avec leurs extraits sources pour le compte Pinboard actuel. Les copies dans le dossier privé appDataFolder sont en texte clair, sans chiffrement de bout en bout. Les sources facultatives sur l’origine des mots viennent du Wiktionnaire ; les compléments littéraires et culturels demandés utilisent des passages de Wikisource ou de Wikipédia. L’extension vérifie le texte source et transmet de courts extraits et leurs métadonnées au fournisseur d’IA choisi. Les autres exemples pédagogiques sont rédigés par l’IA. Les résultats déjà payés sont conservés ; une nouvelle version est générée uniquement sur demande.

Mettez à jour l’extension sur tous les appareils qui synchronisent le vocabulaire. Cette version lit les données existantes, mais les anciennes versions ne peuvent pas recevoir les modifications de vocabulaire enregistrées par cette version.

## Licence

MIT. Voir [LICENSE](LICENSE).
