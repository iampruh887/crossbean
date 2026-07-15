// chunk.js — pure logic helpers for intra-document chunking and vector math.
// No DOM, no network, no imports. All exports are pure functions.

// ---------------------------------------------------------------------------
// splitSentences(text) -> Array<{text, start, end}>
//
// Splits `text` into sentence/paragraph/heading/list chunks.
// Offsets are character positions into the original `text` string:
//   start inclusive, end exclusive — suitable for textarea.setSelectionRange.
//
// Rules (in priority order):
//  1. Triple-backtick fenced code blocks are NEVER split — each block is one chunk.
//  2. Markdown headings (lines beginning with #) start a new chunk.
//  3. Blank lines (one or more consecutive empty lines) create a boundary.
//  4. List items (lines beginning with -, *, +, or a digit followed by . or ))
//     each become their own chunk.
//  5. Inside a normal paragraph, split on sentence-ending punctuation
//     (. ! ?) followed by whitespace or end-of-string.
//  6. Whitespace-only fragments are dropped/merged into the previous neighbor.
// ---------------------------------------------------------------------------
export function splitSentences(text) {
  if (!text) return [];

  // Step 1: tokenise the text into raw spans that respect fenced code blocks.
  // We walk through the text character-by-character collecting lines, and every
  // time we see a ``` fence we emit everything accumulated so far as "prose"
  // and then collect until the closing ``` as a single "code" span.

  const spans = []; // { kind: "prose"|"code", text, start }

  let i = 0;
  let spanStart = 0;

  while (i < text.length) {
    // Detect a ``` fence opening: it must be at the start of a line.
    // (i === 0) or preceded by \n, possibly with leading spaces.
    const lineStart = (i === 0) || text[i - 1] === "\n";
    if (lineStart && text.slice(i, i + 3) === "```") {
      // Flush any prose accumulated before this fence.
      if (i > spanStart) {
        spans.push({ kind: "prose", text: text.slice(spanStart, i), start: spanStart });
      }
      const fenceStart = i;
      // Advance past the opening ``` line (to end of that line).
      let j = i + 3;
      while (j < text.length && text[j] !== "\n") j++;
      j++; // include the newline
      // Find the closing ``` (must be on its own line).
      while (j < text.length) {
        if (text[j] === "`" && text.slice(j, j + 3) === "```") {
          // Advance to end of closing fence line.
          j += 3;
          while (j < text.length && text[j] !== "\n") j++;
          if (j < text.length) j++; // include trailing newline
          break;
        }
        j++;
      }
      spans.push({ kind: "code", text: text.slice(fenceStart, j), start: fenceStart });
      i = j;
      spanStart = i;
      continue;
    }
    i++;
  }
  // Flush remaining prose.
  if (spanStart < text.length) {
    spans.push({ kind: "prose", text: text.slice(spanStart), start: spanStart });
  }

  // Step 2: for each span produce raw chunks (before whitespace-only merging).
  const rawChunks = []; // { text, start, end }

  for (const span of spans) {
    if (span.kind === "code") {
      rawChunks.push({ text: span.text, start: span.start, end: span.start + span.text.length });
      continue;
    }

    // prose span: split by headings / blank-lines / list items / sentences
    _splitProse(span.text, span.start, rawChunks);
  }

  // Step 3: drop whitespace-only chunks; merge them into the previous neighbor.
  const result = [];
  for (const chunk of rawChunks) {
    if (/^\s*$/.test(chunk.text)) {
      // Extend previous neighbor's end to swallow the whitespace, so offsets
      // are contiguous and nothing falls through the cracks.
      if (result.length > 0) {
        result[result.length - 1].end = chunk.end;
      }
      // If there is no previous neighbor, discard (leading whitespace).
      continue;
    }
    result.push({ text: chunk.text, start: chunk.start, end: chunk.end });
  }

  // Step 4: update .text fields to reflect any end-extension from whitespace merging.
  for (const chunk of result) {
    chunk.text = text.slice(chunk.start, chunk.end);
  }

  return result;
}

