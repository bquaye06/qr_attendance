/**
 * Cosine similarity for 512-d face embeddings.
 * Templates are stored L2-normalised, so the dot product is the similarity;
 * the general form is kept so un-normalised inputs still behave.
 */

export function dot(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error(`dimension mismatch: ${a.length} vs ${b.length}`);
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i]! * b[i]!;
  return sum;
}

export function l2norm(a: readonly number[]): number {
  return Math.sqrt(dot(a, a));
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const denominator = l2norm(a) * l2norm(b);
  if (denominator === 0) return 0;
  return dot(a, b) / denominator;
}

export function averageEmbedding(vectors: readonly (readonly number[])[]): number[] {
  if (vectors.length === 0) throw new Error('averageEmbedding requires at least one vector');
  const first = vectors[0]!;
  const sum = new Array<number>(first.length).fill(0);
  for (const vector of vectors) {
    if (vector.length !== first.length) throw new Error('averageEmbedding dimension mismatch');
    for (let i = 0; i < vector.length; i += 1) sum[i] = sum[i]! + vector[i]!;
  }
  return sum.map((value) => value / vectors.length);
}

/** Normalise (optionally average) then unit-length; what we persist. */
export function toTemplate(vectors: readonly (readonly number[])[]): number[] {
  const averaged = averageEmbedding(vectors);
  const norm = l2norm(averaged);
  if (norm === 0) throw new Error('cannot normalise a zero vector');
  return averaged.map((value) => value / norm);
}

export interface MatchCandidate {
  id: string;
  embedding: readonly number[];
}

export interface MatchResult {
  id: string;
  similarity: number;
}

/** Highest-scoring candidate, or null when the list is empty. */
export function bestMatch(
  probe: readonly number[],
  candidates: readonly MatchCandidate[],
): MatchResult | null {
  let best: MatchResult | null = null;
  for (const candidate of candidates) {
    const similarity = cosineSimilarity(probe, candidate.embedding);
    if (!best || similarity > best.similarity) best = { id: candidate.id, similarity };
  }
  return best;
}

/**
 * Margin between the intended template and the closest *other* template.
 * A thin margin means the face is ambiguous between two enrolled people.
 */
export function nearestOtherSimilarity(
  probe: readonly number[],
  candidates: readonly MatchCandidate[],
): number {
  const match = bestMatch(probe, candidates);
  return match ? match.similarity : 0;
}
