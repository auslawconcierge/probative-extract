const express = require('express');
const { execSync } = require('child_process');
const { writeFileSync, readFileSync, mkdirSync, rmSync } = require('fs');
const { randomUUID } = require('crypto');
const { join } = require('path');
const zlib = require('zlib');

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

  if (fileType === 'pdf') {
    return res.status(400).json({ error: 'PDF not supported at launch. Please paste text directly.' });
  }

  const workDir = join('/tmp', randomUUID());
  mkdirSync(workDir, { recursive: true });

  try {
    const buf = Buffer.from(fileBase64, 'base64');

    // Step 1: Try XML extraction (existing proven logic)
    const xmlResult = extractXml(buf);

    if (xmlResult.valid) {
      console.log(`XML extraction: ${xmlResult.paragraphCount} paragraphs`);
      return res.json({
        text: xmlResult.formatted,
        method: 'xml',
        paragraphCount: xmlResult.paragraphCount,
        first: xmlResult.first,
        last: xmlResult.last,
        hasTrackedChanges: xmlResult.hasTrackedChanges,
        debug: xmlResult.debug
      });
    }

    // Step 2: XML failed or found no usable structure — fallback to LibreOffice
    console.log('XML extraction failed or no structure found, falling back to LibreOffice');
    const docxPath = join(workDir, 'input.docx');
    writeFileSync(docxPath, buf);
    execSync(
      `soffice --headless --norestore --convert-to txt:Text --outdir "${workDir}" "${docxPath}"`,
      { encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: '/tmp' } }
    );
    const rawText = readFileSync(join(workDir, 'input.txt'), 'utf8');
    const loResult = parseLibreOfficeOutput(rawText);

    if (loResult.paragraphCount === 0) {
      return res.status(400).json({
        error: 'Could not extract paragraphs. Please paste text directly.',
        method: 'unsupported'
      });
    }

    console.log(`LibreOffice fallback: ${loResult.paragraphCount} paragraphs`);
    return res.json({
      text: loResult.formatted,
      method: 'libreoffice-fallback',
      paragraphCount: loResult.paragraphCount,
      first: loResult.paragraphs[0]?.text?.substring(0, 80) || '',
      last: loResult.paragraphs[loResult.paragraphs.length - 1]?.text?.substring(0, 80) || '',
    });

  } catch (err) {
    console.error('Extract error:', err);
    return res.status(500).json({ error: err.message });
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
  }
});

// ─── XML EXTRACTION (your existing proven logic) ──────────────────────────────

