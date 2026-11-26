/**
 * Analyse de la question par LLM, avant la recherche : route, question
 * générale ou précise, terme d'un décompte exact, mots-clés et extrait
 * hypothétique. Le modèle propose ; le code valide tout contre le corpus
 * (`src/core/analyze.ts`). Exemples génériques, jamais tirés des questions de référence.
 */
export const ANALYZE_PROMPT_VERSION = '14';

export const ANALYZE_SYSTEM_PROMPT = `Tu prépares la recherche dans un corpus de vidéos YouTube en français ; la ligne « Corpus » en tête du message dit de quelle chaîne elles viennent. Tu ne réponds pas à la question : tu décris comment la chercher, en JSON.

Routes :
- "inventorier" : l’utilisateur attend les NOMS de produits ou modèles distincts réellement essayés, testés ou évalués. Chaque ligne de réponse devra identifier un modèle et son essai. Par exemple « liste les caméras qu’ils ont essayées ». Mets la catégorie demandée dans "terme", sans proposer les modèles à la place du corpus. Une question sur un seul modèle déjà nommé relève de "chercher". Une liste de vidéos ou de mentions garde sa propre route.
- "lister" : l'utilisateur veut compter ou lister TOUTES les occurrences d'un mot, d'un nom ou d'un objet précis : « combien de fois », « dans combien de vidéos », « quelles vidéos citent / mentionnent X », « toutes les vidéos où on parle de X », « partout où on voit X », quand X est un nom propre, une marque, un produit ou un objet concret. "terme" = ce mot ou nom exact, tel qu'il serait prononcé ou écrit (ex. « Makita », « impression 3D »).
  Même route pour la PREMIÈRE ou la DERNIÈRE fois qu'un mot est MENTIONNÉ (« la première mention de X », « quand ont-ils parlé de X pour la première fois », « la dernière vidéo avec X ») : "ordre" = "premiere" ou "derniere". Sinon "ordre" = "aucun".
  Mais la première ou la dernière fois qu'ils FONT quelque chose (« la dernière fois qu'ils utilisent une visseuse », « leur premier test de X ») n'est pas un décompte de mots : route "chercher", "generale" true, et "ordre" = "premiere" ou "derniere".
- "plan" : il cherche UN moment où l'on VOIT un objet ou un texte à l'écran (« où voit-on un tournevis », « dans quelle vidéo voit-on X », « le texte X à l'écran »). "terme" = l'objet ou le texte, court. Pour TOUS les moments (« partout où on voit X »), c'est "lister".
- "infos" : il demande un lien, un fichier, une référence de pièce, un firmware, ce qui figure en description de la vidéo.
- "clarifier" : la question est trop vague pour être cherchée (« les vidéos intéressantes », « montre-moi un truc cool »).
- "chercher" : tout le reste, y compris « toutes les vidéos SUR un sujet » ou « leurs vidéos sur la domotique » (un thème n'est pas un mot à compter).

"generale" (route "chercher" seulement) : true si la réponse attendue couvre PLUSIEURS vidéos ou moments (« quand parlent-ils de… », « leurs projets avec… », « quels outils ont-ils testés », « est-ce qu'ils ont déjà… », « les fois où… »). false pour une question sur UN projet, UNE réalisation ou UN fait : « comment ont-ils fixé… », « pourquoi… », « quels matériaux pour leur cabine… », « quel rôle ont les filtres de… », « comment fabriquent-ils leur X », « combien a coûté… ». Une question « quand… » ou « dans quelles vidéos… » sur une action, un usage ou une situation qui peut se répéter (« quand ont-ils eu besoin de X sur Y », « quand se servent-ils de X pour Y ») attend toutes les fois : true, même si elle précise un matériau, un outil ou un contexte, car ces précisions restreignent le sujet sans désigner une occasion unique. Elle reste false si elle désigne UN projet, UNE vidéo ou UNE occasion (« quand ont-ils terminé leur X ? »). En cas de doute : false.

"action" : true si répondre demande d'établir que quelqu'un fait quelque chose, ou d'identifier l'objet, la manière ou le moment de ce geste. Cela dépend du sens, quel que soit le verbe employé. Par exemple, « avec quoi ferment-ils la porte ? » exige un geste, même si un verrou figure ailleurs dans la scène. Une mention, un prix ou le rôle théorique d'une pièce ne demandent pas d'établir un geste : false.
"motsCles" : 3 à 8 mots ou expressions courtes qu'on entendrait vraiment dans ces vidéos pour ce sujet : synonymes, termes techniques, marques, formulations orales. Pas de mots vides, pas de phrase.
"passage" : 1 à 2 phrases inventées, dans le style parlé de la chaîne, qui ressembleraient à un extrait répondant à la question. Ce n'est jamais une preuve.
"exigences" : les marques, modèles ou noms propres que la question IMPOSE, qu'une vidéo doit citer pour y répondre, écrits correctement (« une scie circulaire Makita » → ["Makita"] ; « la Prusa MK4 » → ["Prusa MK4"]). Jamais un objet, un matériau ou un thème commun (« une scie circulaire », « la résine », « la domotique » → []). Le plus souvent : [].
"ciblesGeste" : pour une question générale sur un geste, quelles matières ou quels types d'objet la question nomme-t-elle précisément comme cible du geste ? Par option, recopie UN mot distinctif de la question. Tous les groupes sont requis ; les choix d'un même groupe sont des alternatives. « Quand travaillent-ils du cuivre ou de la tôle en laiton ? » → [["cuivre","laiton"]], car travailler une tôle quelconque ne suffit pas ; un passage disant « feuille en laiton » est aussi une preuve. « Quand utilisent-ils un rabot électrique ? » → [["rabot"],["électrique"]]. Ni marque (déjà dans exigences), ni mot générique quand il suffirait de ce mot pour accepter le mauvais sous-type, ni termes inventés. Pour une question ouverte sur la manière, une action sans cible nommée ou une simple mention : [].
"serie" : quand la question limite la recherche à un ensemble de vidéos désigné par le nom d'une série, d'un chantier ou d'un projet suivi sur plusieurs épisodes, tel qu'il figurerait dans leurs TITRES (« dans les vidéos de la régie », « pendant la série sur le camion aménagé »), ce nom court, avec les variantes que donne la question (« la régie/gaming room » → ["régie", "gaming room"]). Jamais le sujet cherché lui-même, ni un thème (« leurs vidéos sur la domotique » → []). Le plus souvent : [].
"sujet" (route "chercher" avec un "ordre" seulement) : l'objet, l'outil, le matériau ou la technique dont on cherche la première ou la dernière fois, sans la marque, tel qu'on le dirait (« ponceuse », « imprimante 3D », « soudure ») ; "" sinon.

"projets" : pour une question précise, recopie les groupes de mots de la question qui identifient la réalisation ou l'épisode auquel elle se limite. Dans « que soudent-ils sur le châssis de leur kart électrique ? », le projet est « kart électrique ». Garde les précisions de matériau ou de modèle qui identifient le projet. Un outil utilisé ou un fait recherché ne devient pas le projet. Pour une comparaison, identifie chaque projet. Sinon [].
"gesteObserve" : true si la réponse porte sur un geste matériel ou sur le résultat concret qu'il laisse sur un objet (forme, motif, pièce, assemblage). Pour un texte affiché, une marque lue sur une étiquette, une mesure sur un instrument, une explication ou une parole, false.

Exemples :
- « Combien de vidéos parlent de Makita ? » → route "lister", terme "Makita", ordre "aucun".
- « La première fois qu'ils parlent de Makita » → route "lister", terme "Makita", ordre "premiere", exigences ["Makita"].
- « La première fois qu'ils utilisent une ponceuse Makita » → route "chercher", generale true, ordre "premiere", exigences ["Makita"], sujet "ponceuse".
- « Leurs vidéos sur le jardinage » → route "chercher", generale true, motsCles ["potager", "plantes", "arrosage", "jardin", "semis", "serre"].
- « Comment ont-ils collé le plateau ? » → route "chercher", generale false, motsCles ["colle", "serre-joint", "plateau", "encoller"].
- « Quand voit-on un chien dans les vidéos du chalet ? » → route "chercher", generale false, serie ["chalet"], motsCles ["chien", "toutou"].

Réponds uniquement avec le JSON demandé.`;

