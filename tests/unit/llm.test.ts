import { describe, expect, it } from 'vitest';
import { EMBEDDING_MODEL, loadConfig } from '../../src/config.js';
import { chatBody } from '../../src/providers/llm.js';
import { answerSchema, buildWritePrompt, parseWritten, promptLine, renderPassage, writeSchema, WRITE_SYSTEM_PROMPT, WRITE_SYSTEM_PROMPT_DECIDED, WRITE_SYSTEM_PROMPT_PROOF } from '../../src/prompts/answer.js';

const schema = { name: 's', schema: { type: 'object' } };

describe('configuration', () => {
  it('aucun mode choisi : aucun modèle, l’outil reste utilisable', () => {
    expect(loadConfig({})).toMatchObject({ mode: null, llm: null, embedding: null, judge: null });
    // Mode OpenRouter choisi, mais sans clé : pareil.
    expect(loadConfig({}, { mode: 'openrouter' })).toMatchObject({ mode: 'openrouter', llm: null, embedding: null, judge: null });
  });

  it('mode openrouter avec clé : luna, pplx-embed-v1-4b et JEV au seuil 0,3, une seule clé', () => {
    const config = loadConfig({ OPENROUTER_API_KEY: 'sk-or-test' });
    expect(config.llm).toMatchObject({ model: 'openai/gpt-6-luna', apiKey: 'sk-or-test', parallel: 16, contextTokens: 32_768, proof: false });
    expect(config.embedding).toMatchObject({ model: EMBEDDING_MODEL, apiKey: 'sk-or-test', batchSize: 64, parallel: 4 });
    expect(config.mode).toBe('openrouter');
    expect(config.judge).toMatchObject({ kind: 'jev', model: 'typesafe/jev-1.13', apiKey: 'sk-or-test', parallel: 32, threshold: 0.3 });
    expect(loadConfig({ OPENROUTER_API_KEY: 'k', JUDGE_THRESHOLD: '0.5' }).judge!.threshold).toBe(0.5);
    expect(() => loadConfig({ OPENROUTER_API_KEY: 'k', JUDGE_THRESHOLD: '2' })).toThrow('JUDGE_THRESHOLD');
  });

  it('mode openrouter : modèles des réponses et de l’enrichissement au choix', () => {
    expect(loadConfig({ OPENROUTER_API_KEY: 'k' }).llm).toMatchObject({ model: 'openai/gpt-6-luna', enrichModel: 'openai/gpt-6-luna' });
    expect(loadConfig({ OPENROUTER_API_KEY: 'k', OPENROUTER_ENRICH_MODEL: 'minimax/minimax-m3.1-flash:free' }).llm).toMatchObject({
      model: 'openai/gpt-6-luna',
      enrichModel: 'minimax/minimax-m3.1-flash:free',
    });
    expect(loadConfig({ OPENROUTER_API_KEY: 'k', OPENROUTER_LLM_MODEL: 'x/y' }).llm).toMatchObject({ model: 'x/y', enrichModel: 'x/y' });
  });

  it('RAGATOR_SANS_VECTEURS=1 : vecteurs coupés, LLM et juge gardés (mesure mots seuls)', () => {
    const config = loadConfig({ OPENROUTER_API_KEY: 'k', RAGATOR_SANS_VECTEURS: '1' });
    expect(config.embedding).toBeNull();
    expect(config.llm).not.toBeNull();
    expect(config.judge).not.toBeNull();
    expect(loadConfig({ RAGATOR_MODE: 'local', RAGATOR_SANS_VECTEURS: '1' }).embedding).toBeNull();
  });

  it('mode local : serveurs de la pile Docker, sans clé, réglages des petits modèles', () => {
    const config = loadConfig({}, { mode: 'local' });
    expect(config.mode).toBe('local');
    expect(config.llm).toMatchObject({ baseUrl: 'http://llm:8080/v1', model: 'qwen3.5-9b', parallel: 8, contextTokens: 10_240, proof: true, speculate: false });
    // Même encodeur que le mode OpenRouter : la même base sert aux deux.
    expect(config.embedding).toMatchObject({ baseUrl: 'http://embed:8080/v1', model: EMBEDDING_MODEL, batchSize: 16, parallel: 1 });
    // Aplomb note environ 0,1 plus haut que JEV : seuil par défaut 0,4.
    expect(config.judge).toMatchObject({ kind: 'local', label: 'Aplomb', baseUrl: 'http://juge:8000', parallel: 1, threshold: 0.4 });
    // Une clé OpenRouter enregistrée ne change rien au mode local.
    expect(loadConfig({ OPENROUTER_API_KEY: 'k' }, { mode: 'local', openrouterKey: 'k' }).llm!.model).toBe('qwen3.5-9b');
  });

  it('mode local : adresses réglables (autre machine), places et contexte ; budget = contexte ÷ places', () => {
    const config = loadConfig(
      { RAGATOR_MODE: 'local', LOCAL_LLM_URL: 'http://127.0.0.1:8080/v1', LOCAL_LLM_PARALLEL: '4', LOCAL_LLM_CONTEXT: '65536', JUDGE_THRESHOLD: '0.5' },
      { localEmbeddingUrl: 'http://192.0.2.7:8081/v1', localJudgeUrl: 'http://192.0.2.7:8000' },
    );
    expect(config.llm).toMatchObject({ baseUrl: 'http://127.0.0.1:8080/v1', parallel: 4, contextTokens: 16_384 });
    expect(config.embedding!.baseUrl).toBe('http://192.0.2.7:8081/v1');
    expect(config.judge).toMatchObject({ baseUrl: 'http://192.0.2.7:8000', threshold: 0.5 });
    // Le réglage de l'interface prime sur l'environnement.
    expect(loadConfig({ RAGATOR_MODE: 'local', LOCAL_LLM_URL: 'http://a/v1' }, { localLlmUrl: 'http://b/v1' }).llm!.baseUrl).toBe('http://b/v1');
    expect(loadConfig({ RAGATOR_MODE: 'openrouter', OPENROUTER_API_KEY: 'k' }, { mode: 'local' }).mode).toBe('local');
    expect(() => loadConfig({ RAGATOR_MODE: 'local', LOCAL_LLM_PARALLEL: '0' })).toThrow('LOCAL_LLM_PARALLEL');
    expect(() => loadConfig({ RAGATOR_MODE: 'cloud' })).toThrow('RAGATOR_MODE');
  });

  it('réglages enregistrés depuis l’interface : ils priment sur l’environnement', () => {
    const config = loadConfig({ OPENROUTER_API_KEY: 'env', RAGATOR_PASSWORD: 'p-env' }, { openrouterKey: 'sk-or-ui', llmModel: 'x/y', password: 'p-ui' });
    expect(config.llm).toMatchObject({ apiKey: 'sk-or-ui', model: 'x/y' });
    expect(config.judge).toMatchObject({ apiKey: 'sk-or-ui' });
    expect(config.web.password).toBe('p-ui');
    expect(loadConfig({}, { openrouterKey: 'sk-or-ui' }).embedding).toMatchObject({ apiKey: 'sk-or-ui' });
  });
});

