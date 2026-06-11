// Manual smoke for the Voyage wire contract (T28) — the one place the real
// API is exercised; CI uses the fake embedder. Run once per key/model change:
//   node --env-file=.env spikes/voyage-embed.ts
// PASS criteria: both calls succeed at dimension 1024, and the Hebrew query
// ranks the code-switched afterschool document above the plumber document.

import { makeVoyageEmbedder } from '../src/memory/embedder.ts';

const apiKey = process.env.VOYAGE_API_KEY;
if (apiKey === undefined || apiKey === '') {
  console.error('VOYAGE_API_KEY missing — set it in .env first');
  process.exit(1);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const embedder = makeVoyageEmbedder({
  apiKey,
  onUsage: (usage) => console.log(`  usage: ${usage.totalTokens} tokens`),
});

const documents = [
  'סיכמנו שהצהרון מסתיים ב-16:30 בימי שלישי ו-Reut אוספת',
  'the plumber quoted 1200 shekels for the boiler fix, coming Tuesday',
];
const query = 'מתי נגמר הצהרון?';

console.log('embedding 2 documents…');
const docVectors = await embedder.embedDocuments(documents);
console.log(`  dimensions: ${docVectors.map((v) => v.length).join(', ')}`);

console.log(`embedding query: ${query}`);
const queryVector = await embedder.embedQuery(query);
console.log(`  dimension: ${queryVector.length}`);

const scores = docVectors.map((v, i) => ({
  similarity: cosineSimilarity(queryVector, v),
  doc: documents[i]!,
}));
for (const s of scores) {
  console.log(`  ${s.similarity.toFixed(4)}  ${s.doc}`);
}

const pass = scores[0]!.similarity > scores[1]!.similarity;
console.log(
  pass
    ? 'PASS: Hebrew query ranks the code-switched afterschool doc first'
    : 'FAIL: ranking inverted — investigate before relying on Hebrew recall',
);
process.exit(pass ? 0 : 1);
