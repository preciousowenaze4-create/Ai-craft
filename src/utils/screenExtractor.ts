import { BuildMode } from '../types/craft';

export interface ExtractedPreviewScreen {
  id: string;
  title: string;
  isolatedHtml: string;
}

export interface BuiltAppAuditReport {
  screenCount: number;
  screenTitles: string[];
  htmlBytes: number;
  interactiveCount: number;
  hasDbWiring: boolean;
  needsExpansionPass: boolean;
  summaryReason: string;
  critiquePrompt: string;
}

function toHumanScreenTitle(raw: string): string {
  const cleaned = raw
    .replace(/^(?:screen|view|tab|page|panel|section)[-_:\s]*/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  if (!cleaned) return 'Main Screen';
  return cleaned.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

/**
 * Closes unclosed tags smoothly on a partial HTML fragment so it can render live inside an iframe while streaming.
 */
export function closePartialHtmlForLivePreview(partialHtml: string): string {
  let html = partialHtml.trim();
  if (!html) return '';

  // Strip marker wrappers if still present
  html = html
    .replace(/^[\s\S]*?<<<\s*AICRAFT_APP_HTML\s*>>>/i, '')
    .replace(/<<<\s*END_AICRAFT_APP_HTML\s*>>>[\s\S]*$/i, '')
    .replace(/^```(?:html|htm)?\s*/i, '')
    .replace(/\s*```[\s\S]*$/i, '')
    .trim();

  if (!html || !/<[a-z]/i.test(html)) return '';

  if (!/<!doctype|<html\b/i.test(html)) {
    html = `<!DOCTYPE html><html><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1.0" /></head><body>${html}`;
  }

  const lastOpenBracket = html.lastIndexOf('<');
  const lastCloseBracket = html.lastIndexOf('>');
  if (lastOpenBracket > lastCloseBracket && lastOpenBracket > 0) {
    html = html.slice(0, lastOpenBracket).trimEnd();
  }

  const lastStyleOpen = html.toLowerCase().lastIndexOf('<style');
  const lastStyleClose = html.toLowerCase().lastIndexOf('</style>');
  if (lastStyleOpen > lastStyleClose) {
    html += '\n</style>';
  }

  const lastScriptOpen = html.toLowerCase().lastIndexOf('<script');
  const lastScriptClose = html.toLowerCase().lastIndexOf('</script>');
  if (lastScriptOpen > lastScriptClose) {
    const lastNl = html.lastIndexOf('\n');
    if (lastNl > lastScriptOpen) {
      html = html.slice(0, lastNl);
    }
    html += '\n</script>';
  }

  if (!/<\/body>/i.test(html)) html += '\n</body>';
  if (!/<\/html>/i.test(html)) html += '\n</html>';
  return html;
}

interface RawDetectedScreen {
  id: string;
  attrName: string;
  attrValue: string;
  title: string;
}

function detectScreensInHtml(html: string): RawDetectedScreen[] {
  const found: RawDetectedScreen[] = [];
  const seenKey = new Set<string>();

  const pushScreen = (attrName: string, attrValue: string, explicitTitle?: string) => {
    const cleanVal = attrValue.trim();
    if (!cleanVal) return;
    const norm = cleanVal.toLowerCase();
    if (
      ['app', 'root', 'main', 'container', 'wrapper', 'shell', 'body', 'content', 'viewport'].includes(
        norm
      )
    ) {
      return;
    }
    const dedupe = norm.replace(/^(?:screen|view|tab|page)[-_]?/, '');
    if (seenKey.has(dedupe)) return;
    seenKey.add(dedupe);
    found.push({
      id: cleanVal,
      attrName,
      attrValue: cleanVal,
      title: explicitTitle?.trim() || toHumanScreenTitle(cleanVal),
    });
  };

  // 1. Prefer explicit semantic screen attributes: data-screen / data-view / data-page / data-tab on containers
  const dataAttrTagRegex =
    /<(section|div|main|article)\b([^>]*\b(?:data-screen|data-view|data-page|data-tab)=["']([^"']{1,48})["'][^>]*)>/gi;
  for (const m of html.matchAll(dataAttrTagRegex)) {
    const fullAttrs = m[2] || '';
    const attrPair = /\b(data-screen|data-view|data-page|data-tab)=["']([^"']{1,48})["']/i.exec(
      fullAttrs
    );
    const titlePair = /\b(?:data-screen-title|data-title|aria-label)=["']([^"']{1,48})["']/i.exec(
      fullAttrs
    );
    if (attrPair) {
      pushScreen(attrPair[1], attrPair[2], titlePair?.[1]);
    }
    if (found.length >= 8) break;
  }

  // 2. Fallback: <section id="..."> or view/screen divs with id
  if (found.length < 2) {
    const sectionIdRegex =
      /<section\b([^>]*\bid=["']([a-zA-Z0-9_-]{2,48})["'][^>]*)>|<div\b([^>]*\bid=["']([a-zA-Z0-9_-]*(?:screen|view|page|chats|conversation|messages|profile|contacts|new-chat|message-info|feed|discover|create|inbox|booking|doctors|catalog|cart|checkout|dashboard|settings)[a-zA-Z0-9_-]*)["'][^>]*)>/gi;
    for (const m of html.matchAll(sectionIdRegex)) {
      const attrs = m[1] || m[3] || '';
      const idVal = m[2] || m[4] || '';
      const titlePair = /\b(?:data-screen-title|data-title|aria-label)=["']([^"']{1,48})["']/i.exec(
        attrs
      );
      if (idVal) {
        pushScreen('id', idVal, titlePair?.[1]);
      }
      if (found.length >= 8) break;
    }
  }

  return found;
}

function buildIsolatedScreenHtml(
  fullHtml: string,
  allScreens: RawDetectedScreen[],
  target: RawDetectedScreen | null,
  mode: BuildMode
): string {
  const safeBase = fullHtml.trim();
  if (!safeBase) return '';

  const viewportHintStyle =
    mode === 'mobile'
      ? `html, body { width: 100% !important; min-height: 100% !important; overflow-x: hidden !important; margin: 0 !important; }`
      : `html, body { width: 100% !important; min-height: 100% !important; overflow-x: hidden !important; margin: 0 !important; }`;

  const screenActivationScript = target
    ? `<script data-aicraft-card-focus="1">
(function(){
  var targetAttr = ${JSON.stringify(target.attrName)};
  var targetVal = ${JSON.stringify(target.attrValue)};
  var allSelectors = ${JSON.stringify(
    allScreens.map((s) => `[${s.attrName}="${s.attrValue.replace(/"/g, '')}"]`)
  )};
  function activateTargetScreen() {
    try {
      var selector = '[' + targetAttr + '="' + targetVal.replace(/"/g, '') + '"]';
      var el = document.querySelector(selector);
      if (!el) return;

      // Try calling app's native screen switcher if available
      if (typeof window.showScreen === 'function') { try { window.showScreen(targetVal); } catch(e){} }
      if (typeof window.switchScreen === 'function') { try { window.switchScreen(targetVal); } catch(e){} }
      if (typeof window.openScreen === 'function') { try { window.openScreen(targetVal); } catch(e){} }
      if (typeof window.switchTab === 'function') { try { window.switchTab(targetVal); } catch(e){} }

      var tabBtn = document.querySelector('button[data-target="' + targetVal + '"], button[data-tab="' + targetVal + '"], [data-nav="' + targetVal + '"]');
      if (tabBtn && typeof tabBtn.click === 'function') {
        try { tabBtn.click(); } catch(e){}
      }

      // Enforce isolated screen visibility cleanly for the preview card
      for (var i = 0; i < allSelectors.length; i += 1) {
        var nodes = document.querySelectorAll(allSelectors[i]);
        for (var j = 0; j < nodes.length; j += 1) {
          var node = nodes[j];
          if (node === el) {
            node.classList.remove('hidden', 'is-hidden');
            node.classList.add('active', 'is-active');
            node.removeAttribute('hidden');
            node.style.display = '';
            if (getComputedStyle(node).display === 'none') {
              node.style.display = 'flex';
              node.style.flexDirection = 'column';
            }
            node.style.opacity = '1';
            node.style.visibility = 'visible';
          } else if (!node.contains(el) && !el.contains(node)) {
            node.style.display = 'none';
          }
        }
      }
    } catch (err) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function(){
      setTimeout(activateTargetScreen, 60);
      setTimeout(activateTargetScreen, 260);
    });
  } else {
    setTimeout(activateTargetScreen, 60);
    setTimeout(activateTargetScreen, 260);
  }
})();
</script>`
    : '';

  const cardPolishStyle = `<style data-aicraft-card-style="1">
