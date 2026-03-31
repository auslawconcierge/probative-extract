const express = require('express');
const { execSync } = require('child_process');
const { writeFileSync, readFileSync, mkdirSync, rmSync } = require('fs');
const { randomUUID } = require('crypto');
const { join } = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));

const API_KEY = process.env.EXTRACT_API_KEY;

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/extract', (req, res) => {
  const auth = req.headers.authorization || '';
  if (API_KEY && auth !== 'Bearer ' + API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { fileBase64, fileType } = req.body;
  if (!fileBase64 || !fileType) {
    return res.status(400).json({ error: 'Missing fileBase64 or fileType' });
  }

  const workDir = join('/tmp', randomUUID());
  mkdirSync(workDir, { recursive: true });

  try {
    const buf = Buffer.from(fileBase64, 'base64');
    let rawText = '';

    if (fileType === 'pdf') {
      const pdfPath = join(workDir, 'input.pdf');
      writeFileSync(pdfPath, buf);
      try {
        rawText = execSync(`pdftotext -layout "${pdfPath}" -`, { encoding: 'utf8', timeout: 30000 });
      } catch (e) {
        rawText = execSync(`tesseract "${pdfPath}" stdout`, { encoding: 'utf8', timeout: 120000 });
      }
    } else {
      const docxPath = join(workDir, 'input.docx');
      writeFileSync(docxPath, buf);
      execSync(
        `soffice --headless --convert-to txt:Text --outdir "${workDir}" "${docxPath}"`,
        { encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: '/tmp' } }
      );
      rawText = readFileSync(join(workDir, 'input.txt'), 'utf8');
    }

    const result = parseNumberedParagraphs(rawText);
    console.log(`Extracted ${result.paragraphs.length} paragraphs`);

    return res.json({
      text: result.formatted,
      method: fileType === 'pdf' ? 'pdftotext' : 'libreoffice',
      paragraphCount: result.paragraphs.length,
      first: result.paragraphs[0]?.text?.substring(0, 80) || '',
      last: result.paragraphs[result.paragraphs.length - 1]?.text?.substring(0, 80) || '',
    });

  } catch (err) {
    console.error('Extract error:', err);
    return res.status(500).json({ error: err.message });
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
  }
});

function parseNumberedParagraphs(text) {
  const lines = text.split('\n');
  const paragraphs = [];
  let current = null;

  // All regexes applied to TRIMMED lines
  const topLevelRe = /^(\d+)\.\s+(\S.*)/;           // "1. Text"
  const decimalSubRe = /^(\d+\.\d[\d.]*)\s+(\S.*)/; // "21.1 Text"
  const letteredSubRe = /^\(([a-z])\)\s+(\S.*)/;    // "(a) Text"

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    // Lettered sub-paragraph
    const subM = line.match(letteredSubRe);
    if (subM && current) {
      let subText = subM[2].trim();
      // Collect continuation lines
      while (i + 1 < lines.length) {
        const next = lines[i + 1].trim();
        if (next && !next.match(letteredSubRe) && !next.match(topLevelRe) && !next.match(decimalSubRe)) {
          // Only continue if indented more than current
          if (lines[i + 1].length > 0 && (lines[i + 1][0] === ' ' || lines[i + 1][0] === '\t')) {
            subText += ' ' + next;
            i++;
          } else break;
        } else break;
      }
      current.subs.push({ label: subM[1], text: subText });
      continue;
    }

    // Decimal sub-paragraph e.g. 21.1
    const decM = line.match(decimalSubRe);
    if (decM && current) {
      current.subs.push({ label: decM[1], text: decM[2].trim() });
      continue;
    }

    // Top-level numbered paragraph
    const topM = line.match(topLevelRe);
    if (topM) {
      if (current) paragraphs.push(current);
      let paraText = topM[2].trim();
      // Collect multi-line continuation
      while (i + 1 < lines.length) {
        const nextRaw = lines[i + 1];
        const next = nextRaw.trim();
        if (!next) break;
        if (next.match(topLevelRe)) break;
        if (next.match(decimalSubRe)) break;
        if (next.match(letteredSubRe)) break;
        // Stop at all-caps headings
        if (/^[A-Z][A-Z\s\-':,\.]{4,}$/.test(next)) break;
        paraText += ' ' + next;
        i++;
      }
      current = { num: parseInt(topM[1]), text: paraText, subs: [] };
      continue;
    }
  }

  if (current) paragraphs.push(current);

  const alpha = 'abcdefghijklmnopqrstuvwxyz';
  const formatted = paragraphs.map(p => {
    let out = 'PARAGRAPH [' + p.num + ']: ' + p.text;
    if (p.subs.length) {
      p.subs.forEach((s, idx) => {
        const label = s.label || alpha[idx] || String(idx + 1);
        out += '\n  (' + label + ') ' + s.text;
      });
    }
    return out;
  }).join('\n\n');

  return { paragraphs, formatted };
}

app.listen(3000, () => console.log('probative-extract listening on port 3000'));
