import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CheckCircle2, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { BuildMode, MODE_THEMES, OpenRouterModel } from '../types/craft';
import { isPuterSignedInClient, signInPuterClient } from '../utils/browserAi';
import { ProviderLogo } from './ProviderLogo';

interface ModelSelectorPopoverProps {
  mode: BuildMode;
  models: OpenRouterModel[];
  selectedModel: string;
  modelsLoading: boolean;
  modelsError: string | null;
  isStreaming?: boolean;
  onSelectModel: (modelId: string) => void;
  onRetryModels: () => void;
}

function formatContextLength(ctx: number): string {
  if (!ctx || ctx <= 0) return '';
  if (ctx >= 1_000_000) {
    return `${(ctx / 1_000_000).toFixed(ctx % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (ctx >= 1000) {
    return `${Math.round(ctx / 1000)}K`;
  }
  return `${ctx}`;
}

export function ModelSelectorPopover({
  mode,
  models,
  selectedModel,
  modelsLoading,
  modelsError,
  isStreaming = false,
  onSelectModel,
  onRetryModels,
}: ModelSelectorPopoverProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const theme = MODE_THEMES[mode];
  const [puterConnected, setPuterConnected] = useState(() => isPuterSignedInClient());
  const [connectingPuter, setConnectingPuter] = useState(false);

  const builderModels = useMemo(
    () =>
      models
        .filter((m) => m.category !== 'image' && m.category !== 'music' && m.category !== 'video')
        .slice(0, 2),
    [models]
  );

  const activeModel = useMemo(
    () => builderModels.find((m) => m.id === selectedModel) ?? builderModels[0] ?? null,
    [builderModels, selectedModel]
  );

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const handleToggle = () => {
    setOpen((prev) => {
      const next = !prev;
      if (next) {
        setPuterConnected(isPuterSignedInClient());
        if (builderModels.length === 0 && !modelsLoading) {
          onRetryModels();
        }
      }
      return next;
    });
  };

  const handleConnectPuter = async () => {
    if (connectingPuter) return;
    setConnectingPuter(true);
    try {
      const ok = await signInPuterClient();
      setPuterConnected(ok);
    } finally {
      setConnectingPuter(false);
    }
  };

  const handleSelect = (modelId: string) => {
    onSelectModel(modelId);
    setOpen(false);
  };

  const dynamicPanelStyle =
    mode === 'mobile'
      ? {
          background:
            'linear-gradient(155deg, rgba(255, 253, 244, 0.98) 0%, rgba(254, 243, 199, 0.96) 55%, rgba(253, 230, 138, 0.94) 100%)',
          borderColor: 'rgba(245, 158, 11, 0.34)',
          boxShadow: '0 14px 36px rgba(180, 83, 9, 0.16)',
        }
      : {
          background:
            'linear-gradient(155deg, rgba(254, 247, 255, 0.98) 0%, rgba(250, 232, 255, 0.96) 55%, rgba(233, 213, 255, 0.94) 100%)',
          borderColor: 'rgba(192, 38, 211, 0.30)',
          boxShadow: '0 14px 36px rgba(126, 34, 206, 0.16)',
        };

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={
          activeModel
            ? `Switch AI builder (current: ${activeModel.name})`
            : 'Switch AI builder'
        }
        title={activeModel ? activeModel.name : 'Switch AI builder'}
        className={`w-8 h-8 rounded-full flex items-center justify-center transition-all duration-150 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7A68F6] ${
          open
            ? 'text-[#0B0B0F]'
            : 'text-[#52525B] hover:text-[#0B0B0F]'
        }`}
        style={{
          backgroundColor: open
            ? mode === 'mobile'
              ? 'rgba(253, 230, 138, 0.55)'
              : 'rgba(245, 208, 254, 0.55)'
            : 'transparent',
        }}
      >
        <span
          aria-hidden="true"
          className="font-display font-semibold text-[16px] leading-none lowercase select-none -mt-0.5 transition-transform duration-150"
          style={{
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        >
          v
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.96 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            role="dialog"
            aria-label="Switch AI builder"
            style={dynamicPanelStyle}
            className="absolute right-0 bottom-full mb-2 z-50 w-[min(272px,calc(100vw-3rem))] rounded-[18px] border backdrop-blur-xl overflow-hidden flex flex-col"
          >
            <div className="px-2.5 pt-2.5 pb-2 border-b border-black/[0.08] flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2 px-0.5">
                <span className="font-display font-semibold text-[12.5px] text-[#0B0B0F] tracking-[-0.01em]">
                  Switch Vision &amp; Code AI
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-[#52525B] tabular-nums">
                    {modelsLoading ? 'Loading...' : `${builderModels.length} ready`}
                  </span>
                  <button
                    type="button"
                    onClick={onRetryModels}
                    disabled={modelsLoading}
                    aria-label="Refresh AI models"
                    className="p-1 rounded-full text-[#52525B] hover:text-[#0B0B0F] hover:bg-black/[0.05] disabled:opacity-40 transition-colors"
                  >
                    <RefreshCw
                      className={`w-3 h-3 ${modelsLoading ? 'animate-spin' : ''}`}
                    />
                  </button>
                </div>
              </div>

              {!builderModels.some((m) => m.gateway === 'puter') ? (
                <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-emerald-500/12 border border-emerald-600/20 text-[10.5px] font-medium text-emerald-900">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                  <span className="truncate">
                    No-Login Free Server AI Active
                  </span>
                </div>
              ) : puterConnected ? (
                <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-emerald-500/12 border border-emerald-600/20 text-[10.5px] font-medium text-emerald-900">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                  <span className="truncate">
                    Screenshots &amp; Real-Time Code Connected
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handleConnectPuter}
                  disabled={connectingPuter}
                  className="w-full flex items-center justify-between gap-1.5 px-2 py-1.5 rounded-lg bg-white/90 hover:bg-white border border-black/[0.08] text-left transition-colors active:scale-[0.99]"
                >
                  <span className="inline-flex items-center gap-1.5 min-w-0">
                    {connectingPuter ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-[#6D4AFF] shrink-0" />
                    ) : (
                      <Sparkles className="w-3.5 h-3.5 text-[#6D4AFF] shrink-0" />
                    )}
                    <span className="text-[10.5px] font-semibold text-[#0B0B0F] truncate">
                      Connect Free Puter (Unlock Screenshots)
                    </span>
                  </span>
                </button>
              )}
            </div>

            <div
              role="listbox"
              aria-label="Available AI builders"
              className="divide-y divide-black/[0.06]"
            >
              {modelsLoading && builderModels.length === 0 ? (
                <div className="py-5 px-3 flex flex-col items-center justify-center gap-1.5 text-[11.5px] text-[#52525B]">
                  <Loader2
                    className="w-4 h-4 animate-spin"
                    style={{ color: theme.accentColor }}
                  />
                  <span>Loading builders...</span>
                </div>
              ) : modelsError && builderModels.length === 0 ? (
                <div className="py-5 px-3 text-center flex flex-col items-center gap-2">
                  <p className="text-[11.5px] text-red-700 leading-snug">
                    {modelsError}
                  </p>
                  <button
                    type="button"
                    onClick={onRetryModels}
                    className="px-3 py-1 rounded-full bg-[#0B0B0F] text-white text-[11.5px] font-medium hover:bg-black/85 active:scale-95 transition-all"
                  >
                    Retry
                  </button>
                </div>
              ) : (
                builderModels.map((model) => {
                  const isSelected = activeModel?.id === model.id;
                  const ctxLabel = formatContextLength(model.contextLength);
                  return (
                    <button
                      key={model.id}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => handleSelect(model.id)}
                      className="w-full text-left px-2.5 py-2.5 min-h-[46px] flex items-center gap-2 transition-colors"
                      style={{
                        backgroundColor: isSelected
                          ? 'rgba(255, 255, 255, 0.88)'
                          : 'transparent',
                      }}
                    >
                      <ProviderLogo
                        provider={model.provider}
                        modelId={model.id}
                        size={22}
                        isTracking={isSelected && isStreaming}
                        trackingColor={theme.accentColor}
                      />

                      <div className="min-w-0 flex-1">
                        <p className="text-[12.5px] font-medium text-[#0B0B0F] truncate leading-tight">
                          {model.name}
                        </p>
                        <div className="flex items-center gap-1 mt-0.5 text-[10.5px] text-[#52525B] truncate">
                          <span className="truncate font-medium text-[#3F3F46]">
                            Screenshots · Code · DB
                          </span>
                          {ctxLabel && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="shrink-0 tabular-nums">{ctxLabel}</span>
                            </>
                          )}
                          <span aria-hidden="true">·</span>
                          <span
                            className="shrink-0 font-semibold"
                            style={{ color: theme.accentColor }}
                          >
                            {model.tierLabel || 'Free'}
                          </span>
                        </div>
                      </div>

                      {isSelected && (
                        <Check
                          className="w-3.5 h-3.5 shrink-0"
                          style={{ color: theme.accentColor }}
                        />
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
