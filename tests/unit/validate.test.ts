import { describe, expect, it } from 'vitest';
import {
  validateBusinessRules,
  validateSchema,
  type CorpusDocument,
} from '../../src/core/validate.js';

function makeDoc(overrides: Partial<CorpusDocument> = {}): CorpusDocument {
  return {
    schemaVersion: '2.0',
    videoId: 'Gu8bnHQaG5s',
    contentHash: '5138be0387e97c658b4913cf6867c7968f76311c1d51996bd2f59a52bce75a31',
    generatedAt: '2026-09-18T09:10:54.298Z',
    provenance: {
      runId: 'run',
      model: 'gemini-3.8-flash',
      promptVersion: 'corpus-v2.7',
      fps: 1,
      mediaResolution: 'MEDIA_RESOLUTION_LOW',
      chunkSeconds: null,
      transcriptionSource: 'gemini_video',
      timestampAccuracy: 'model_estimated_seconds',
      speakerScope: 'chunk',
    },
    source: {
      title: 'Titre',
      url: 'https://www.youtube.com/watch?v=Gu8bnHQaG5s',
      channel: 'Les Freres Poulain',
      publicationDate: '2026-08-13',
      durationSeconds: 100,
    },
    publicStats: { views: 10, likes: 2, comments: 1 },
    youtubeDescription: 'Description',
    transcript: [],
    visualSegments: [],
    quality: {
      reviewRequired: false,
      warnings: [],
      visualCoverageRatio: null,
      visualGaps: [],
      inaudibleEntries: 0,
      missingSpeechEndTimes: 0,
      visualUncertainties: 0,
    },
    ...overrides,
  };
}

describe('validation du corpus', () => {
  it('accepte un document conforme', () => {
    const result = validateSchema(makeDoc());
    expect(result.ok).toBe(true);
  });

  it('rejette un JSON corrompu (champ requis absent)', () => {
    const doc: Record<string, unknown> = { ...makeDoc() };
    delete doc.quality;
    const result = validateSchema(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(' ')).toContain('quality');
  });

  it('rejette un videoId mal formé', () => {
    const result = validateSchema(makeDoc({ videoId: 'trop_court' }));
    expect(result.ok).toBe(false);
  });

  it('rejette une propriété inconnue', () => {
    const doc = makeDoc() as unknown as Record<string, unknown>;
    doc.surprise = true;
    const result = validateSchema(doc);
    expect(result.ok).toBe(false);
  });

  it('rejette explicitement une date non nulle invalide', () => {
    const issues = validateBusinessRules(
      makeDoc({ source: { ...makeDoc().source, publicationDate: '2026-13-45' } }),
    );
    expect(issues.join(' ')).toContain('date de publication invalide');
  });

  it('accepte une date absente', () => {
    const issues = validateBusinessRules(
      makeDoc({ source: { ...makeDoc().source, publicationDate: null } }),
    );
    expect(issues).toHaveLength(0);
  });

  it('rejette des IDs dupliqués dans une vidéo', () => {
    const doc = makeDoc({
      transcript: [
        {
          speaker: 'Artus',
          timestamp: '00:00',
          text: 'Bonjour',
          id: 'Gu8bnHQaG5s:t00001',
          startSeconds: 0,
          endSeconds: 2,
          speakerId: null,
        },
      ],
      visualSegments: [
        {
          timestamp: '00:00',
          endTimestamp: '00:02',
          title: 'Plan',
          visualDescription: 'Desc',
          screenText: [],
          id: 'Gu8bnHQaG5s:t00001',
          startSeconds: 0,
          endSeconds: 2,
        },
      ],
    });
    const issues = validateBusinessRules(doc);
    expect(issues.join(' ')).toContain('ID dupliqué');
  });

  it('rejette une borne hors de la durée connue', () => {
    const issues = validateBusinessRules(
      makeDoc({
        transcript: [
          {
            speaker: 'Artus',
            timestamp: '02:00',
            text: 'Trop tard',
            id: 'Gu8bnHQaG5s:t00009',
            startSeconds: 150,
            endSeconds: 160,
            speakerId: null,
          },
        ],
      }),
    );
    expect(issues.join(' ')).toContain('hors de la durée déclarée');
  });

  it('autorise les paroles de durée nulle et les fins inconnues', () => {
    const issues = validateBusinessRules(
      makeDoc({
        transcript: [
          {
            speaker: 'Artus',
            timestamp: '00:10',
            text: 'Point',
            id: 'Gu8bnHQaG5s:t00002',
            startSeconds: 10,
            endSeconds: 10,
            speakerId: null,
          },
          {
            speaker: 'Voff',
            timestamp: '00:20',
            text: 'Fin inconnue',
            id: 'Gu8bnHQaG5s:t00003',
            startSeconds: 20,
            endSeconds: null,
            speakerId: null,
          },
        ],
      }),
    );
    expect(issues).toHaveLength(0);
  });

  it('borne la durée déclarée ou estimée avant la construction de l’index', () => {
    const doc = makeDoc();
    doc.source.durationSeconds = 24 * 3600;
    expect(validateBusinessRules(doc)).toEqual([]);
    doc.source.durationSeconds++;
    expect(validateBusinessRules(doc).join(' ')).toContain('limite d’indexation');
    doc.source.durationSeconds = null;
    doc.transcript.push({ id: doc.videoId + ':t1', timestamp: '24:00:01', startSeconds: 86401,
      endSeconds: null, text: 'Fin', speaker: 'Voix', speakerId: null });
    expect(validateBusinessRules(doc).join(' ')).toContain('limite d’indexation');
  });
});
