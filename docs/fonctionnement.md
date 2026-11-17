# Fonctionnement : le chemin de la donnée

Ce document suit une vidéo depuis son fichier JSON jusqu'à la réponse citée, puis
une question depuis sa saisie jusqu'à cette réponse. Chaque paramètre cité est
une constante du code.
Pour une vue d'ensemble des chemins que peut prendre une question, avec des exemples, voir
[mecaniques-de-recherche.md](mecaniques-de-recherche.md).

Deux modes, choisis dans l'interface web (onglet « Réglages »), suivent exactement le même chemin
avec des modèles différents :

| Rôle | Mode local (sur la machine) | Mode OpenRouter (API) |
|---|---|---|
| Analyse et rédaction | Qwen 3.5 9B (llama-server, carte graphique) | gpt-6-luna |
| Juge de pertinence (questions générales) | Aplomb 1 en 4 bits (carte graphique), seuil 0,4 | `typesafe/jev-1.13`, seuil 0,3 |
| Vecteurs | pplx-embed-v1-4b en GGUF Q8 (llama-server, processeur) | `perplexity/pplx-embed-v1-4b` |

Le texte ci-dessous cite surtout les modèles OpenRouter (luna, JEV) ; en mode local, Qwen et Aplomb
tiennent les mêmes rôles. Les vecteurs viennent du même encodeur dans les deux modes (à un cosinus de
0,98-0,99 près) : un index construit dans un mode sert tel quel dans l'autre. Seuls quelques réglages
changent, tous réunis dans `loadConfig` (`src/config.ts`) :
- le parallélisme et le contexte, ceux de llama-server (8 places, 81 920 tokens partagés) ;
- des délais plus longs, et pas de rédaction lancée par anticipation (la carte est partagée) ;
- le seuil du juge (0,4, car Aplomb note plus haut) ;
- la preuve recopiée mot pour mot avant chaque affirmation. Dans les questions générales, elle sert
  au rédacteur à revérifier chaque vidéo retenue par le juge (§3.5).

## 1. Le corpus d'entrée

Un fichier `video--<id>.json` par vidéo ([schéma](../schemas/corpus.schema.json)),
produit en amont par un modèle multimodal qui regarde la vidéo :

- `source` : titre, URL, chaîne, date de publication, durée ; la chaîne fixe la
  **collection** de la vidéo (voir §3.1) ;