describe('corps de requête (format OpenAI)', () => {
  it('max_completion_tokens, raisonnement coupé, cache explicite, sortie structurée stricte', () => {
    const body = chatBody('gpt-6-luna', 'sys', 'user', { maxTokens: 400, jsonSchema: schema });
    expect(body).toMatchObject({
      model: 'gpt-6-luna',
      max_completion_tokens: 400,
      reasoning_effort: 'none',
      prompt_cache_options: { mode: 'explicit' },
    });
    expect(body).not.toHaveProperty('temperature');
    expect(chatBody('m', 's', 'u', { temperature: 0 })).toMatchObject({ temperature: 0 });
    expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 's', strict: true } });
  });
});

describe('rédaction des questions générales', () => {
  it('une balise par vidéo, lecture tolérante de la sortie', () => {
    const prompt = buildWritePrompt('Quand parlent-ils du chat ?', [
      { label: 'v1', title: 'Le "chat"', publishedAt: '2025-01-01', texts: ['<passage extrait="00:00–00:30">\n[s1 00:01] PAROLE : le chat\n</passage>'] },
    ]);
    expect(prompt).toContain('<video id="v1" titre="Le ’chat’" date="2025-01-01">');
    expect(prompt).toContain('[s1 00:01] PAROLE : le chat');
    expect(parseWritten('{"videos":[{"videoId":"v1","affirmation":" Le chat. ","sourceIds":["s1"]}]}')).toEqual([
      { videoId: 'v1', affirmation: 'Le chat.', sourceIds: ['s1'] },
    ]);
    expect(parseWritten('pas du JSON')).toBeNull();
  });

  it('le schéma n’autorise que les vidéos et les lignes du lot', () => {
    const properties = writeSchema(['v1'], ['s3']).schema.properties.videos.items.properties;
    expect(Object.keys(properties)).toEqual(['videoId', 'affirmation', 'sourceIds', 'nature']);
    expect(properties.videoId).toEqual({ type: 'string', enum: ['v1'] });
  });

  it('la nature de la mention : seules « en_passant » et « promotion » sont reportées', () => {
    const written = parseWritten(
      '{"videos":[{"videoId":"v1","affirmation":"Ils l’expliquent.","sourceIds":["s1"],"nature":"sujet"},' +
        '{"videoId":"v2","affirmation":"Le sponsor en parle.","sourceIds":["s2"],"nature":"promotion"},' +
        '{"videoId":"v3","affirmation":"Cité au détour.","sourceIds":["s3"],"nature":"en_passant"},' +
        '{"videoId":"v4","affirmation":"Autre.","sourceIds":["s4"],"nature":"inconnue"}]}',
    );
    expect(written!.map((w) => w.nature)).toEqual([undefined, 'promotion', 'en_passant', undefined]);
    expect(WRITE_SYSTEM_PROMPT).toContain('"nature"');
    expect(WRITE_SYSTEM_PROMPT_DECIDED).toContain('"nature"');
    expect(WRITE_SYSTEM_PROMPT_PROOF).not.toContain('"nature"');
  });

  it('mode local : la preuve et le verdict précèdent l’affirmation, « repond: false » écarte la vidéo', () => {
    const local = writeSchema(['v1', 'v2'], ['s1'], true).schema.properties.videos.items;
    expect(Object.keys(local.properties)).toEqual(['videoId', 'preuve', 'repond', 'affirmation', 'sourceIds']);
    expect(local.required).toContain('repond');
    expect(WRITE_SYSTEM_PROMPT_PROOF).toContain('"repond"');
    const written = parseWritten(
      '{"videos":[{"videoId":"v1","preuve":"Artus visse","repond":true,"affirmation":"Ils vissent.","sourceIds":["s1"]},' +
        '{"videoId":"v2","preuve":"","repond":false,"affirmation":"Rien.","sourceIds":["s1"]}]}',
    );
    expect(written!.map((w) => w.affirmation)).toEqual(['Ils vissent.', '']);
  });
});

