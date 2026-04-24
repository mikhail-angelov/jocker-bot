import { readFileSync, writeFileSync } from 'fs';

const inputFile = process.argv[2] || '/dev/stdin';
const raw = readFileSync(inputFile, 'utf-8');

const jokes = [];
let currentText = [];

const lines = raw.split('\n');
for (const line of lines) {
  const numMatch = line.trim().match(/^\*(\d+)\*$/);
  if (numMatch) {
    if (currentText.length > 0) {
      jokes.push({
        text: currentText.join('\n').trim(),
        tags: [],
        source: 'anekdot.me',
      });
    }
    currentText = [];
  } else {
    currentText.push(line);
  }
}
// last one
if (currentText.length > 0) {
  jokes.push({
    text: currentText.join('\n').trim(),
    tags: [],
    source: 'anekdot.me',
  });
}

const output = JSON.stringify(jokes, null, 2);
console.log(`✅ ${jokes.length} jokes parsed`);
writeFileSync('/home/ma/.openclaw/workspace/jocker-bot/data/jokes.json', output);
console.log(`✅ Written to data/jokes.json`);
