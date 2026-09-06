/**
 * Embedding engine for semantic search on trace nodes.
 *
 * Uses a lightweight TF-IDF fallback when @xenova/transformers is unavailable.
 * When the transformers library is present, uses all-MiniLM-L6-v2 (384 dim).
 */

export interface EmbeddingResult {
  vector: number[];
  backend: 'transformers' | 'tfidf';
}

let _backend: 'transformers' | 'tfidf' | null = null;
let _pipeline: any = null;

async function ensureBackend(): Promise<void> {
  if (_backend !== null) return;

  try {
    const { pipeline, env } = await import('@xenova/transformers');
    const path = await import('node:path');
    const os = await import('node:os');

    env.allowLocalModels = true;
    env.allowRemoteModels = false;

    // Try to locate the model in codely-cowork's extensions directory
    const modelPaths = [
      path.join(process.cwd(), 'extensions/vscode/models'),
      path.join(os.homedir(), 'code/codely-cowork/extensions/vscode/models'),
    ];

    for (const p of modelPaths) {
      try {
        const fs = await import('node:fs');
        if (fs.existsSync(path.join(p, 'all-MiniLM-L6-v2'))) {
          env.localModelPath = p;
          break;
        }
      } catch {
        // ignore
      }
    }

    _pipeline = await pipeline('feature-extraction', 'all-MiniLM-L6-v2');
    _backend = 'transformers';
  } catch {
    _backend = 'tfidf';
  }
}

export async function embed(text: string): Promise<EmbeddingResult> {
  await ensureBackend();

  if (_backend === 'transformers' && _pipeline) {
    const output = await _pipeline(text, { pooling: 'mean', normalize: true });
    return {
      vector: Array.from(output.data as Float32Array),
      backend: 'transformers',
    };
  }

  // TF-IDF fallback: hash-based vector
  return {
    vector: hashEmbed(text, 384),
    backend: 'tfidf',
  };
}

export async function embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
  await ensureBackend();

  if (_backend === 'transformers' && _pipeline) {
    const results: EmbeddingResult[] = [];
    for (const text of texts) {
      const output = await _pipeline(text, {
        pooling: 'mean',
        normalize: true,
      });
      results.push({
        vector: Array.from(output.data as Float32Array),
        backend: 'transformers',
      });
    }
    return results;
  }

  return texts.map((t) => ({
    vector: hashEmbed(t, 384),
    backend: 'tfidf' as const,
  }));
}

/** Simple hash-based embedding fallback (384 dim, L2 normalized) */
function hashEmbed(text: string, dim: number): number[] {
  const vec = new Array(dim).fill(0);
  const words = text.toLowerCase().split(/\s+/);
  for (const word of words) {
    let hash = 0;
    for (let i = 0; i < word.length; i++) {
      hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0;
    }
    const idx = Math.abs(hash) % dim;
    vec[idx] += 1;
  }
  // L2 normalize
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i] /= norm;
  }
  return vec;
}

/** Cosine similarity between two vectors */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}
