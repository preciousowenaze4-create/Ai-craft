export interface EditableCodeFile {
  id: string;
  label: string;
  content: string;
  kind: 'html' | 'css' | 'js' | 'screen' | 'sql';
  editable: boolean;
}

const SAFETY_STYLE_RE = /<style\b[^>]*data-aicraft-safety[^>]*>[\s\S]*?<\/style>/gi;
const SAFETY_SCRIPT_RE = /<script\b[^>]*data-aicraft-safety-js[^>]*>[\s\S]*?<\/script>/gi;

function isSafetyOrJsonScript(tagOpen: string): boolean {
  if (/data-aicraft-safety-js/i.test(tagOpen)) return true;
  if (/\bsrc\s*=/i.test(tagOpen)) return true;
  const typeMatch = /\btype\s*=\s*["']([^"']+)["']/i.exec(tagOpen);
  if (typeMatch) {
    const mime = typeMatch[1].trim().toLowerCase();
    if (
      mime &&
      mime !== 'text/javascript' &&
      mime !== 'application/javascript' &&
      mime !== 'module'
    ) {
      return true;
    }
  }
  return false;
}

function findScreenTagRange(
  html: string,
  screenName: string
): { start: number; end: number } | null {
  const escaped = screenName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const openRe = new RegExp(
    `<(section|div|main|article)\\b[^>]*\\b(?:data-screen|data-view|data-page|data-tab|id)=["']${escaped}["'][^>]*>`,
    'i'
  );
  const match = openRe.exec(html);
  if (!match || match.index === undefined) return null;

  const tag = match[1].toLowerCase();
  const startIdx = match.index;
  const tagPairRe = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, 'gi');
  tagPairRe.lastIndex = startIdx;
  let depth = 0;
  let tm: RegExpExecArray | null;
  while ((tm = tagPairRe.exec(html)) !== null) {
    if (tm[0].startsWith('</')) {
      depth -= 1;
      if (depth <= 0) {
        return { start: startIdx, end: tm.index + tm[0].length };
      }
    } else {
      depth += 1;
    }
  }
  return null;
}

export function extractEditableCodeFiles(html: string): EditableCodeFile[] {
  const cleanHtml = String(html || '');
  if (!cleanHtml.trim()) {
    return [
      {
        id: 'index.html',
        label: 'index.html',
        content: '',
        kind: 'html',
        editable: true,
      },
    ];
  }

  const files: EditableCodeFile[] = [
    {
      id: 'index.html',
      label: 'index.html',
      content: cleanHtml,
      kind: 'html',
      editable: true,
    },
  ];

  // Extract clean user CSS (excluding injected data-aicraft-safety wrapper)
  const styleBlocks: string[] = [];
  const styleRe = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = styleRe.exec(cleanHtml)) !== null) {
    if (/data-aicraft-safety/i.test(sm[1] || '')) continue;
    const body = (sm[2] || '').trim();
    if (body) styleBlocks.push(body);
  }
  if (styleBlocks.length > 0) {
    files.push({
      id: 'styles.css',
      label: 'styles.css',
      content: styleBlocks.join('\n\n'),
      kind: 'css',
      editable: true,
    });
  }

  // Extract clean user JS (excluding safety wrapper, external src, and JSON scripts)
  const scriptBlocks: string[] = [];
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let jm: RegExpExecArray | null;
  while ((jm = scriptRe.exec(cleanHtml)) !== null) {
    if (isSafetyOrJsonScript(jm[1] || '')) continue;
    const body = (jm[2] || '').trim();
    if (body) scriptBlocks.push(body);
  }
  if (scriptBlocks.length > 0) {
    files.push({
      id: 'app.js',
      label: 'app.js',
      content: scriptBlocks.join('\n\n'),
      kind: 'js',
      editable: true,
    });
  }

  // Extract distinct screens ([data-screen] / [data-view] / [data-tab] / [data-page])
  const seenScreens = new Set<string>();
  const screenOpenRe =
    /<(?:section|div|main|article)\b[^>]*\b(?:data-screen|data-view|data-page|data-tab)=["']([a-zA-Z0-9_-]{2,36})["'][^>]*>/gi;
  let scm: RegExpExecArray | null;
  while ((scm = screenOpenRe.exec(cleanHtml)) !== null) {
    const rawName = (scm[1] || '').trim();
    if (!rawName || seenScreens.has(rawName.toLowerCase())) continue;
    seenScreens.add(rawName.toLowerCase());
    const range = findScreenTagRange(cleanHtml, rawName);
    if (range) {
      files.push({
        id: `screens/${rawName}.html`,
        label: `screens/${rawName}.html`,
        content: cleanHtml.slice(range.start, range.end),
        kind: 'screen',
        editable: true,
      });
    }
    if (seenScreens.size >= 8) break;
  }

  return files;
}