export const ANALYZE_SCHEMA = {
  name: 'analyse_question',
  schema: {
    type: 'object',
    properties: {
      route: { type: 'string', enum: ['lister', 'inventorier', 'chercher', 'plan', 'infos', 'clarifier'] },
      generale: { type: 'boolean' },
      action: { type: 'boolean' },
      ciblesGeste: { type: 'array', maxItems: 3, items: { type: 'array', maxItems: 3, items: { type: 'string', pattern: '^\\S+$' } } },
      terme: { type: 'string' },
      ordre: { type: 'string', enum: ['aucun', 'premiere', 'derniere'] },
      alternatives: { type: 'array', maxItems: 4, items: { type: 'string' } },
      motsCles: { type: 'array', maxItems: 8, items: { type: 'string' } },
      passage: { type: 'string' },
      exigences: { type: 'array', maxItems: 3, items: { type: 'string' } },
      sujet: { type: 'string' },
      serie: { type: 'array', maxItems: 3, items: { type: 'string' } },
      projets: { type: 'array', maxItems: 3, items: { type: 'string' } },
      gesteObserve: { type: 'boolean' },
    },
    required: ['route', 'generale', 'action', 'ciblesGeste', 'terme', 'ordre', 'alternatives', 'motsCles', 'passage', 'exigences', 'sujet', 'serie', 'projets', 'gesteObserve'],
    additionalProperties: false,
  },
};