function extractXml(buffer) {
  try {
    const docXml = extractFromZip(buffer, 'word/document.xml');
    if (!docXml) return { valid: false };

    const numXml = extractFromZip(buffer, 'word/numbering.xml') || '';

    // Detect tracked changes
    const hasTrackedChanges = /<w:ins\b/.test(docXml) || /<w:del\b/.test(docXml);

    // Parse all paragraphs
    const rawParas = [];
    const paraRegex = /<w:p[ >][\s\S]*?<\/w:p>/g;
    let match;
    while ((match = paraRegex.exec(docXml)) !== null) {
      const xml = match[0];
      let text = '';
      const textRe = /<w:t[^>]*>([^<]*)<\/w:t>/g;
      let tm;
      while ((tm = textRe.exec(xml)) !== null) text += tm[1];
      text = text.trim();
      if (!text) continue;
      const numIdM = xml.match(/<w:numId w:val="(\d+)"/);
      const ilvlM = xml.match(/<w:ilvl w:val="(\d+)"/);
      const pprContent = xml.indexOf('<w:pPr>') >= 0 ? xml.slice(xml.indexOf('<w:pPr>') + 7, xml.indexOf('<\/w:pPr>')) : '';
      const rprContent = pprContent.indexOf('<w:rPr>') >= 0 ? pprContent.slice(pprContent.indexOf('<w:rPr>') + 7, pprContent.indexOf('<\/w:rPr>')) : '';
      const delMark = rprContent.indexOf('<w:del ') >= 0 || rprContent.indexOf('<w:del>') >= 0;
      rawParas.push({
        text,
        numId: numIdM ? numIdM[1] : null,
        ilvl: ilvlM ? parseInt(ilvlM[1]) : null,
        delMark
      });
    }

    // Count level-0 items per numId — exclude numId=0 (Word's "remove numbering" value)
    const counts = {};
    for (const p of rawParas) {
      if (p.numId && p.numId !== '0' && p.ilvl === 0) counts[p.numId] = (counts[p.numId] || 0) + 1;
    }

    if (!Object.keys(counts).length) return { valid: false };

    // Primary numId = highest ilvl=0 count
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const mainNumId = sorted[0][0];

    // abstractNumId grouping
    const numIdToAbstract = {};
    const numRe = /<w:num[ >][^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g;
    let nm;
    while ((nm = numRe.exec(numXml)) !== null) {
      const absM = /<w:abstractNumId[^>]+w:val="(\d+)"/.exec(nm[2]);
      if (absM) numIdToAbstract[nm[1]] = absM[1];
    }

    const primaryAbstract = numIdToAbstract[mainNumId];
    let mainNumIds;

    if (primaryAbstract) {
      mainNumIds = new Set(
        Object.entries(numIdToAbstract)
          .filter(([, abs]) => abs === primaryAbstract)
          .map(([id]) => id)
      );
    } else {
      mainNumIds = new Set([mainNumId]);
    }

    // Fallback: small numId lists immediately before main list (same abstractNumId only)
    const firstMainIdx = rawParas.findIndex(p => p.numId === mainNumId && p.ilvl === 0);
    for (let i = firstMainIdx - 1; i >= 0; i--) {
      const p = rawParas[i];
      if (!p.numId) continue;
      if (p.ilvl === 0 && counts[p.numId] <= 15 && !mainNumIds.has(p.numId) && numIdToAbstract[p.numId] === primaryAbstract) {
        mainNumIds.add(p.numId);
      } else break;
    }

    const embeddedNumIds = new Set(Object.keys(counts).filter(id => !mainNumIds.has(id)));

    // Build result
    const result = [];
    let counter = 0;
    let pendingPrefix = '';

    for (const p of rawParas) {
      if (p.numId && p.ilvl === 0 && mainNumIds.has(p.numId)) {
        if (p.delMark) {
          pendingPrefix += (pendingPrefix ? ' ' : '') + p.text;
          continue;
        }
        const fullText = pendingPrefix ? pendingPrefix + ' ' + p.text : p.text;
        pendingPrefix = '';
        const explicitNum = fullText.match(/^(\d+)[.)\s]/);
        if (explicitNum) {
          counter = parseInt(explicitNum[1]);
          const stripped = fullText.replace(/^\d+[.)\s]+/, '').trim();
          result.push({ num: counter, text: stripped, subs: [] });
        } else {
          counter++;
          result.push({ num: counter, text: fullText, subs: [] });
        }
      } else if (result.length > 0 && p.numId && p.ilvl > 0) {
        result[result.length - 1].subs.push(p.text);
      } else if (result.length > 0 && p.numId && p.ilvl === 0 && embeddedNumIds.has(p.numId)) {
        result[result.length - 1].subs.push(p.text);
      } else if (result.length > 0 && !p.numId && p.text.length > 5 && !/^[A-Z][A-Z\s\-']{3,}$/.test(p.text)) {
        result[result.length - 1].subs.push(p.text);
      }
    }

    // Validate: must have coherent sequence starting near 1
    if (result.length < 3) return { valid: false };
    if (result[0].num > 3) return { valid: false }; // doesn't start near 1

    const alpha = 'abcdefghijklmnopqrstuvwxyz';
    const formatted = result.map(p => {
      let out = 'PARAGRAPH [' + p.num + ']: ' + p.text;
      if (p.subs.length) {
        const subLines = p.subs.map((s, idx) => '\n  (' + (alpha[idx] || (idx + 1)) + ') ' + s);
        out += subLines.join('');
      }
      return out;
    }).join('\n\n');

    return {
      valid: true,
      formatted,
      paragraphCount: result.length,
      first: result[0]?.text?.substring(0, 80),
      last: result[result.length - 1]?.text?.substring(0, 80),
      hasTrackedChanges,
      debug: { counts, primaryAbstract, mainNumIds: [...mainNumIds], embeddedNumIds: [...embeddedNumIds] }
    };

  } catch (err) {
    console.error('XML extraction error:', err);
    return { valid: false };
  }
}

