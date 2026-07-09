// Seeds a few demo notes across distinct topics so the knowledge graph has
// visible clusters. Embeddings are computed by the app on next launch
// (indexMissing), which then draws the AI-similarity edges.

import { initStore, createNote, setUserLinks } from "../src/store";
import { initVault, writeNoteFile, parseWikilinks } from "../src/vault";

initStore();
initVault();

const notes: [string, string][] = [
  ["Neural Networks", "Neural networks are layers of weighted connections that learn from data through backpropagation. They underpin modern deep learning. See [[Gradient Descent]]."],
  ["Gradient Descent", "Gradient descent optimizes model weights by stepping down the loss gradient. Learning rate controls step size. Core to training [[Neural Networks]]."],
  ["Transformers and Attention", "The transformer architecture uses self-attention to weigh token relationships in parallel. It replaced recurrence and powers large language models."],
  ["Sourdough Bread", "Sourdough uses a wild-yeast starter for a slow rise and tangy crumb. Hydration and fermentation time shape the loaf. Related: [[Fermentation Basics]]."],
  ["Pizza Dough", "Neapolitan pizza dough is flour, water, salt and yeast, proofed for a light, chewy base. A long cold ferment deepens flavor."],
  ["Fermentation Basics", "Fermentation is microbes converting sugars into acids, gases or alcohol. It leavens bread and preserves food."],
  ["Black Holes", "A black hole is a region where gravity is so strong that nothing, not even light, escapes past the event horizon."],
  ["Rocket Propulsion", "Rockets move by expelling mass at high velocity, conserving momentum. Thrust depends on exhaust velocity and mass flow rate."],
];

let created = 0;
for (const [title, body] of notes) {
  const id = createNote(title, body);
  setUserLinks(id, parseWikilinks(body));
  await writeNoteFile(id, title, body);
  created++;
}

console.log(`seeded ${created} notes. Launch the app — they'll be embedded and connected automatically.`);
process.exit(0);
