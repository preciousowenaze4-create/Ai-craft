import { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, Loader2 } from 'lucide-react';
import { BuildMode } from '../types/craft';
import { extractRenderableScreensFromHtml } from '../utils/screenExtractor';

interface ScreenStudioStripProps {
  html?: string;
  mode: BuildMode;
  isWorking: boolean;
  phaseLabel?: string;
  plannedTotalCount?: number;
  onOpenPreview?: () => void;
}

export function ScreenStudioStrip({
  html,
  mode,
  isWorking,
  phaseLabel,
  plannedTotalCount,
  onOpenPreview,
}: ScreenStudioStripProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);

  const screens = useMemo(
    () => extractRenderableScreensFromHtml(html, mode),
    [html, mode]
  );

  // Keep activeIdx bounded when screens list grows or resets
  useEffect(() => {
    if (screens.length === 0) {
      setActiveIdx(0);
    } else if (activeIdx >= screens.length) {
      setActiveIdx(screens.length - 1);
    }
  }, [activeIdx, screens.length]);

  const handleStripScroll = () => {
    const el = scrollRef.current;
    if (!el || screens.length <= 1) return;
    const center = el.scrollLeft + el.clientWidth / 2;
    let bestIdx = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    const cards = el.querySelectorAll<HTMLElement>('[data-studio-card="1"]');
    cards.forEach((card, idx) => {
      const cardCenter = card.offsetLeft + card.offsetWidth / 2;
      const dist = Math.abs(cardCenter - center);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = idx;
      }
    });
    if (bestIdx !== activeIdx) {
      setActiveIdx(bestIdx);
    }
  };

  const drawnCount = screens.length;
  const totalCount = isWorking
    ? Math.max(drawnCount, plannedTotalCount || 5)
    : Math.max(1, drawnCount);
  const activeScreen = screens[activeIdx] ?? screens[0] ?? null;

  // Dimensions & CSS scale for crisp non-squished rendering inside each card
  const isMobile = mode === 'mobile';
  const cardWidth = isMobile ? 228 : 312;
  const cardHeight = isMobile ? 444 : 220;
  const virtualWidth = isMobile ? 390 : 1024;
  const virtualHeight = isMobile ? 760 : 722;
  const scale = cardWidth / virtualWidth;

  return (
    <div
      className="rounded-[22px] border border-black/[0.08] overflow-hidden select-none"
      style={{
        backgroundColor: '#F5EFE6',
        backgroundImage:
          'radial-gradient(rgba(162, 143, 118, 0.34) 1.25px, transparent 1.25px)',
        backgroundSize: '10px 10px',
      }}
    >
      {/* Horizontal Scrollable Studio Canvas */}
      <div
        ref={scrollRef}
        onScroll={handleStripScroll}
        className="w-full overflow-x-auto touch-pan-x overscroll-x-contain snap-x snap-mandatory flex items-center gap-4 px-5 pt-5 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {screens.map((screen, idx) => {
          const isCurrent = idx === activeIdx;
          return (
            <div
              key={`${screen.id}-${idx}`}
              data-studio-card="1"
              onClick={() => {
                setActiveIdx(idx);
                const el = scrollRef.current;
                const card = el?.querySelectorAll<HTMLElement>('[data-studio-card="1"]')[idx];
                if (el && card) {
                  el.scrollTo({
                    left: card.offsetLeft - (el.clientWidth - card.offsetWidth) / 2,
                    behavior: 'smooth',
                  });
                }
              }}
              className={`snap-center shrink-0 relative bg-white overflow-hidden transition-all duration-200 border ${
                isMobile ? 'rounded-[28px]' : 'rounded-[16px]'
              } ${
                isCurrent
                  ? 'border-black/[0.12] shadow-[0_14px_34px_rgba(24,18,12,0.12)]'
                  : 'border-black/[0.07] opacity-90 shadow-[0_6px_18px_rgba(24,18,12,0.06)]'
              }`}
              style={{ width: `${cardWidth}px`, height: `${cardHeight}px` }}
            >
              <iframe
                title={screen.title}
                srcDoc={screen.isolatedHtml}
                sandbox="allow-scripts allow-same-origin"
                className="border-0 pointer-events-none block bg-white"
                style={{
                  width: `${virtualWidth}px`,
                  height: `${virtualHeight}px`,
                  transform: `scale(${scale})`,
                  transformOrigin: 'top left',
                }}
              />

              {!isWorking && isCurrent && onOpenPreview && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenPreview();
                  }}
                  aria-label={`Open full preview of ${screen.title}`}
                  className="absolute bottom-2.5 right-2.5 h-7 px-2.5 rounded-full bg-black/75 hover:bg-black/90 text-white text-[11px] font-medium inline-flex items-center gap-1 backdrop-blur-xs shadow-sm active:scale-95 transition-all"
                >
                  <Eye className="w-3 h-3" />
                  <span>Preview</span>
                </button>
              )}
            </div>
          );
        })}

        {/* Live Pending Screen Placeholder Card while AI draws & verifies next screen */}
        {isWorking && (drawnCount === 0 || drawnCount < totalCount) && (
          <div
            data-studio-card="1"
            className={`snap-center shrink-0 flex flex-col items-center justify-center gap-2.5 px-5 text-center border border-dashed border-[#C7B8A1] bg-white/70 backdrop-blur-xs ${
              isMobile ? 'rounded-[28px]' : 'rounded-[16px]'
            }`}
            style={{ width: `${cardWidth}px`, height: `${cardHeight}px` }}
          >
            <Loader2 className="w-5 h-5 animate-spin text-[#6D4AFF]" />
            <p className="text-[12.5px] font-medium text-[#4A4238] leading-snug max-w-[180px]">
              {drawnCount === 0
                ? phaseLabel || 'Designing screens & checking layout...'
                : phaseLabel || `Checking screen ${drawnCount} & drawing next view...`}
            </p>
          </div>
        )}
      </div>

      {/* Bottom Studio Caption Matching Multi-Screen Canvas */}
      <div className="px-4 pb-3.5 pt-1 flex items-center justify-center gap-2 text-center">
        {isWorking && (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-[#6D4AFF] shrink-0" />
        )}
        <span className="text-[13.5px] font-medium tracking-[-0.01em] text-[#5C5346] tabular-nums">
          {activeScreen
            ? `${activeScreen.title} · ${drawnCount} of ${totalCount} screens drawn`
            : phaseLabel || 'Preparing live studio screens...'}
        </span>
      </div>
    </div>
  );
}
