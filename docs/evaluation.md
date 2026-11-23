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

## Rejouer la mesure sur sa collection

Préparez une base locale indexée, sélectionnez le mode `local` et renseignez `DATABASE_URL`, `LOCAL_LLM_URL`, `LOCAL_EMBEDDING_URL` et `LOCAL_JUDGE_URL` pour vos services. Préparez vos références avant d’examiner les réponses. Chaque entrée du manifeste indique le groupe, la vidéo attendue, les secondes acceptées et les expressions décrivant le fait attendu. Le champ facultatif `forbid` écarte les réponses contenant une confusion connue.

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
