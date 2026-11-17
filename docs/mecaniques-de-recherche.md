# Mécaniques de recherche

Ragator ne répond pas à toutes les questions de la même façon. Selon ce qui est demandé, il prend un
**chemin** différent : compter, citer un passage, parcourir des dizaines de vidéos, remonter le temps.
Ce document décrit chaque chemin :
- quand il s'applique ;
- ses étapes ;
- les modèles qu'il appelle ;
- ce que le code garantit ;
- ce qu'il coûte en temps.

Le détail des composants (indexation, recherche hybride, base) est dans
[fonctionnement.md](fonctionnement.md).

Tous les modèles passent par OpenRouter :

| Rôle | Modèle |
|---|---|
| Analyse de la question et rédaction | gpt-6-luna |
| Juge des vidéos (questions générales) | `typesafe/jev-1.13` (seuil 0,3) |
| Vecteurs | `perplexity/pplx-embed-v1-4b` |

Tous les chemins acceptent une **collection** (une chaîne YouTube, voir
[fonctionnement.md](fonctionnement.md#31-collection-relance-et-aiguillage)) : chaque requête se
limite alors aux vidéos de cette chaîne, et la ligne « Corpus » en tête des prompts la nomme.

## Vue d'ensemble

```mermaid
flowchart TD
  Q[Question] --> F{Relance ?<br/>« et dans cette vidéo ? »}
  F --> A[Aiguillage<br/>règles + analyse LLM]
  A -->|lister| L{ordre ?}
  L -->|non| D[Décompte exact]
  L -->|première / dernière| M[Première / dernière mention]
  A -->|chercher, précise| P[Réponse citée]
  A -->|chercher, générale| G[Tri par le juge,<br/>puis rédaction]
  A -->|chercher, générale,<br/>première / dernière fois| C[Parcours chronologique]
  C -.->|aucune vidéo retenue| G
  A -->|plan| V[Plans visuels]
  A -->|infos| I[Descriptions YouTube]
  A -->|clarifier| R[Demande de reformulation]
```

| Chemin | Exemple | Modèles appelés | Temps typique |
|---|---|---|---|
| [Réponse citée](#2-réponse-citée) | « Quel firmware pour transformer un ESP32 en répéteur Wi-Fi ? » | LLM | ~5 s |
| [Tri par le juge](#3-tri-par-le-juge-puis-rédaction) | « Quand utilisent-ils de la résine époxy ? » | juge + LLM | ~12 s |
| [Parcours chronologique](#4-parcours-chronologique) | « La première fois qu'ils utilisent une scie circulaire Einhell » | juge + LLM | ~4 s |
| [Décompte exact](#5-décompte-exact) | « Toutes les vidéos où on parle de NordVPN » | aucun | ~2 s |
| [Première / dernière mention](#6-première--dernière-mention) | « La première mention du PLA » | aucun | ~2 s |
| [Plans visuels](#7-plans-visuels) | « À quel moment voit-on un tournevis ? » | LLM | — |
| [Descriptions YouTube](#8-descriptions-youtube) | « Le lien du firmware de la caméra » | LLM | — |
| [Crédits](#8-bis-crédits) | « Quand Alice Martin a monté la vidéo ? » | aucun | — |
| [Reformulation](#9-reformulation) | « Montre-moi un truc cool » | aucun | immédiat |

Le temps de l'aiguillage est compris : l'analyse par LLM prend ~1 s.

## 1. L'aiguillage, commun à tous les chemins

`repondre()` (`src/core/answer.ts`) est la seule fonction de réponse : l'interface web, la ligne de
commande et le serveur MCP l'appellent tous.

1. **Relance** (`src/core/followup.ts`). « Et dans cette vidéo ? », « et celle du manoir ? » sont
   rattachées à la vidéo de l'échange précédent, retrouvée par le code (5 échanges gardés au plus).
   L'historique ne sert qu'à retrouver la référence, jamais de preuve. Si plusieurs vidéos
   conviennent, Ragator demande laquelle.
2. **Règles** (`src/core/classify.ts`), déterministes et testables sans LLM. Elles reconnaissent :
   - les décomptes (« toutes les vidéos où… ») ;
   - les formules « première / dernière » ;
   - les demandes de description (« le lien de… ») ;
   - les plans (« à quel moment voit-on… ») ;
   - la **portée** : paroles (« on parle de »), image (« on voit »), texte à l'écran, ou tout.
3. **Analyse par LLM** (`src/core/analyze.ts`, à température 0). Elle propose :

   | Champ | Rôle | Validé par le code |
   |---|---|---|
   | route | le chemin | une route étroite (plan, infos, clarifier) seulement si les règles l'ont aussi choisie |
   | générale | plusieurs vidéos attendues ? | « quand parlent-ils de X » reste générale, jamais un décompte |
   | ordre | première / dernière | les règles l'emportent quand elles le repèrent |
   | terme, variantes | le mot à compter | présent dans le corpus ; variantes de moins de 3 lettres écartées |
   | mots-clés | synonymes, catégories | absents du corpus : écartés |
   | passage | un extrait inventé qui ressemblerait à la réponse (HyDE) | jamais une preuve, seulement un vecteur de recherche |
   | exigences | marque, modèle, nom propre imposé (« Ryobi », « xTool P2 ») | ramené à une forme du corpus (alias, correction orthographique) |
   | sujet | l'objet d'une « première / dernière fois » (« scie circulaire ») | présent dans le corpus |
   | série | le nom d'une série que la question désigne par ses titres (« les vidéos de la régie/gaming room » → « régie », « gaming room ») | ramené aux vidéos dont le titre le contient (voir [Séries](#séries-nommées-par-la-question)) |

   Sans LLM, c'est-à-dire en mode « Extraits seuls » ou sans clé OpenRouter, les règles décident seules.

### Séries nommées par la question

« Quand est-ce qu'une femme apparaît dans les vidéos de la régie/gaming room ? » limite la question à
un ensemble de vidéos, nommé par leurs titres (« La RÉGIE GAMING ROOM est DINGUE… - EP03 »). Laissé
dans la requête, ce mot rare prendrait toute la place : les extraits retenus parleraient de la régie,
pas du sujet. `src/core/series.ts` :

1. ramène chaque nom proposé par l'analyse aux vidéos dont le titre contient ses mots, dans l'ordre
   (accents et majuscules repliés) ; au-delà de 12 vidéos, c'est un thème (« gaming »), pas une série :
   aucun filtre, et la note de l'analyse le dit ;
2. fait de ces vidéos un **filtre** de tous les chemins (recherche, plans, descriptions, décompte),
   comme une vidéo citée ; le nom est retiré des mots-clés ;
3. **lit la série en entier** quand elle tient dans le contexte du modèle (~74 000 caractères), dans la
   portée de la question : plans seuls pour « on voit », « apparaît », paroles comprises sinon. La
   rédaction est celle d'une réponse citée, sans juge ; l'interface affiche « vidéos de la série lues
   en entier » ;
4. sinon, la recherche classée reste limitée à la série, sur **la question privée du nom** (« … une
   femme apparaît dans les vidéos de la ? »).

Pourquoi lire plutôt que classer : le plan qui répond peut ne pas contenir le mot de la question
(« collaboratrice » pour « femme »), et les vecteurs ne le rapprochent pas toujours. Lue en entier, la
série n'oublie aucun plan.

## 2. Réponse citée

**Quand** : une question précise, qui attend un fait, un moment ou une explication.

1. **Recherche hybride** (`src/core/search.ts`). Jusqu'à six listes classées, fusionnées par RRF :
   - BM25 sur les fenêtres de 2 min, avec correction orthographique ;
   - vecteurs des phrases et des blocs de 30 s ;
   - et, pour les questions générales, mots-clés, HyDE et enrichissement des blocs.
   
   Deux mots voisins dont la forme collée existe dans le corpus (« placo plâtre » → « placoplâtre »)
   ajoutent une liste et comptent comme preuves sous les deux formes.

   Dans chaque fenêtre, la **meilleure preuve** (le lien horodaté, le centre de l'extrait court) est
   la ligne qui porte le plus de mots de la question, puis la plus proche par les vecteurs. Sans aucun
   mot de la question, une réplique de moins de 3 mots signifiants (« La fibre. », « Oui. ») passe après
   les autres lignes : son vecteur, presque vide de sens, est proche de toute question courte.

   Si un quart des mots de la question sont absents du corpus, le LLM propose deux reformulations.
2. **Passages** (`src/core/passages.ts`). Les 50 meilleures fenêtres deviennent des extraits :
   - complets autour des preuves pour les 3 premières, courts ensuite ;
   - 3 au plus par vidéo, ~25 000 caractères en tout.
3. **Rédaction en sortie structurée** : `{ refus, claims: [{ text, sourceIds }] }`. Chaque ligne des
   extraits porte un identifiant court (`s12`), et le schéma n'autorise que les identifiants fournis.
4. **Validation** (`src/core/citations.ts`). Le code :
   - rattache chaque identifiant à sa vraie ligne ;
   - retire toute affirmation sans preuve valable ;
   - ajoute lui-même les références `[vidéo @ mm:ss]` et les liens horodatés.
   
   S'il ne reste aucune affirmation, c'est un repli extractif signalé. Pas de preuve : **refus**
   explicite.

**Garantie** : chaque phrase de la réponse cite un extrait réellement fourni au modèle.

## 3. Tri par le juge, puis rédaction

**Quand** : une question générale, qui attend plusieurs vidéos (« quand utilisent-ils… », « dans
quels projets… »). Aucun contexte ne contiendrait 40 vidéos, et un LLM en oublie : d'où un tri vidéo
par vidéo (`src/core/general.ts`).

1. **Recherche profonde par vidéo** (`src/core/video-rank.ts`) : 1 000 fenêtres, puis les vidéos
   classées par score cumulé, 2 passages chacune. Un sujet large donne 200 à 300 candidates. Chaque
   passage est complet (jusqu'à 90 s autour des preuves), pas réduit à quelques secondes autour d'une
   ligne : la phrase qui répond est souvent voisine de celle qui nomme le sujet.
2. **Le juge** (`src/providers/judge.ts`) répond pour chaque vidéo à « ces extraits répondent-ils à
   la question, prise au mot ? » et rend une probabilité. « Quand utilisent-ils X » exige qu'ils
   l'utilisent : en parler ne suffit pas. Il juge **par vagues** : 150 vidéos, puis 100 de plus tant
   que la vague précédente en a gardé au moins un quart.
3. **Rédaction** : une phrase par vidéo retenue, par lots de 6, en parallèle. Le juge trie déjà ; luna
   peut seulement laisser vide une vidéo dont les extraits ne répondent pas.
4. **Présentation** :
   - les vidéos les plus sûres d'abord ;
   - celles retenues de justesse (probabilité < 0,5) sous « Pertinence incertaine, à vérifier » ;
   - si la question impose une marque ou un modèle, les vidéos qui ne le citent pas sous
     « Éventuellement ».

**Garantie** : rien n'est retiré en silence ; ce qui est douteux est signalé comme tel.

## 4. Parcours chronologique

**Quand** : « la première / dernière fois qu'ils **font** quelque chose » (utiliser, tester,
fabriquer), avec un sujet identifiable. Une seule vidéo est attendue, et une seule erreur sur la plus
ancienne fausse la réponse : le tri global du chemin 3 n'y suffit pas (`src/core/first-time.ts`).

1. **Candidates exactes, dans l'ordre du temps** : toutes les vidéos qui citent le sujet et, s'il y
   en a, une exigence (paroles, plans ou texte à l'écran). Elles sont triées de la plus ancienne à la
   plus récente, ou l'inverse pour « la dernière fois ». Sans sujet, l'exigence en tient lieu (« la
   xTool P2 »).
2. **Candidates par le sens**, s'il y a des candidates exactes : une vidéo plus ancienne peut montrer
   le geste avec d'autres mots (« graveuse laser » pour « gravure au laser »). La question et son
   extrait hypothétique (HyDE) sont encodés ; leurs phrases et blocs les plus proches (HNSW, collection
   respectée) désignent des vidéos, classées par RRF. Des 24 plus proches, les 8 plus anciennes (ou
   récentes) qui citent l'exigence, s'il y en a une, rejoignent la liste à leur date, avec leurs
   3 moments les plus proches.
3. **Chaque moment jugé séparément** : chaque endroit où le sujet apparaît est élargi (20 s avant,
   90 s après) et reçoit sa propre décision du juge. Une introduction bavarde ne cache
   plus la scène d'usage. Une vidéo trouvée par le sens ne cite pas le sujet : le
   juge doit lui donner au moins 0,7 au lieu du seuil habituel.
4. **Arrêt à la première vidéo retenue**, examinée par vagues de 4 : en général après 1 à 5 vidéos.
5. **Lien entre la marque et le sujet** : une vidéo retenue où la marque n'est jamais sur la même
   ligne que le sujet, et que son titre ne nomme pas (« Ryobi » sur un cloueur, une scie à côté), est
   signalée en « Éventuellement, plus tôt », et le parcours continue.
6. **Rédaction** de la vidéo retenue, sans la rejuger.

Sans candidate exacte, ou sans vidéo retenue parmi les 24 premières, la question repart par le
chemin 3.

## 5. Décompte exact

**Quand** : « toutes les vidéos où… », « combien de fois… », « dans combien de vidéos… »
(`src/core/exhaustive.ts`, `src/core/list-videos.ts`).

1. **Résolution du terme** vers une forme réellement présente dans l'index, avec ses alias de marque
   (« Nord VPN » → `nordvpn`, `src/norm/brands.ts`). S'il est absent, la forme la plus proche est
   proposée et signalée.
2. **Comptage SQL** des lignes qui contiennent le terme entier, vidéo par vidéo, dans la portée
   demandée. La recherche se limite à une vidéo si la question en cite une.

**Garantie** : le compte est exact. C'est une requête, pas une estimation d'un modèle.

## 6. Première / dernière mention

**Quand** : la première ou la dernière fois qu'un mot est **dit ou montré** (« la première mention du
PLA », « quand ont-ils parlé de X pour la première fois »).

C'est le décompte exact du chemin 5, trié par date de publication. La plus ancienne (ou la plus
récente) vidéo vient en tête, avec l'extrait de sa première mention, puis la liste complète.

**Pourquoi pas une recherche classée** : elle rend les passages les plus pertinents, pas tous. Le
plus ancien d'entre eux n'est pas forcément la première mention.

## 7. Plans visuels

**Quand** : « à quel moment voit-on… », « dans quelle vidéo voit-on… », « le texte X à l'écran »
(`src/core/search-plans.ts`).

1. **Recherche dans les seuls plans visuels** : titre, description et texte lu à l'écran, classés par
   BM25. Si aucun plan ne contient le mot, c'est une recherche hybride restreinte aux plans.
2. **Rédaction citée**, comme au chemin 2, avec un avertissement : une description de plan est une
   annotation automatique, pas une vérification de l'image.

## 8. Descriptions YouTube

**Quand** : un lien, un fichier, un firmware, une référence de pièce, le matériel
(`src/core/video-info.ts`).

Ragator cherche dans les titres et les descriptions YouTube, puis rédige une réponse citée. Ces
sources n'ont pas d'instant : la réponse renvoie à la vidéo, sans horodatage inventé.

## 8 bis. Crédits

**Quand** : qui a monté, cadré, mixé, écrit, animé, sous-titré une vidéo (« quand Alice Martin a
monté la vidéo », « quelles vidéos Bruno Durand a-t-il cadrées », « qui sont les monteurs ? »)
(`src/core/credits.ts`). Ni les paroles ni les plans ne le disent : ce sont les lignes de crédit des
descriptions (« Montage : Alice Martin », « Animations 3D et montage additionnel : Bruno Durand »).

1. **Reconnaissance**, par les règles, avant tout le reste : un verbe ou un nom de métier, appliqué à
   une vidéo (« monté la vidéo ») ou nommé (« le montage », « monteur »). « Ils ont monté la cuisine »
   reste une recherche : dans une chaîne de bricolage, « monter » est d'abord un geste.
2. **Lecture des crédits** : une ligne « Rôle : noms » dont l'intitulé commence par un métier
   (« Caméra GH5 : lien » est du matériel, écarté).
3. **Réponse construite par le code**, exhaustive :
   - une personne nommée : toutes les vidéos où elle est créditée pour ce rôle, de la plus ancienne à la
     plus récente, chacune avec sa ligne de crédit ;
   - une vidéo ou une série visée : ses crédits ;
   - sinon : le bilan des personnes créditées, avec leur nombre de vidéos et leurs années.

**Garantie** : la liste est complète pour ce que disent les descriptions ; une vidéo sans ligne de
crédit n'y figure pas.

## 9. Reformulation

**Quand** : une intention de décompte sans terme identifiable, une question trop vague, ou une
relance qui pourrait viser plusieurs vidéos. Ragator propose des formulations au lieu de chercher au
hasard.

## Modes de réponse

Ils se choisissent dans l'interface :

| Mode | Effet |
|---|---|
| **Détaillée** (défaut) | autant d'affirmations que nécessaire, dans l'ordre logique |
| **Courte** | 1 à 3 affirmations |
| **Extraits seuls, sans analyse LLM** | ni analyse ni rédaction par un LLM : aiguillage par règles, meilleurs extraits cités tels quels ; décomptes et premières mentions inchangés |

## Replis

Une étape indisponible dégrade la réponse sans l'empêcher, et la raison est affichée :

| Panne | Repli |
|---|---|
| Saturation passagère (429, 5xx) | nouvelle tentative, deux fois en quelques secondes |
| Pas de clé, ou encodeur injoignable | recherche par mots seule |
| LLM en erreur | réponse extractive : les meilleurs extraits, cités, sans rédaction |
| Juge en erreur | parcours chronologique abandonné pour le chemin 3 ; si le juge reste en panne, réponse extractive |
| Un lot de rédaction en échec | réponse partielle, signalée |