// Internal helper — split a single prose span into raw sub-chunks.
// Pushes {text, start, end} objects into `out` (global offsets via `baseOffset`).
function _splitProse(prose, baseOffset, out) {
  // Split prose into lines first, then reassemble groups.
  const lines = _splitLines(prose);

  // We accumulate lines into the current "paragraph buffer" and flush it
  // when we hit a boundary (heading, blank line, or list item).
  let bufLines = [];
  let bufStart = 0; // offset of first line in bufLines, relative to prose

  function flushBuf() {
    if (bufLines.length === 0) return;
    const bufText = bufLines.map((l) => l.text).join("");
    const start = baseOffset + bufStart;
    // Split the buffer content by sentence boundaries.
    _splitBySentence(bufText, start, out);
    bufLines = [];
  }

  for (const line of lines) {
    const t = line.text;
    const trimmed = t.replace(/\r?\n$/, ""); // remove trailing newline for classification

    // Blank line → flush current buffer, then push the blank as its own raw chunk.
    if (/^\s*$/.test(trimmed)) {
      flushBuf();
      out.push({ text: t, start: baseOffset + line.offset, end: baseOffset + line.offset + t.length });
      continue;
    }

    // Markdown heading → flush buffer, then the heading is its own chunk.
    if (/^#{1,6}\s/.test(trimmed)) {
      flushBuf();
      out.push({ text: t, start: baseOffset + line.offset, end: baseOffset + line.offset + t.length });
      continue;
    }

    // List item → flush buffer, then the list line is its own chunk.
    if (/^(\s*[-*+]|\s*\d+[.)]) /.test(trimmed)) {
      flushBuf();
      out.push({ text: t, start: baseOffset + line.offset, end: baseOffset + line.offset + t.length });
      continue;
    }

    // Normal prose line — accumulate into buffer.
    if (bufLines.length === 0) bufStart = line.offset;
    bufLines.push(line);
  }

  flushBuf();
}

// Split `text` into lines, each carrying its start offset within `text`.
function _splitLines(text) {
  const lines = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === "\n") {
      const end = i < text.length ? i + 1 : i;
      lines.push({ text: text.slice(start, end), offset: start });
      start = end;
    }
  }
  return lines;
}

// Split a prose buffer by sentence-ending punctuation (. ! ?) followed by
// whitespace or end-of-string.  Pushes chunks into `out`.
// `baseOffset` is the global char offset of the buffer's first character.
function _splitBySentence(bufText, baseOffset, out) {
  // Regex: sentence break = [.!?] followed by (whitespace|end).
  // We use exec in a loop so we get the indices.
  const re = /[.!?](?=\s|$)/g;
  let prev = 0;
  let match;

  while ((match = re.exec(bufText)) !== null) {
    const end = match.index + 1; // include the punctuation
    // Peek: consume any trailing whitespace that belongs to the break.
    let endWithWS = end;
    while (endWithWS < bufText.length && /\s/.test(bufText[endWithWS])) endWithWS++;
    const chunk = bufText.slice(prev, endWithWS);
    out.push({ text: chunk, start: baseOffset + prev, end: baseOffset + endWithWS });
    prev = endWithWS;
  }

  // Remainder after the last sentence break (or the whole buffer if no break found).
  if (prev < bufText.length) {
    out.push({ text: bufText.slice(prev), start: baseOffset + prev, end: baseOffset + bufText.length });
  }
}

// ---------------------------------------------------------------------------
// cosine(a, b) -> number
// Standard cosine similarity between two numeric arrays.
// Returns 0 if either vector has zero norm (guard).
// ---------------------------------------------------------------------------
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------------------------------------------------------------------------
// meanPool(vectors) -> number[]
// Component-wise average of all vectors, then L2-normalise the result.
// The mean of unit vectors is NOT unit — normalisation is required.
// Returns [] on empty input.
// ---------------------------------------------------------------------------
export function meanPool(vectors) {
  if (!vectors || vectors.length === 0) return [];
  const dim = vectors[0].length;
  const mean = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) mean[i] += v[i];
  }
  for (let i = 0; i < dim; i++) mean[i] /= vectors.length;
  // L2 normalise.
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += mean[i] * mean[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return mean;
  for (let i = 0; i < dim; i++) mean[i] /= norm;
  return mean;
}