// ─── LIBREOFFICE FALLBACK PARSER ──────────────────────────────────────────────

function parseLibreOfficeOutput(text) {
  const lines = text.split('\n');
  const paragraphs = [];
  let current = null;

  const topLevelRe = /^(\d+)\.\s+(\S.*)/;
  const decimalSubRe = /^(\d+\.\d[\d.]*)\s+(\S.*)/;
  const letteredSubRe = /^\(([a-z])\)\s+(\S.*)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const subM = line.match(letteredSubRe);
    if (subM && current) {
      current.subs.push({ label: subM[1], text: subM[2].trim() });
      continue;
    }

    const decM = line.match(decimalSubRe);
    if (decM && current) {
      current.subs.push({ label: decM[1], text: decM[2].trim() });
      continue;
    }

    const topM = line.match(topLevelRe);
    if (topM) {
      if (current) paragraphs.push(current);
      let paraText = topM[2].trim();
      while (i + 1 < lines.length) {
        const next = lines[i + 1].trim();
        if (!next) break;
        if (next.match(topLevelRe) || next.match(decimalSubRe) || next.match(letteredSubRe)) break;
        if (/^[A-Z][A-Z\s\-':,\.]{4,}$/.test(next)) break;
        paraText += ' ' + next;
        i++;
      }
      current = { num: parseInt(topM[1]), text: paraText, subs: [] };
    }
  }
  if (current) paragraphs.push(current);

  const alpha = 'abcdefghijklmnopqrstuvwxyz';
  const formatted = paragraphs.map(p => {
    let out = 'PARAGRAPH [' + p.num + ']: ' + p.text;
    if (p.subs.length) {
      p.subs.forEach((s, idx) => {
        out += '\n  (' + (s.label || alpha[idx] || String(idx + 1)) + ') ' + s.text;
      });
    }
    return out;
  }).join('\n\n');

  return { paragraphs, formatted, paragraphCount: paragraphs.length };
}

// ─── ZIP HELPER ───────────────────────────────────────────────────────────────

function extractFromZip(buffer, targetPath) {
  try {
    let pos = 0;
    while (pos < buffer.length - 4) {
      if (buffer[pos] === 0x50 && buffer[pos + 1] === 0x4B && buffer[pos + 2] === 0x03 && buffer[pos + 3] === 0x04) {
        const compression = buffer.readUInt16LE(pos + 8);
        const compressedSize = buffer.readUInt32LE(pos + 18);
        const filenameLen = buffer.readUInt16LE(pos + 26);
        const extraLen = buffer.readUInt16LE(pos + 28);
        const filename = buffer.slice(pos + 30, pos + 30 + filenameLen).toString('utf8');
        const dataStart = pos + 30 + filenameLen + extraLen;
        if (filename === targetPath) {
          const data = buffer.slice(dataStart, dataStart + compressedSize);
          return compression === 0 ? data.toString('utf8') : zlib.inflateRawSync(data).toString('utf8');
        }
        pos = dataStart + compressedSize;
      } else { pos++; }
    }
  } catch (e) { console.error('ZIP error:', e); }
  return null;
}

app.listen(3000, () => console.log('probative-extract listening on port 3000'));
