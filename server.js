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
  // Auth
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
        // Digital PDF — fast text extraction
        rawText = execSync(`pdftotext -layout "${pdfPath}" -`, {
          encoding: 'utf8',
          timeout: 30000
        });
      } catch (e) {
        // Scanned PDF — OCR fallback
        console.log('pdftotext failed, trying OCR:', e.message);
        rawText = execSync(`tesseract "${pdfPath}" stdout`, {
          encoding: 'utf8',
          timeout: 120000
        });
      }
    } else {
      // docx (or doc) — LibreOffice handles every numbering format
      const docxPath = join(workDir, 'input.docx');
      writeFileSync(docxPath, buf);
      execSync(
        `soffice --headless --convert-to txt:Text --outdir "${workDir}" "${docxPath}"`,
        {
          encoding: 'utf8',
          timeout: 60000,
          env: { ...process.env, HOME: '/tmp' }
        }
      );
      rawText = readFileSync(join(workDir, 'input.txt'), 'utf8');
    }

    const result = parseNumberedParagraphs(rawText);

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

  // Matches top-level paragraph numbers: "1. " "18. " "100. "
  const topLevelRe = /^(\d+)\.\s+(\S.*)/;

  // Matches decimal sub-paragraphs: "21.1 " "21.1.1 "
  const decimalSubRe = /^(\d+\.\d[\d.]*)\s+(\S.*)/;

  // Matches lettered sub-paragraphs: "(a) " "  (a) "
  const letteredSubRe = /^\s*\(([a-z])\)\s+(\S.*)/;

  // Heading detector — all caps, or bold-style short line with no sentence punctuation
  const isHeading = (line) => {
    const t = line.trim();
    if (!t || t.length > 120) return false;
    // All-uppercase words (section headings like "Propertybase" headings won't match but
    // "SUPREME COURT OF QUEENSLAND" will)
    if (/^[A-Z][A-Z\s\-':,\.]{4,}$/.test(t)) return true;
    return false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (!line.trim()) continue;

    // Lettered sub-paragraph
    const subM = line.match(letteredSubRe);
    if (subM && current) {
      // Collect continuation lines for this sub-para
      let subText = subM[2].trim();
      while (i + 1 < lines.length) {
        const next = lines[i + 1].trimEnd();
        // Continuation: indented and not a new numbered item
        if (next.trim() && /^\s{4,}/.test(next) &&
            !next.match(letteredSubRe) && !next.match(topLevelRe)) {
          subText += ' ' + next.trim();
          i++;
        } else break;
      }
      current.subs.push({ label: subM[1], text: subText });
      continue;
    }

    // Decimal sub-paragraph (e.g. 21.1)
    const decM = line.match(decimalSubRe);
    if (decM && current) {
      let subText = decM[2].trim();
      current.subs.push({ label: decM[1], text: subText });
      continue;
    }

    // Top-level numbered paragraph
    const topM = line.match(topLevelRe);
    if (topM) {
      if (current) paragraphs.push(current);
      // Collect multi-line paragraph text
      let paraText = topM[2].trim();
      while (i + 1 < lines.length) {
        const next = lines[i + 1].trimEnd();
        // Continuation line: not empty, not a new numbered item, not a heading
        if (next.trim() &&
            !next.match(topLevelRe) &&
            !next.match(decimalSubRe) &&
            !next.match(letteredSubRe) &&
            !isHeading(next)) {
          paraText += ' ' + next.trim();
          i++;
        } else break;
      }
      current = { num: parseInt(topM[1]), text: paraText, subs: [] };
      continue;
    }

    // Not a numbered line — if we haven't started collecting yet, skip
    // (covers court headers, party names, etc.)
  }

  if (current) paragraphs.push(current);

  // Build formatted output matching existing analyse.js expectations
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