export function validateJsSyntaxClient(jsCode: string): string | null {
  const trimmed = jsCode.trim();
  if (!trimmed) return null;
  try {
    // Syntax check only (never executes the function body)
    new Function(trimmed);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid JavaScript syntax';
  }
}

export function applyFileEditToHtml(
  fullHtml: string,
  filePath: string,
  nextContent: string
): { ok: true; html: string } | { ok: false; error: string } {
  const trimmedNext = nextContent.trim();

  if (filePath === 'index.html') {
    if (!trimmedNext || !/<[a-z]/i.test(trimmedNext)) {
      return { ok: false, error: 'index.html must contain valid HTML markup.' };
    }
    const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let jm: RegExpExecArray | null;
    while ((jm = scriptRe.exec(trimmedNext)) !== null) {
      if (isSafetyOrJsonScript(jm[1] || '')) continue;
      if (/\btype\s*=\s*["']module["']/i.test(jm[1] || '')) continue;
      const err = validateJsSyntaxClient(jm[2] || '');
      if (err) {
        return { ok: false, error: `JavaScript syntax error in <script>: ${err}` };
      }
    }
    return { ok: true, html: trimmedNext };
  }

  if (filePath === 'styles.css') {
    const newStyleTag = `<style>\n${nextContent}\n</style>`;
    let replacedFirst = false;
    let updated = fullHtml.replace(/<style\b([^>]*)>[\s\S]*?<\/style>/gi, (full, attrs) => {
      if (/data-aicraft-safety/i.test(attrs || '')) return full;
      if (!replacedFirst) {
        replacedFirst = true;
        return newStyleTag;
      }
      return '';
    });

    if (!replacedFirst) {
      if (SAFETY_STYLE_RE.test(updated)) {
        SAFETY_STYLE_RE.lastIndex = 0;
        updated = updated.replace(SAFETY_STYLE_RE, (m) => `${newStyleTag}\n${m}`);
      } else if (/<\/head>/i.test(updated)) {
        updated = updated.replace(/<\/head>/i, `${newStyleTag}\n</head>`);
      } else {
        updated = `${newStyleTag}\n${updated}`;
      }
    }
    return { ok: true, html: updated };
  }

  if (filePath === 'app.js') {
    const syntaxErr = validateJsSyntaxClient(nextContent);
    if (syntaxErr) {
      return { ok: false, error: `JavaScript syntax error: ${syntaxErr}` };
    }

    const newScriptTag = `<script>\n${nextContent}\n</script>`;
    let replacedFirst = false;
    let updated = fullHtml.replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, (full, attrs) => {
      if (isSafetyOrJsonScript(attrs || '')) return full;
      if (!replacedFirst) {
        replacedFirst = true;
        return newScriptTag;
      }
      return '';
    });

    if (!replacedFirst) {
      if (SAFETY_SCRIPT_RE.test(updated)) {
        SAFETY_SCRIPT_RE.lastIndex = 0;
        updated = updated.replace(SAFETY_SCRIPT_RE, (m) => `${newScriptTag}\n${m}`);
      } else if (/<\/body>/i.test(updated)) {
        updated = updated.replace(/<\/body>/i, `${newScriptTag}\n</body>`);
      } else {
        updated = `${updated}\n${newScriptTag}`;
      }
    }
    return { ok: true, html: updated };
  }

  if (filePath.startsWith('screens/')) {
    const screenName = filePath.replace(/^screens\//, '').replace(/\.html$/i, '');
    const range = findScreenTagRange(fullHtml, screenName);
    if (!range) {
      return {
        ok: false,
        error: `Could not locate <section data-screen="${screenName}"> in index.html. Edit index.html directly instead.`,
      };
    }
    if (!trimmedNext || !/<[a-z]/i.test(trimmedNext)) {
      return { ok: false, error: 'Screen HTML cannot be empty.' };
    }
    const updated = `${fullHtml.slice(0, range.start)}${trimmedNext}${fullHtml.slice(range.end)}`;
    return { ok: true, html: updated };
  }

  return { ok: false, error: `${filePath} is a read-only generated reference.` };
}
