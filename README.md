# Space Overview pour Zen Browser

Une vue d'ensemble de tous tes spaces, façon Mission Control de macOS. Un raccourci
dézoome sur une grille de tous les spaces avec un aperçu de leur dernier onglet. Tu
choisis au clavier et `Entrée` zoome dans le space choisi.

## Utilisation

| Touche | Action |
| --- | --- |
| `Ctrl`+`Alt`+`W` | Ouvrir / fermer la vue d'ensemble (configurable) |
| `←` `↑` `→` `↓`, `Tab` | Se déplacer dans la grille |
| `Alt`+flèches (ou `Maj`+flèches) | Déplacer le space sélectionné dans l'ordre |
| `Entrée` ou `Espace` | Ouvrir le space sélectionné |
| `1` … `9`, `0` | Ouvrir directement le space n° 1 à 10 |
| Taper du texte | Filtrer par nom de space ou par titre/URL d'onglet |
| `Retour arrière` | Effacer une lettre du filtre (`Ctrl`+`Retour arrière` : tout) |
| `Échap` | Effacer le filtre, puis fermer |

Quand le filtre trouve un onglet (et pas seulement un nom de space), la carte affiche
cet onglet et `Entrée` ouvre le space directement sur lui. Ça sert aussi de recherche
d'onglets à travers tous les spaces.

La souris marche aussi : clic sur une carte pour l'ouvrir, clic sur le fond pour fermer.

## Réordonner les spaces

Glisse une carte à sa nouvelle place, ou sélectionne-la et utilise `Alt`+flèches. Le
nouvel ordre est celui de Zen : la barre latérale, les numéros des raccourcis « Switch to
Workspace » et les autres fenêtres suivent. Le réordonnancement est désactivé pendant un
filtre, car les positions affichées ne correspondent alors plus à l'ordre complet.

## Aperçus

Chaque carte montre le dernier onglet utilisé dans le space :

- si l'onglet est chargé, l'aperçu est pris en direct à l'ouverture ;
- s'il a été déchargé, la carte montre la dernière image prise quand tu as quitté ce
  space ;
- sinon, la carte montre l'icône et le titre de l'onglet sur le dégradé du space.

Les aperçus restent en mémoire et ne sont jamais écrits sur le disque.

## Installation avec Sine

1. Installe [Sine](https://github.com/CosmoCreeper/Sine) si ce n'est pas déjà fait.
2. Dans Zen, ouvre Paramètres > **Sine Mods**, clique sur l'icône des réglages de Sine
   (*Open settings*) et coche **Enable installing JS from unofficial sources**. Sine ne
   charge le JavaScript d'un mod hors de son store qu'avec cette option.
3. Toujours dans Sine Mods, sous le Marketplace, colle l'adresse du dépôt GitHub du mod
   dans le champ *add your own locally from a GitHub repo* et clique sur **Install**.
4. Redémarre Zen. Au besoin, vide d'abord le cache de démarrage depuis `about:support`.

Les réglages (raccourci, aperçus, animations) sont dans la fiche du mod, dans Sine.

## Installation avec fx-autoconfig

Copie `space-overview.uc.js` dans le dossier `chrome/JS/` de ton profil Zen, puis
vide le cache de démarrage et redémarre.

## Réglages

Les réglages sont des préférences de `about:config` :

| Préférence | Défaut | Rôle |
| --- | --- | --- |
| `zen.space-overview.shortcut` | `Ctrl+Alt+W` | Raccourci, par ex. `Ctrl+Shift+Space` ou `Alt+F1` |
| `zen.space-overview.thumbnails` | `true` | Aperçus des pages |
| `zen.space-overview.animations` | `true` | Animation de zoom, désactivée aussi si le système demande moins d'animations |

Un nouveau raccourci s'applique sans redémarrage.

## Compatibilité

Le mod s'appuie sur l'API interne de Zen (`gZenWorkspaces`), qui n'est pas documentée
et change d'une version à l'autre. Le code se protège des variations connues, mais une
mise à jour de Zen peut le casser. En cas de souci, regarde la console du navigateur
(`Ctrl`+`Shift`+`J`) et cherche les lignes `[Space Overview]`.
