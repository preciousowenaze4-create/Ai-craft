export interface VisualElementSelection {
  selector: string;
  tagName: string;
  text: string;
  canEditText: boolean;
  color: string;
  backgroundColor: string;
  fontSize: string;
  borderRadius: string;
  outerHtmlSnippet: string;
}

export interface VisualElementPatch {
  text?: string;
  color?: string;
  backgroundColor?: string;
  fontSize?: string;
  borderRadius?: string;
}

export function applyVisualPatchToHtml(
  fullHtml: string,
  selector: string,
  patch: VisualElementPatch
): { ok: true; html: string } | { ok: false; error: string } {
  if (!fullHtml.trim() || !selector.trim()) {
    return { ok: false, error: 'No element selected to update.' };
  }

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(fullHtml, 'text/html');
    const target = doc.querySelector(selector) as HTMLElement | null;
    if (!target) {
      return {
        ok: false,
        error: 'Could not locate that dynamic element in source HTML — try Edit with AI instead.',
      };
    }

    if (typeof patch.text === 'string' && target.children.length === 0) {
      target.textContent = patch.text;
    }
    if (patch.color) {
      target.style.color = patch.color;
    }
    if (patch.backgroundColor) {
      target.style.backgroundColor = patch.backgroundColor;
    }
    if (patch.fontSize) {
      target.style.fontSize = patch.fontSize;
    }
    if (patch.borderRadius) {
      target.style.borderRadius = patch.borderRadius;
    }

    const doctypeMatch = /^<!DOCTYPE[^>]*>/i.exec(fullHtml);
    const doctype = doctypeMatch ? doctypeMatch[0] : '<!DOCTYPE html>';
    return {
      ok: true,
      html: `${doctype}\n${doc.documentElement.outerHTML}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Unable to apply visual edit.',
    };
  }
}