// ---------------------------------------------------------------------------
// centerVectors(vectors) -> number[][]
// Subtract the component-wise mean from every vector.
// Returns centred copies; does NOT renormalise.
// RATIONALE: within one document all sentences share the same topic so raw
// cosines are uniformly high (hairball). Centering surfaces RELATIVE structure.
// ---------------------------------------------------------------------------
export function centerVectors(vectors) {
  if (!vectors || vectors.length === 0) return [];
  const dim = vectors[0].length;
  const mean = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) mean[i] += v[i];
  }
  for (let i = 0; i < dim; i++) mean[i] /= vectors.length;
  return vectors.map((v) => {
    const c = new Array(dim);
    for (let i = 0; i < dim; i++) c[i] = v[i] - mean[i];
    return c;
  });
}

// ---------------------------------------------------------------------------
// buildIntraGraph(sentences, sentenceVectors, opts) ->
//   { nodes: [{id,text,start,end}], edges: [{source,target,weight}] }
//
// sentences      — output of splitSentences()
// sentenceVectors — number[][] aligned 1:1, each sentence embedded ONCE by caller
// opts:
//   granularity  — consecutive sentences grouped into one node (default 1)
//   threshold    — minimum centred-cosine weight to keep an edge (default 0.55)
//   topK         — max edges per node (default 3)
//
// CRITICAL: granularity re-pools WITHOUT re-embedding (O(nodes), never O(embed)).
// ---------------------------------------------------------------------------
export function buildIntraGraph(sentences, sentenceVectors, opts = {}) {
  const { granularity = 1, threshold = 0.55, topK = 3 } = opts;
  const g = Math.max(1, Math.round(granularity));

  // Step 1: group consecutive sentences into nodes.
  const nodes = [];
  for (let i = 0; i < sentences.length; i += g) {
    const members = [];
    for (let j = i; j < Math.min(i + g, sentences.length); j++) members.push(j);
    const id = nodes.length;
    const text = members.map((idx) => sentences[idx].text).join("");
    const start = sentences[members[0]].start;
    const end = sentences[members[members.length - 1]].end;
    nodes.push({ id, text, start, end, members });
  }

  if (nodes.length === 0) return { nodes: [], edges: [] };

  // Step 2: node vector = meanPool of that node's member sentence vectors.
  const nodeVectors = nodes.map((node) =>
    meanPool(node.members.map((idx) => sentenceVectors[idx]))
  );

  // Step 3: center the node vectors.
  const centered = centerVectors(nodeVectors);

  // Step 4: compute edges for every unordered pair i<j.
  // For each node track the strongest-weight edges.
  const allEdges = []; // {source, target, weight}
  // Per-node lists of edge references for topK pruning.
  const nodeEdges = nodes.map(() => []); // index -> [{edge, other}]

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const w = cosine(centered[i], centered[j]);
      if (w >= threshold) {
        const edge = { source: i, target: j, weight: w };
        allEdges.push(edge);
        nodeEdges[i].push({ edge, other: j, w });
        nodeEdges[j].push({ edge, other: i, w });
      }
    }
  }

  // topK pruning: for each node, keep only its topK strongest edges.
  const keptEdges = new Set();
  for (let i = 0; i < nodes.length; i++) {
    // Sort by descending weight, take topK.
    nodeEdges[i].sort((a, b) => b.w - a.w);
    for (let k = 0; k < Math.min(topK, nodeEdges[i].length); k++) {
      keptEdges.add(nodeEdges[i][k].edge);
    }
  }

  // Strip internal members array from the returned nodes (not part of the API shape).
  const resultNodes = nodes.map(({ id, text, start, end }) => ({ id, text, start, end }));
  const resultEdges = Array.from(keptEdges).map(({ source, target, weight }) => ({ source, target, weight }));

  return { nodes: resultNodes, edges: resultEdges };
}
