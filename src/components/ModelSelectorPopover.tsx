import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, RefreshCw, Search, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { BuildMode, MODE_THEMES, OpenRouterModel } from '../types/craft';
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
  const [query, setQuery] = useState('');
  const [gatewayFilter, setGatewayFilter] = useState<
    'all' | 'auto' | 'gemini' | 'groq' | 'openrouter' | 'huggingface' | 'ngrok' | 'pollinations'
  >('all');
  const [categoryFilter, setCategoryFilter] = useState<
    'all' | 'code' | 'image' | 'music' | 'video'
  >('all');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const theme = MODE_THEMES[mode];

  const activeModel = useMemo(
    () => models.find((m) => m.id === selectedModel) ?? null,
    [models, selectedModel]
  );

  const availableGateways = useMemo(() => {
    const set = new Set<string>();
    for (const m of models) {
      set.add(m.gateway || 'auto');
    }
    return Array.from(set);
  }, [models]);

  const hasFreeImageModels = useMemo(
    () => models.some((m) => m.category === 'image' || m.capabilities?.includes('Image')),
    [models]
  );
  const hasFreeMusicModels = useMemo(
    () => models.some((m) => m.category === 'music' || m.capabilities?.includes('Music')),
    [models]
  );
  const hasFreeVideoModels = useMemo(
    () => models.some((m) => m.category === 'video' || m.capabilities?.includes('Video')),
    [models]
  );

  const filteredModels = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    return models.filter((m) => {
      const gw = m.gateway || 'auto';
      if (gatewayFilter !== 'all' && gw !== gatewayFilter) {
        return false;
      }

      if (categoryFilter === 'code') {
        const isCodeOrRouter =
          m.category === 'code' ||
          m.category === 'router' ||
          Boolean(m.capabilities?.some((c) => c === 'Code' || c === 'Build'));
        if (!isCodeOrRouter) return false;
      } else if (categoryFilter === 'image') {
        if (m.category !== 'image' && !m.capabilities?.includes('Image')) return false;
      } else if (categoryFilter === 'music') {
        if (m.category !== 'music' && !m.capabilities?.includes('Music')) return false;
      } else if (categoryFilter === 'video') {
        if (m.category !== 'video' && !m.capabilities?.includes('Video')) return false;
      }

      if (!trimmed) return true;
      return (
        m.name.toLowerCase().includes(trimmed) ||
        m.id.toLowerCase().includes(trimmed) ||
        m.provider.toLowerCase().includes(trimmed) ||
        gw.toLowerCase().includes(trimmed) ||
        Boolean(m.capabilities?.some((c) => c.toLowerCase().includes(trimmed)))
      );
    });
  }, [models, query, gatewayFilter, categoryFilter]);

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
      if (next && models.length === 0 && !modelsLoading) {
        onRetryModels();
      }
      return next;
    });
  };

  const handleSelect = (modelId: string) => {
    onSelectModel(modelId);
    setOpen(false);
    setQuery('');
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
            ? `Select AI model (current: ${activeModel.name})`
            : 'Select AI model'
        }
        title={activeModel ? activeModel.name : 'Select AI model'}
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
            aria-label="Available AI models"
            style={dynamicPanelStyle}
            className="absolute right-0 bottom-full mb-2 z-50 w-[min(256px,calc(100vw-3rem))] rounded-[18px] border backdrop-blur-xl overflow-hidden flex flex-col"
          >
            {/* Compact Header + Studio Tabs */}
            <div className="px-2.5 pt-2.5 pb-2 border-b border-black/[0.08] flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2 px-0.5">
                <span className="font-display font-semibold text-[12.5px] text-[#0B0B0F] tracking-[-0.01em]">
                  AI Craft Engine
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-[#52525B] tabular-nums">
                    {modelsLoading
                      ? 'Loading...'
                      : `${filteredModels.length} active`}
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

              {availableGateways.length > 1 && models.length > 8 && (
                <div className="flex items-center gap-1 overflow-x-auto pb-0.5 text-[10.5px]">
                  {(
                    [
                      { id: 'all', label: 'All' },
                      ...(availableGateways.includes('auto')
                        ? [{ id: 'auto', label: 'Architect' }]
                        : []),
                      ...(availableGateways.includes('groq')
                        ? [{ id: 'groq', label: 'Groq' }]
                        : []),
                      ...(availableGateways.includes('openrouter')
                        ? [{ id: 'openrouter', label: 'OpenRouter' }]
                        : []),
                      ...(availableGateways.includes('huggingface')
                        ? [{ id: 'huggingface', label: 'HuggingFace' }]
                        : []),
                      ...(availableGateways.includes('pollinations')
                        ? [{ id: 'pollinations', label: 'Built-in' }]
                        : []),
                    ] as Array<{
                      id: 'all' | 'auto' | 'groq' | 'openrouter' | 'huggingface' | 'pollinations';
                      label: string;
                    }>
                  ).map((gwTab) => {
                    const active = gatewayFilter === gwTab.id;
                    return (
                      <button
                        key={gwTab.id}
                        type="button"
                        onClick={() => setGatewayFilter(gwTab.id)}
                        className={`px-2 py-0.5 rounded-md font-medium shrink-0 transition-colors ${
                          active
                            ? 'bg-[#0B0B0F] text-white'
                            : 'bg-white/70 text-[#52525B] hover:text-[#0B0B0F]'
                        }`}
                      >
                        {gwTab.label}
                      </button>
                    );
                  })}
                </div>
              )}

              {(hasFreeImageModels || hasFreeMusicModels || hasFreeVideoModels) && (
                <div className="flex items-center gap-1 overflow-x-auto pb-0.5 text-[11px]">
                  {(
                    [
                      { id: 'all', label: 'All' },
                      { id: 'code', label: 'Code & Build' },
                      ...(hasFreeImageModels ? [{ id: 'image', label: 'Image' }] : []),
                      ...(hasFreeMusicModels ? [{ id: 'music', label: 'Music' }] : []),
                      ...(hasFreeVideoModels ? [{ id: 'video', label: 'Video' }] : []),
                    ] as Array<{ id: 'all' | 'code' | 'image' | 'music' | 'video'; label: string }>
                  ).map((tab) => {
                    const active = categoryFilter === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setCategoryFilter(tab.id)}
                        className={`px-2 py-0.5 rounded-md font-medium shrink-0 transition-colors ${
                          active
                            ? 'bg-[#0B0B0F] text-white'
                            : 'bg-white/70 text-[#52525B] hover:text-[#0B0B0F]'
                        }`}
                      >
                        {tab.label}
                      </button>
                    );
                  })}
                </div>
              )}

              {models.length > 6 && (
                <div className="relative flex items-center">
                  <Search className="w-3.5 h-3.5 text-[#52525B] absolute left-2.5 pointer-events-none" />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search models..."
                    aria-label="Search AI gateway models"
                    className="w-full h-8 pl-7 pr-6 rounded-lg bg-white/80 border border-black/[0.07] text-[12.5px] text-[#0B0B0F] placeholder:text-[#71717A] focus:outline-none focus:bg-white"
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery('')}
                      aria-label="Clear search"
                      className="absolute right-1.5 p-0.5 rounded-full text-[#52525B] hover:text-[#0B0B0F]"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Compact, Smoothly Scrollable Dynamic-Color List */}
            <div
              role="listbox"
              aria-label="OpenRouter models"
              className="max-h-[164px] overflow-y-auto overscroll-contain touch-pan-y divide-y divide-black/[0.06]"
              style={{
                WebkitOverflowScrolling: 'touch',
                scrollbarWidth: 'thin',
                scrollbarColor:
                  mode === 'mobile'
                    ? 'rgba(217, 119, 6, 0.35) transparent'
                    : 'rgba(168, 85, 247, 0.35) transparent',
              }}
            >
              {modelsLoading && models.length === 0 ? (
                <div className="py-6 px-3 flex flex-col items-center justify-center gap-1.5 text-[11.5px] text-[#52525B]">
                  <Loader2
                    className="w-4 h-4 animate-spin"
                    style={{ color: theme.accentColor }}
                  />
                  <span>Loading AI models...</span>
                </div>
              ) : modelsError && models.length === 0 ? (
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
              ) : filteredModels.length === 0 ? (
                <div className="py-6 px-3 text-center text-[11.5px] text-[#52525B]">
                  {query ? 'No matching models.' : 'No models available.'}
                </div>
              ) : (
                filteredModels.map((model) => {
                  const isSelected = model.id === selectedModel;
                  const ctxLabel = formatContextLength(model.contextLength);
                  return (
                    <button
                      key={model.id}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => handleSelect(model.id)}
                      className="w-full text-left px-2.5 py-2 min-h-[42px] flex items-center gap-2 transition-colors"
                      style={{
                        backgroundColor: isSelected
                          ? mode === 'mobile'
                            ? 'rgba(255, 255, 255, 0.85)'
                            : 'rgba(255, 255, 255, 0.85)'
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
                          {model.capabilities && model.capabilities.length > 0 ? (
                            <span className="truncate font-medium text-[#3F3F46]">
                              {model.capabilities.slice(0, 2).join(' · ')}
                            </span>
                          ) : (
                            <span className="font-mono truncate">{model.id}</span>
                          )}
                          {ctxLabel && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="shrink-0 tabular-nums">
                                {ctxLabel}
                              </span>
                            </>
                          )}
                          {(model.tierLabel || model.isFree) && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span
                                className="shrink-0 font-semibold"
                                style={{ color: theme.accentColor }}
                              >
                                {model.tierLabel || 'Free'}
                              </span>
                            </>
                          )}
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