- `youtubeDescription` : la description YouTube (liens, matériel, sponsors) ;
- `transcript` : les paroles horodatées, avec leur locuteur quand il est connu
  (une ingestion sans diarisation le laisse inconnu : les prompts interdisent
  alors d'attribuer la parole à une personne) ;
- `visualSegments` : les plans, chacun avec un titre, une description et le
  texte lu à l'écran (`screenText`), parfois des incertitudes déclarées ;
- `contentHash` : empreinte amont, qui rend l'ingestion idempotente.

Les horodatages sont estimés par le modèle amont : on les traite comme exacts à
quelques secondes près (les liens reculent de 3 s).

## 2. Indexation (`npm run update`)

`update` enchaîne trois étapes idempotentes ; chacune ne traite que ce qui a
changé et reprend là où elle s'est arrêtée.

### 2.1 Ingestion (`src/core/ingest.ts`)

Chaque fichier est validé contre le schéma, puis découpé en :

| Table | Contenu | Rôle |
|---|---|---|
| `videos` | métadonnées, description | titres, dates, liens |
| `entries` | une ligne par parole (`parole`) ou par plan (`visuel`) | **l'unité de preuve** : c'est elle qu'on cite (`Gu8bnHQaG5s:t00061`) |
| `windows` | fenêtres de 120 s, pas de 90 s (chevauchement de 30 s) | l'unité de recherche lexicale et de contexte |
| `chunks` | blocs fixes de 30 s : titre de la vidéo, titres des plans, paroles | l'unité de recherche sémantique « par sujet » |

Chaque entrée reçoit une forme normalisée (`norm_text` : minuscules, accents et
ponctuation retirés, marques ramenées à une forme canonique — « Nord VPN » →
`nordvpn`, voir `src/norm/brands.ts`). Une vidéo inchangée (même empreinte) n'est
pas réécrite ; une vidéo modifiée garde les vecteurs et l'enrichissement des
blocs dont le texte n'a pas changé.

### 2.2 Enrichissement (`src/core/enrich.ts`)

Une parole fait en moyenne 100 caractères, et un tiers en font moins de 40
(« ok on y va ») : leur sens dépend du reste de la vidéo. gpt-6-luna lit donc
chaque vidéo en entier (un appel par vidéo, par groupes de 40 blocs) et écrit
pour chaque bloc de 30 s :

- une **phrase de contexte** qui le situe (projet, étape, sujet) ;
- **3 à 6 mots-clés** qu'un spectateur taperait, catégories générales comprises
  (« blessure », « invité », « matériau de récupération »).

Le modèle d'enrichissement se choisit à part de celui des réponses (luna par défaut).
Il doit respecter la sortie JSON imposée ; un modèle qui
impose son raisonnement passe automatiquement au niveau `minimal`.

C'est la technique *Contextual Retrieval* d'Anthropic, doublée de *doc2query*.
Le texte enrichi est encodé avec le bloc et indexé en BM25 à part. Coût : environ
404 appels pour un corpus de 400 vidéos, quelques dizaines de centimes avec luna.

### 2.3 Vecteurs (`src/core/embed.ts`)

`perplexity/pplx-embed-v1-4b` (2 560 dimensions), via OpenRouter, encode par lots
de 64, quatre lots à la fois, les entrées (`search_text` : texte, titre du plan,
texte à l'écran) et les blocs (texte + enrichissement). Deux index HNSW
(`halfvec`, pgvector) sont construits ensuite. Ordre de grandeur pour un corpus de 400 vidéos : ~100 000 textes,
~12 min, ~0,25 $. Un seul modèle par base : en changer impose
`npm run embed -- --reset` puis une réindexation complète. Un refus « modèle
occupé » (429) est réessayé plusieurs fois avant d'abandonner le lot.
Le reset est refusé tant qu'un encodage est actif. Chaque lot publie ses vecteurs
et sa version d'index dans la même transaction : une erreur sur le lot suivant
laisse une version partielle exacte.

## 3. Une question

`repondre()` (`src/core/answer.ts`) est la seule fonction de réponse ; le CLI,
l'interface web et le serveur MCP l'appellent tous. Elle aiguille et collecte les
preuves ; les citations (`citations.ts`), les sources (`sources.ts`), le décompte
exhaustif (`exhaustive.ts`) et les questions générales (`general.ts`) ont chacun
leur module dans `src/core/`.

### 3.1 Collection, relance et aiguillage

0. **Collection** (`src/core/collections.ts`, migration 0007) : chaque vidéo
   appartient à la collection de sa chaîne, une colonne calculée par la base
   (`videos.collection`, par exemple `ma-chaine` pour « Ma Chaîne, sous-titre »). Une question peut se limiter à
   une collection : toutes les requêtes (BM25, vecteurs, décomptes, plans,
   descriptions, parcours chronologique, relances par titre) ajoutent alors
   `AND v.collection = …`. La chaîne complète, ou la liste des chaînes,
   ouvre chaque prompt (« Corpus : vidéos YouTube de la chaîne « … » ») : les
   prompts eux-mêmes ne nomment aucune chaîne.
1. **Relance** (`src/core/followup.ts`) : dans une conversation, « et dans cette
   vidéo ? » est rattachée à la vidéo de l'échange précédent. L'historique (5
   échanges au plus) ne donne que des références, jamais des preuves.
2. **Règles** (`src/core/classify.ts`) : un premier aiguillage déterministe,
   testable sans LLM, qui reconnaît les décomptes (« toutes les vidéos où… »),
   les demandes de description YouTube (« le lien du firmware »), les plans
   (« à quel moment voit-on… ») et la portée (paroles, image, texte à l'écran).
3. **Analyse par LLM** (`src/core/analyze.ts`) : luna propose la route, dit si la
   question est **générale** (plusieurs vidéos attendues), donne des mots-clés
   et un **extrait hypothétique** (HyDE : le passage qu'on s'attend à trouver). Elle
   repère aussi les **exigences** (marque, modèle ou nom propre imposé : « Ryobi »,
   « xTool P2 ») et, pour « la première / dernière fois qu'ils… », le **sujet**
   (« scie circulaire »), ramenés à une forme du corpus.
   Le code valide : un décompte exige un terme présent dans le corpus, les
   mots-clés absents du corpus sont écartés, une route étroite (plans seuls,
   descriptions seules) ou « clarifier » n'est acceptée que si les règles l'ont
   aussi choisie, et « quand parlent-ils de X » reste une question générale
   (jamais un décompte de mentions). L'analyse est demandée à température 0 :
   la même question est aiguillée de la même façon d'un appel à l'autre. Sans LLM — mode *Extraits seuls,
   sans analyse LLM* ou sans clé —, les règles décident seules.

Cinq routes en sortent :

| Route | Quand | Suite |
|---|---|---|
| `lister` | décompte exhaustif, ou première / dernière mention | §3.4, sans LLM |
| `chercher` | cas général | §3.2, puis §3.3 (précise) ou §3.5 (générale) |
| `plan` | « à quel moment voit-on… » | recherche dans les seuls plans visuels |
| `infos` | liens, firmware, matériel en description | titres et descriptions YouTube, sans instant |
| `clarifier` | intention exhaustive sans terme, référence ambiguë | demande de reformulation |

### 3.2 Recherche hybride (`src/core/search.ts`)

Jusqu'à six listes classées, fusionnées par **RRF** (*Reciprocal Rank Fusion* :
chaque fenêtre marque `poids / (60 + rang)` dans chaque liste) :

| Liste | Ce qu'elle trouve | Poids |
|---|---|---|
| BM25 sur les fenêtres (ParadeDB) | les mots exacts, avec correction orthographique des mots absents du corpus (distance ≤ 2) | 40 |
| Vecteurs des entrées | les phrases proches par le sens | 30 |
| Vecteurs des blocs de 30 s | les passages proches par le sujet | 30 |
| BM25 sur les mots-clés de l'analyse | les synonymes et catégories (questions générales) | 40 |
| Vecteurs de l'extrait hypothétique (HyDE) | les passages qui ressemblent à la réponse attendue (questions générales) | 30 |
| BM25 sur l'enrichissement des blocs | les passages que leur contexte décrit (questions générales) | 30 |

Pour une question précise dont une part des mots est absente du corpus (25 % ou
plus), luna propose au plus deux reformulations (liste « variantes », poids 40).

Chaque fenêtre retenue porte ses **preuves** : les entrées qui contiennent les
mots de la question ou qui en sont proches par le sens. La meilleure devient
l'instant cité.

### 3.3 Question précise : réponse citée

- Les 50 meilleures fenêtres deviennent des **passages** (`src/core/passages.ts`) :
  complets autour des preuves pour les 3 premières, courts ensuite (−3 s/+10 s),
  3 au plus par vidéo, dans un budget de ~25 000 caractères.
- Chaque ligne reçoit un **identifiant court** (`s12`), qui se recopie sans erreur.
- Luna répond en **sortie structurée** : `{ refus, claims: [{ text, sourceIds }] }`,
  où `sourceIds` ne peut prendre que les identifiants fournis (liste fermée dans
  le schéma JSON).
- Le code **valide** (`src/core/citations.ts`) : chaque identifiant est rattaché à sa vraie entrée ; une
  affirmation sans identifiant valable est retirée ; plus aucune, et c'est un
  repli extractif signalé. Une sortie hors du format imposé (texte libre) ne
  garde aucune affirmation : repli extractif, jamais de phrase sans preuve. Les
  références `[id @ mm:ss]` et les liens horodatés sont ajoutés par le code,
  jamais écrits par le modèle. La validation garantit qu'une citation désigne un
  extrait fourni, pas que l'extrait confirme la phrase : cette fidélité se relit, sans filtre automatique.

### 3.4 Décompte exhaustif : sans LLM (`src/core/exhaustive.ts`)

« Toutes les vidéos où on parle de NordVPN » : le terme est résolu vers une forme
réellement présente dans l'index (ou la plus proche, signalée), puis la base
compte les entrées qui le contiennent, vidéo par vidéo, dans la portée demandée
(paroles, plans, texte à l'écran), dans une seule vidéo si la question en cite
une (ou dans une relance « et dans cette vidéo ? »). Le décompte est exact :
c'est une requête SQL, pas une estimation d'un modèle.

« La première mention du PLA », « quand ont-ils parlé de X pour la première
fois », « la dernière vidéo avec X » — des **mentions** — prennent le même chemin,
avec un **ordre** :
les vidéos sont triées par date de publication et la plus ancienne (ou la plus
récente) vient en tête, avec l'extrait de sa première mention, puis la liste
complète. Une recherche classée ne convient pas ici : elle rend les passages les
plus pertinents, pas tous, et le plus ancien d'entre eux n'est pas forcément la
première mention. Les règles repèrent la formule ordinale (« première
mention », « pour la dernière fois », « la vidéo la plus ancienne ») et le terme,
et l'emportent sur luna pour la route, l'ordre et le terme ; « la première étape
de… » ou « leur premier projet » restent des recherches.

Une **action** n'est pas une mention : « la dernière fois où ils utilisent une
visseuse » demande un usage réel, que le mot seul ne prouve pas. Ces questions
(utiliser, tester, fabriquer, souder, imprimer…) suivent le parcours chronologique
(§3.5 bis) : les vidéos qui citent le sujet sont examinées dans l'ordre du temps,
moment par moment, jusqu'à la première où le juge voit l'usage.

### 3.5 Question générale : JEV juge, luna rédige (`src/core/general.ts`)

Une question comme « quand utilisent-ils de la résine époxy ? » peut concerner
40 vidéos : aucune fenêtre de contexte ne les contiendrait toutes, et un LLM qui
doit repérer 40 vidéos dans un long contexte en oublie. D'où trois temps :

1. **Recherche profonde par vidéo** (`src/core/video-rank.ts`) : 1 000 fenêtres
   (~1 s), puis les vidéos classées par score cumulé à rendement décroissant (1,
   0,25, 0,06… pour leurs meilleures fenêtres), 2 passages chacune. Un sujet
   large en donne 200 à 300 candidates.
2. **JEV** (`src/providers/judge.ts`) répond pour chaque vidéo, en parallèle, à
   « ces extraits répondent-ils à la question, prise au mot ? » et rend une
   probabilité calibrée. Comme le recommande sa documentation, la question et
   ses critères sont en anglais (sa langue d'entraînement principale), avec une
   définition et des exemples du oui et du non ; l'état (`question`,
   `video_title`, `excerpts`) reste en français. Il juge **par vagues** : les 150 vidéos les mieux
   classées, puis 100 de plus tant que la vague précédente en a gardé au moins
   25 %. Un sujet étroit s'arrête vite ; un sujet large va chercher des vidéos pertinentes bien
   au-delà des 150 premières. Les
   vidéos au-dessus de `JUDGE_THRESHOLD` (0,3) sont gardées, **par probabilité
   décroissante**. Prise au mot : « quand utilisent-ils X » exige qu'ils
   l'utilisent dans la vidéo, en parler ne suffit pas.
3. **Luna rédige** une affirmation par vidéo retenue, par lots de 6 vidéos, 16
   lots à la fois. Il peut encore écarter une vidéo dont les extraits ne
   répondent pas (affirmation vide). Les vidéos retenues de justesse (probabilité
   < 0,5) sont regroupées en fin de réponse sous « Pertinence incertaine, à
   vérifier » : le rappel reste, le bruit est signalé.
   Pour une première ou dernière utilisation, l'ordre chronologique est conservé
   et l'incertitude est signalée sur la ligne concernée.
   Quand la question impose une marque ou un modèle (« une scie circulaire Ryobi »), l'analyse la
   repère (« exigences ») et le code la ramène à une forme du corpus (alias, correction
   orthographique). Une vidéo dont le titre et les extraits ne la citent pas (paroles, plans ou texte à
   l'écran) n'est pas retirée, mais présentée à part, sous « éventuellement ».
   En mode local, le rédacteur recopie d'abord la ligne qui répond (« preuve »), puis dit si elle
   répond vraiment à la question prise au mot (« répond ») ; sinon la vidéo est écartée. Ce second
   filtre rattrape les erreurs grossières d'Aplomb (précision 46 → 64 %) ; derrière JEV, il ne
   faisait pas mieux qu'un seuil plus haut.

Sans juge (aucun mode choisi, ou mode OpenRouter sans clé), une question générale répond en extractif.

### 3.5 bis « La première / dernière fois qu'ils… » : parcours chronologique (`src/core/first-time.ts`)

Une question comme « la première fois qu'ils utilisent une scie circulaire Einhell » ne veut qu'une
vidéo, et une seule erreur sur la plus ancienne fausse la réponse. Elle a donc son propre chemin.
L'analyse de la question fournit le sujet (« scie circulaire ») et les exigences (« Einhell »), puis :

1. **Candidates exactes, dans l'ordre du temps** : toutes les vidéos qui citent le sujet et, s'il y en
   a, une exigence (paroles, plans ou texte à l'écran), de la plus ancienne à la plus récente, ou
   l'inverse pour « la dernière fois ».
   **Et candidates par le sens** : le même geste dit avec d'autres mots (« graveuse laser » pour
   « gravure au laser », une équerre imprimée cassée au marteau sans le mot « crash test »). Ce sont
   les vidéos des phrases et des blocs les plus proches de la question et de l'extrait hypothétique
   (HyDE) : les 8 plus anciennes (ou récentes) des 24 plus proches, qui citent l'exigence s'il y en a
   une. Elles prennent leur place dans l'ordre du temps avec leurs 3 moments les plus proches, mais le
   juge doit en être sûr (0,7 au lieu du seuil habituel).
2. **Chaque moment jugé séparément** : chaque endroit où le sujet apparaît est élargi (20 s avant,
   90 s après, puisque l'usage suit souvent l'annonce) et reçoit sa propre décision du juge. Une
   introduction bavarde ne cache plus la scène d'usage.
3. **On s'arrête à la première vidéo retenue**, examinée par vagues de 4. La rédaction la décrit sans
   la rejuger.

Une vidéo retenue où l'exigence n'est jamais sur la même ligne que le sujet, et que son titre ne nomme
pas (« Ryobi » sur un cloueur, une scie à côté), est signalée en « éventuellement », et le parcours
continue. Sans candidate exacte, ou sans vidéo retenue parmi les 24 premières, la question repart par
le chemin général (§3.5).

### 3.6 Replis

Toute étape indisponible dégrade la réponse sans l'empêcher, et la raison est
rendue (`degradedReason`). Une saturation passagère (429, 5xx) est d'abord
réessayée : deux fois en quelques secondes pour luna et JEV, plus longuement
pour l'encodeur pendant l'indexation. Ensuite : pas de clé ou encodeur
injoignable → recherche lexicale seule ; LLM en erreur → **réponse extractive** (les meilleurs extraits,
cités, sans rédaction) ; JEV en erreur → le parcours chronologique cède la place au
chemin général, puis extractif pour les questions générales ; lot de rédaction en
échec → réponse partielle signalée.

## 4. Les façades

- **CLI** (`src/cli/`) : `ask`, `chat` (relances), `collections`, commandes
  d'indexation ; `--collection` limite une question à une chaîne.
- **Interface web** (`src/web/`) : page autonome sans dépendance
  (`src/web/public/index.html`), servie sur 127.0.0.1. Onglet *Rechercher* :
  fil de conversation, citations cliquables à l'instant exact, vidéos citées
  avec leur miniature, sélecteur « Chaîne » dès que le corpus en compte deux
  (`GET /api/collections`, champ `collection` de `/api/ask`), et sur chaque
  miniature un bouton « ≈ proches » : les vidéos les plus proches par leur vecteur
  (titre, description sans gabarit, plans ; `GET /api/videos/<id>/proches`), une
  piste à explorer, jamais une preuve. Onglet *Réglages* : mode (local ou OpenRouter), état des serveurs locaux et jeton Hugging Face du juge, clé OpenRouter et modèle de réponse, mot de passe de l'interface
  (la configuration par `.env` reste possible pour la ligne de commande). Onglet *Administration* : dépôt de fichiers
  `video--<id>.json` (validés contre le schéma, nommés d'après leur identifiant,
  jamais d'après le nom envoyé), mise à jour du corpus en tâche de fond avec son
  journal, état de chaque vidéo (enrichissement, vecteurs). Dès deux chaînes, un
  bilan par chaîne (vidéos, durée, période, extraits, enrichissement, vecteurs) et
  un sélecteur qui limite les chiffres et la liste des vidéos à l'une d'elles
  (`GET /api/admin/status?collection=…` ; taille sur disque et tâches restent
  celles du corpus entier). Un refus d'OpenRouter (402 crédit épuisé, 401 clé
  refusée) arrête la mise à jour, qui passe en « erreur » avec la cause dans le
  badge et le journal ; elle reprend là où elle s'était arrêtée une fois relancée. Garde-fous : hôte vérifié contre le rebinding DNS (adresse IP, nom déclaré, ou mot de passe défini), requêtes JSON
  seulement (pas de requête forgée depuis un autre site), corps borné (413 au-delà,
  400 s'il est illisible), quatre questions simultanées au plus (429 au-delà),
  texte toujours inséré comme texte.
- **Serveur MCP** (`src/mcp/`) : six outils de consultation (`lister_videos`,
  `chercher`, `chercher_plan`, `lire_contexte`, `chercher_infos_video`, `stats`)
  pour qu'un assistant IA interroge le corpus lui-même ; `stats` liste les
  collections, et les quatre outils de recherche acceptent `collection`.

## 5. La base

PostgreSQL 17 avec **ParadeDB** (`pg_search`, BM25 dans Postgres) et **pgvector**
(`halfvec` 2 560 dimensions, HNSW). Les lectures d'une recherche se font dans un
instantané cohérent : données, comptes et versions (`corpus_version`,
`index_version`) viennent du même état, et chaque réponse les rend pour qu'une
mesure soit reproductible. Les passages transmis au LLM sont relus dans le même
état que la recherche : si une mise à jour a changé le corpus entre les deux, la
recherche est relancée. `index_version` compte les vecteurs des entrées et des
blocs, et l'enrichissement des blocs : tout ce qui change le classement change
la version, et invalide les curseurs de pagination. Le schéma est dans [migrations/](../migrations/).

Chaque question posée par l'interface web ou la ligne de commande est notée dans
`question_log` : question, chaîne, route, refus, vidéos citées, vidéos transmises, erreur ou repli,
durée. `npm run journal -- --echecs` liste les échecs probables.
Il garde six mois de questions. Un journal en panne ne fait jamais échouer une réponse.