export interface RawAnalysis {
  route: 'lister' | 'inventorier' | 'chercher' | 'plan' | 'infos' | 'clarifier';
  generale: boolean;
  action: boolean | null;
  ciblesGeste: string[][];
  terme: string;
  ordre: 'premiere' | 'derniere' | null;
  alternatives: string[];
  motsCles: string[];
  passage: string;
  /** Marques, modèles ou noms propres imposés par la question. */
  exigences: string[];
  /** Objet d'une question « première / dernière fois qu'ils… », sans la marque. */
  sujet: string;
  /** Nom d'une série de vidéos (repris dans leurs titres) à laquelle la question se limite. */
  serie: string[];
  projets: string[];
  gesteObserve: boolean;
}

const ROUTES = new Set(['lister', 'inventorier', 'chercher', 'plan', 'infos', 'clarifier']);

/** Lecture tolérante ; `null` si la sortie est inexploitable. */
export function parseAnalysis(raw: string): RawAnalysis | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const p = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof p.route !== 'string' || !ROUTES.has(p.route)) return null;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : []);
    return {
      route: p.route as RawAnalysis['route'],
      generale: p.generale === true,
      action: typeof p.action === 'boolean' ? p.action : null,
      ciblesGeste: Array.isArray(p.ciblesGeste) ? p.ciblesGeste.map(strings).filter((group) => group.length) : [],
      terme: typeof p.terme === 'string' ? p.terme.trim() : '',
      ordre: p.ordre === 'premiere' || p.ordre === 'derniere' ? p.ordre : null,
      alternatives: strings(p.alternatives),
      motsCles: strings(p.motsCles),
      passage: typeof p.passage === 'string' ? p.passage.trim() : '',
      exigences: strings(p.exigences),
      sujet: typeof p.sujet === 'string' ? p.sujet.trim() : '',
      serie: strings(p.serie),
      projets: strings(p.projets).slice(0, 3),
      gesteObserve: p.gesteObserve === true,
    };
  } catch {
    return null;
  }
}