${viewportHintStyle}
::-webkit-scrollbar { width: 0; height: 0; }
</style>`;

  let out = safeBase;
  if (/<\/head>/i.test(out)) {
    out = out.replace(/<\/head>/i, `${cardPolishStyle}\n</head>`);
  } else {
    out = `${cardPolishStyle}\n${out}`;
  }

  if (screenActivationScript) {
    if (/<\/body>/i.test(out)) {
      out = out.replace(/<\/body>/i, `${screenActivationScript}\n</body>`);
    } else {
      out = `${out}\n${screenActivationScript}`;
    }
  }

  return out;
}

export function extractRenderableScreensFromHtml(
  html: string | undefined,
  mode: BuildMode
): ExtractedPreviewScreen[] {
  if (!html || !html.trim()) return [];
  const runnableHtml = closePartialHtmlForLivePreview(html);
  if (!runnableHtml || runnableHtml.length < 180) return [];

  const detected = detectScreensInHtml(runnableHtml);
  if (detected.length === 0) {
    return [
      {
        id: 'main',
        title: mode === 'mobile' ? 'Main Screen' : 'Main View',
        isolatedHtml: buildIsolatedScreenHtml(runnableHtml, [], null, mode),
      },
    ];
  }

  return detected.map((screen) => ({
    id: screen.id,
    title: screen.title,
    isolatedHtml: buildIsolatedScreenHtml(runnableHtml, detected, screen, mode),
  }));
}

export function inspectBuiltAppCompleteness(
  html: string,
  userMessage: string
): BuiltAppAuditReport {
  const cleanHtml = html.trim();
  const detected = detectScreensInHtml(cleanHtml);
  const screenCount = detected.length;
  const screenTitles = detected.map((s) => s.title);
  const htmlBytes = cleanHtml.length;

  const interactiveCount = (
    cleanHtml.match(/<(?:button|input|select|textarea|form|a)\b/gi) || []
  ).length;
  const hasDbWiring =
    /\bAICraft(?:\??\.db|\s*\[\s*['"]db['"]\s*\])|\blocalStorage\b|\bindexedDB\b/i.test(
      cleanHtml
    );

  const isSimpleSinglePurposeQuery =
    /\b(calculator|timer|stopwatch|clock|counter|converter|qr\s*generator|quote)\b/i.test(
      userMessage
    ) && !/\b(app|whatsapp|tiktok|instagram|clinic|store|shop|dashboard|clone|chat)\b/i.test(userMessage);

  const minScreensTarget = isSimpleSinglePurposeQuery ? 1 : 3;
  const minBytesTarget = isSimpleSinglePurposeQuery ? 5000 : 12000;

  const gaps: string[] = [];
  if (screenCount < minScreensTarget) {
    gaps.push(
      `Only ${screenCount || 1} screen${screenCount === 1 ? '' : 's'} detected (${
        screenTitles.join(', ') || 'Main'
      }); expected at least 4-5 distinct interactive screens using <section data-screen="..." data-screen-title="...">`
    );
  }
  if (htmlBytes < minBytesTarget) {
    gaps.push(
      `Code size is only ${(htmlBytes / 1024).toFixed(1)} KB — layout and interactions appear rushed or incomplete`
    );
  }
  if (interactiveCount < 6) {
    gaps.push(`Only ${interactiveCount} interactive controls found`);
  }
  if (!hasDbWiring && !isSimpleSinglePurposeQuery) {
    gaps.push('Missing real-time window.AICraft.db data persistence & live seed records');
  }

  const needsExpansionPass = gaps.length > 0;
  const summaryReason =
    gaps.length > 0
      ? gaps.join('; ')
      : `Verified ${screenCount} screens (${(htmlBytes / 1024).toFixed(1)} KB)`;

  const critiquePrompt = [
    `SELF-INSPECTION & VISUAL CODE AUDIT (CRITICAL — FIX ALL GAPS RIGHT NOW):`,
    `The user asked: "${userMessage}".`,
    `You just generated a first pass (${(htmlBytes / 1024).toFixed(1)} KB) with screens: [${
      screenTitles.length > 0 ? screenTitles.join(', ') : 'Single combined screen'
    }].`,
    `AUDIT FINDINGS:`,
    ...gaps.map((g) => `- ${g}`),
    ``,
    `LOOK AT YOUR CODE CRITICALLY LIKE A SENIOR ENGINEER REVIEWING LIVE PREVIEW:`,
    `- Does this actually look and work like a full, production-ready version of what the user asked for, or did you only build one side/surface?`,
    `- Keep what already works well, and UPGRADE + EXPAND the app into a complete 4 to 5 screen production application using explicit \`<section data-screen="<id>" data-screen-title="<Screen Name>">...</section>\` containers (e.g. for messaging: Chats, Conversation, Message info, New Chat, Profile; for social: Feed, Discover, Create, Inbox, Profile; for clinic/business: Home, Specialists/Catalog, Booking/Cart, Details, Profile).`,
    `- Populate EVERY screen richly with realistic people, verified HTTPS photos/avatars (with CSS initials/gradient fallbacks on error), working tab/button navigation between screens, working message/create/booking forms, and full \`window.AICraft.db\` read/write persistence.`,
    `- Output your brief updated summary followed by the COMPLETE upgraded app inside \`<<<AICRAFT_APP_HTML>>>...<<<END_AICRAFT_APP_HTML>>>\`.`,
  ].join('\n');

  return {
    screenCount,
    screenTitles,
    htmlBytes,
    interactiveCount,
    hasDbWiring,
    needsExpansionPass,
    summaryReason,
    critiquePrompt,
  };
}
