# Évaluer les réponses de Ragator

## Vingt questions sur les 404 vidéos des Frères Poulain

Le 23 novembre 2026, deux versions ont répondu aux mêmes vingt questions, sur la même base PostgreSQL, avec le même index hybride et les mêmes services locaux de génération, d’encodage et de jugement. Chaque question partait d’un chat vide, sans identifiant de vidéo ni minutage fourni au moteur. Douze questions ont servi à mettre les correctifs au point. Les huit autres sont restées en réserve jusqu’au dernier essai.

| Critère | Avant les correctifs | Avec les correctifs |
|---|---:|---:|
| Vidéo attendue parmi les scènes citées | 17/20 | 20/20 |
| Aucune autre vidéo dans les sources de la réponse | 15/20 | 19/20 |
| Passage cité à 15 secondes près dans la vidéo attendue | 13/20 | 17/20 |
| Fait attendu reconnu par le barème | 12/20 | 16/20 |
| Tous les critères, questions de mise au point | 7/12 | 11/12 |
| Tous les critères, questions de réserve | 4/8 | 5/8 |
| **Tous les critères ensemble** | **11/20** | **16/20** |

Le barème fixé avant l’essai manque une bonne réponse. À 11:45 dans la vidéo de la base du simulateur, Ragator cite les « serres-joints ». L’expression attendue reconnaissait « serre-joints ». Le tableau conserve le résultat automatique. Sur la réserve, les trois erreurs restantes portent sur l’ourlet du hamac, l’identité du stagiaire et le nom d’une turbine. Dans ces trois cas, retrouver l’épisode n’a pas suffi à répondre au bon passage. Ces mesures décrivent vingt questions sur une chaîne.

### Un dialogue vérifié dans le chat

| Tour | Résultat |
|---|---|
| Sur quel site dessinent-ils le boîtier pentagonal dans l’épisode 1 de l’enceinte ? | Boxes.py, épisode 1 à 12:52 |
| Dans cette scène, quel motif le laser grave-t-il sur les panneaux de l’enceinte terminée ? | Le détail manque à cet endroit. Le chat propose d’examiner les autres épisodes. |
| Oui, vas-y. | Courbes topographiques, épisode 2 à 18:20 |
| À quel moment exactement ? | Épisode 2 à 18:20 |

À partir de la même offre, « non merci » conserve l’épisode 1 à 12:52. Le test a alterné les deux routes HTTP du chat, avec réponse JSON ou en flux.

## Relances de minutage

Le 23 novembre 2026, la version `8f53b24` et le correctif `c50617e` ont interrogé le même index des 404 vidéos avec les mêmes modèles locaux. Chaque version a produit ses propres réponses et citations au premier tour. Les questions ont été rejouées deux fois, en mode court, sur des modèles déjà chargés, en inversant l’ordre des versions au deuxième passage.

| Conversations de bout en bout | Avant | Avec le correctif |
|---|---:|---:|
| Bon minutage donné directement, quatre relances de mise au point | 0/8 | 8/8 |
| Temps médian de ces huit relances | 421 ms | 3,3 ms |
| Bon minutage donné directement, quatre conversations inédites | 1/8 | 4/8 |
| Ensemble des 34 questions du banc principal, deux passages | 26/68 | 33/68 |
| Détails absents correctement signalés dans le banc principal | 8/24 | 8/24 |

Dans les conversations inédites, deux situations limitent le résultat. Sur l’imprimante Prusa, le premier tour cite deux répliques distinctes, à 12:15 et 12:21. Le chat demande laquelle revoir. Sur le simulateur 6DOF, la première réponse cite 07:46 et 08:00. Le passage attendu à 11:22 manque donc dans la mémoire de la relance.

Un contrôle séparé a fourni au chat des citations réelles de chacune des 404 vidéos pour isoler le choix du minutage. Le correctif donne le premier instant commun à la parole et à l’image dans 1 116 cas sur 1 116. Il demande un choix dans les 727 cas où les passages sont distincts et restitue les quatre repères visuels uniques. La version précédente réussissait 731 de ces 1 847 contrôles. Ce contrôle suppose que la conversation a déjà cité les bons passages.

Les cas de chevauchement, de changement de sujet et de citation périmée se rejouent sur une base de test avec `npm test -- tests/integration/followup.test.ts`.

## Inventaire des imprimantes 3D testées (chemin retiré)

Ces mesures décrivent l'inventaire des essais, retiré depuis : les listes d'éléments nommés passent par le
chemin général et la réponse approfondie, qui n'ont pas encore été mesurés sur cette question. Elles
restent ici comme point de comparaison.