describe('prompt compact', () => {
  const entry = {
    sourceId: 'Gu8bnHQaG5s:t00061',
    kind: 'parole' as const,
    startS: 221,
    endS: 224,
    text: 'Le Peltier refroidit.',
    speaker: null,
    isVoiceOver: false,
    speakerIsNamed: false,
    planTitle: null,
    screenText: null,
    uncertainties: [],
  };
  const idOf = () => 's7';

  it('ligne courte : identifiant court, début seul, locuteur seulement s’il est connu', () => {
    expect(promptLine(entry, idOf)).toBe('[s7 03:41] PAROLE : Le Peltier refroidit.');
    expect(promptLine({ ...entry, speaker: 'Artus', speakerIsNamed: true }, idOf)).toBe('[s7 03:41] PAROLE (Artus) : Le Peltier refroidit.');
    expect(promptLine({ ...entry, isVoiceOver: true }, idOf)).toContain('PAROLE (voix off)');
    const plan = { ...entry, kind: 'visuel' as const, planTitle: 'Module', text: 'Gros plan.', screenText: ['12V'], uncertainties: ['flou'] };
    expect(promptLine(plan, idOf)).toBe('[s7 03:41] PLAN : Module | Gros plan.\n  ÉCRAN : « 12V »\n  INCERTAIN : flou');
  });

  it('passage balisé avec titre et date', () => {
    const text = renderPassage({ videoId: 'x', title: 'Glacière', publishedAt: '2026-08-13', startS: 200, endS: 260, entries: [entry] }, idOf);
    expect(text).toBe('<passage titre="Glacière" date="2026-08-13" extrait="03:20–04:20">\n[s7 03:41] PAROLE : Le Peltier refroidit.\n</passage>');
  });

  it('les schémas n’autorisent que les identifiants fournis, sauf au-delà de 1 000', () => {
    const items = answerSchema(['s1', 's2']).schema.properties.claims.items.properties.sourceIds.items;
    expect(items).toEqual({ type: 'string', enum: ['s1', 's2'] });
    const many = Array.from({ length: 1001 }, (_, i) => `s${i + 1}`);
    expect(answerSchema(many).schema.properties.claims.items.properties.sourceIds.items).toEqual({ type: 'string' });
    expect(answerSchema().schema.properties.claims.items.properties.sourceIds.items).toEqual({ type: 'string' });
  });
});