Le 26 novembre 2026, deux conversations ont interrogé le même index local de 404 vidéos des Frères Poulain. Sur la version publiée `0c732cc`, « Fais moi la liste de tout les imprimante 3d qu'ils ont téstés » déclenchait un décompte de 474 extraits dans 177 vidéos. À la relance « Non, je veux les modèles qu’ils ont testés, pas les extraits », Ragator répondait avec des lasers Atomstack X20 et X30.

| Conversation avec le correctif | Résultat observé |
|---|---|
| Question originale | Catalogue de 404 vidéos examiné, extraits de 133 vidéos relus, 22 modèles en 2 min 15 s |
| Demande de redonner les modèles dans le même chat | Les mêmes 22 modèles et les mêmes 36 sources en moins d’une seconde |
| « Et chez Bambu Lab ? », puis « Et chez Prusa ? » | Deux modèles Bambu Lab puis six Prusa, avec les citations de la première réponse |
| Nouveau chat web, décompte explicite puis correction « je veux les noms des modèles testés » | Le décompte reste disponible. Le chat retrouve le sujet des imprimantes, relit 102 vidéos et donne 20 modèles en 1 min 44 s |

Les 20 modèles de la seconde liste figurent aussi dans la première après rapprochement des noms commerciaux. La seconde omet la Prusa MK4 et la Prusa XL. Les deux listes écartent le manoir, la glacière, l’imprimante thermique et les épisodes des lasers ACMER et iKier utilisés comme témoins. Les identifiants, le texte des citations et les secondes ont été contrôlés dans les fichiers du corpus. Cette mesure porte sur deux conversations et ne donne pas le nombre total d’imprimantes testées.

Un contrôle manuel a retrouvé un essai de la Wanhao D9 MK2 que les deux inventaires avaient omis. Le titre utilise « D9 MK2 » et les auteurs la présentent comme la « Duplicator 9 ». [Présentation à 00:36](https://www.youtube.com/watch?v=DXUfmpIey8o&t=36s) · [Résultat imprimé à 12:22](https://www.youtube.com/watch?v=DXUfmpIey8o&t=742s)

Dans un dialogue web de huit tours sur la même collection, « Quelles imprimantes 3D avons-nous testées dans nos vidéos ? » a permis d’enchaîner avec « Et chez Bambu Lab ? ». Le chat a répondu « Oui, vous avez testé les modèles Bambu Lab H2S et Bambu Lab X1-Carbon ». « Tu peux me le dire en une phrase ? », puis « Sous forme de liste » ont conservé les deux citations, respectivement à 02:19 et 00:48. Pour une marque inventée, il a signalé qu’elle était absente de la liste vérifiée.

## Rejouer la mesure sur sa collection

Pour rejouer le banc du premier tour, préparez une base locale indexée, sélectionnez le mode `local` et renseignez `DATABASE_URL`, `LOCAL_LLM_URL`, `LOCAL_EMBEDDING_URL` et `LOCAL_JUDGE_URL` pour vos services. Préparez vos références avant d’examiner les réponses. Chaque entrée du manifeste indique le groupe, la vidéo attendue, les secondes acceptées et les expressions décrivant le fait attendu. Le champ facultatif `forbid` écarte les réponses contenant une confusion connue.

```json
[
  {
    "id": "tension-sortie",
    "split": "reserve",
    "question": "Quelle tension mesurent-ils à la sortie du convertisseur de la glacière ?",
    "video": "Gu8bnHQaG5s",
    "times": [316, 326],
    "all": ["12\\s*(?:[,\\.]0+\\s*)?v|douze volts"]
  }
]
```

```bash
node --import tsx tests/evaluation/first-answer.mjs references.json resultats.jsonl reserve 0 1 les-freres-poulain
```

Les deux entiers désignent le numéro de partie à partir de zéro et le nombre de parties. Avec `0 1`, la commande traite tout le groupe. Choisissez un fichier de sortie neuf à chaque essai. Une ligne JSON par question contient la réponse, les citations, les titres, les critères individuels et le verdict `complete`. Les expressions régulières se comparent au texte en minuscules et sans accents, après retrait des références horodatées. Une réponse refusée, une piste seule ou un repli en mode dégradé échouent au critère factuel. Relisez les écarts pour repérer les formulations que le barème ne couvre pas.

Pour vérifier l’image Docker elle-même, le test suivant importe la vidéo d’exemple, pose une question, redémarre le service et vérifie la persistance. Un second conteneur teste aussi l’accès authentifié sur un réseau isolé.

```bash
docker build -t ragator:verification .
node tests/docker/smoke.mjs ragator:verification
```
