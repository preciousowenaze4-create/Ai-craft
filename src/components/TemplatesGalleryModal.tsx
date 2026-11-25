import { useEffect, useState } from 'react';
import {
  ArrowRight,
  ExternalLink,
  GitFork,
  Globe,
  Loader2,
  Smartphone,
  Sparkles,
  X,
} from 'lucide-react';
import { STARTER_TEMPLATES, StarterTemplate } from '../data/starterTemplates';
import { BuildMode } from '../types/craft';

export interface CommunityRemixItem {
  appId: string;
  title: string;
  slug: string;
  mode: BuildMode;
  seoTitle?: string;
  seoDescription?: string;
  themeColor?: string;
  logoUrl?: string;
  liveUrl: string;
  tables?: string[];
  version: number;
  updatedAt: string;
}

interface TemplatesGalleryModalProps {
  open: boolean;
  onClose: () => void;
  onUseTemplatePrompt: (template: StarterTemplate, launchImmediately: boolean) => void;
  onRemixApp: (appId: string) => Promise<void>;
}

export function TemplatesGalleryModal({
  open,
  onClose,
  onUseTemplatePrompt,
  onRemixApp,
}: TemplatesGalleryModalProps) {
  const [tab, setTab] = useState<'templates' | 'community'>('templates');
  const [modeFilter, setModeFilter] = useState<'all' | BuildMode>('all');
  const [communityApps, setCommunityApps] = useState<CommunityRemixItem[]>([]);
  const [loadingCommunity, setLoadingCommunity] = useState(false);
  const [remixingId, setRemixingId] = useState<string | null>(null);
  const [galleryError, setGalleryError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || tab !== 'community') return;
    let cancelled = false;
    setLoadingCommunity(true);
    setGalleryError(null);
    fetch('/api/apps/gallery')
      .then((r) => r.json())
      .then((data: { apps?: CommunityRemixItem[] }) => {
        if (!cancelled) {
          setCommunityApps(Array.isArray(data?.apps) ? data.apps : []);
        }
      })
      .catch(() => {
        if (!cancelled) setGalleryError('Unable to load community showcase right now.');
      })
      .finally(() => {
        if (!cancelled) setLoadingCommunity(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, tab]);

  if (!open) return null;

  const filteredTemplates = STARTER_TEMPLATES.filter(
    (t) => modeFilter === 'all' || t.mode === modeFilter
  );
  const filteredCommunity = communityApps.filter(
    (a) => modeFilter === 'all' || a.mode === modeFilter
  );

  const handleRemixClick = async (appId: string) => {
    setRemixingId(appId);
    try {
      await onRemixApp(appId);
      onClose();
    } finally {
      setRemixingId(null);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Templates and Community Remix Gallery"
      className="fixed inset-0 z-[85] bg-black/35 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
    >
      <div className="w-full max-w-[680px] max-h-[88dvh] bg-white rounded-t-[28px] sm:rounded-[28px] border border-black/[0.08] shadow-[0_24px_60px_rgba(11,11,15,0.2)] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="shrink-0 px-5 pt-4 pb-3 border-b border-black/[0.06] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-2xl bg-[#F3F0FF] text-[#6D4AFF] flex items-center justify-center shrink-0">
              <Sparkles className="w-[18px] h-[18px]" />
            </div>
            <div className="min-w-0">
              <h2 className="font-display font-bold text-[17px] text-[#0B0B0F] tracking-[-0.02em] truncate">
                Templates & Remix Gallery
              </h2>
              <p className="text-[12px] text-[#71717A] truncate">
                Start from a blueprint or fork a live community build
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close templates gallery"
            className="w-9 h-9 rounded-full flex items-center justify-center text-[#52525B] hover:bg-black/[0.05] shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs & Mode Filter */}
        <div className="shrink-0 px-5 py-2.5 bg-[#FAFAFC] border-b border-black/[0.06] flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex rounded-xl bg-black/[0.05] p-1">
            <button
              type="button"
              onClick={() => setTab('templates')}
              className={`px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-all ${
                tab === 'templates'
                  ? 'bg-white text-[#0B0B0F] shadow-xs'
                  : 'text-[#52525B] hover:text-[#0B0B0F]'
              }`}
            >
              Starter Templates
            </button>
            <button
              type="button"
              onClick={() => setTab('community')}
              className={`px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-all ${
                tab === 'community'
                  ? 'bg-white text-[#0B0B0F] shadow-xs'
                  : 'text-[#52525B] hover:text-[#0B0B0F]'
              }`}
            >
              Community Remix
            </button>
          </div>

          <div className="inline-flex items-center gap-1">
            {(['all', 'mobile', 'web'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setModeFilter(m)}
                className={`px-2.5 py-1 rounded-lg text-[11.5px] font-medium capitalize transition-colors ${
                  modeFilter === m
                    ? 'bg-[#0B0B0F] text-white'
                    : 'bg-white border border-black/[0.08] text-[#52525B] hover:text-[#0B0B0F]'
                }`}
              >
                {m === 'all' ? 'All' : m === 'mobile' ? 'Mobile' : 'Web'}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-y-auto p-5">
          {tab === 'templates' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {filteredTemplates.map((tpl) => (
                <div
                  key={tpl.id}
                  className="rounded-2xl border border-black/[0.08] bg-white p-4 flex flex-col justify-between gap-3 hover:border-black/20 transition-all"
                >
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-semibold"
                        style={{
                          backgroundColor: `${tpl.accentColor}16`,
                          color: tpl.accentColor,
                        }}
                      >
                        {tpl.mode === 'mobile' ? (
                          <Smartphone className="w-3 h-3" />
                        ) : (
                          <Globe className="w-3 h-3" />
                        )}
                        <span>{tpl.category}</span>
                      </span>
                      <span className="text-[11px] font-medium text-[#71717A] capitalize">
                        {tpl.mode}
                      </span>
                    </div>
                    <h3 className="font-display font-bold text-[15px] text-[#0B0B0F]">
                      {tpl.title}
                    </h3>
                    <p className="text-[12.5px] text-[#52525B] leading-relaxed">
                      {tpl.description}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        onUseTemplatePrompt(tpl, true);
                        onClose();
                      }}
                      className="flex-1 h-9 px-3 rounded-xl bg-[#0B0B0F] hover:bg-black/85 text-white text-[12.5px] font-semibold inline-flex items-center justify-center gap-1.5 active:scale-95 transition-all"
                    >
                      <span>Build Now</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onUseTemplatePrompt(tpl, false);
                        onClose();
                      }}
                      className="h-9 px-3 rounded-xl border border-black/[0.1] bg-white hover:bg-black/[0.03] text-[#0B0B0F] text-[12px] font-medium active:scale-95 transition-all"
                    >
                      Edit Prompt
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : loadingCommunity ? (
            <div className="py-12 flex flex-col items-center justify-center gap-2 text-[#71717A]">
              <Loader2 className="w-6 h-6 animate-spin text-[#6D4AFF]" />
              <p className="text-[13px]">Loading remixable apps…</p>
            </div>
          ) : galleryError ? (
            <div className="py-10 text-center text-[13px] text-red-600">{galleryError}</div>
          ) : filteredCommunity.length === 0 ? (
            <div className="py-10 px-4 rounded-2xl bg-[#FAFAFC] border border-black/[0.06] text-center flex flex-col items-center gap-2">
              <GitFork className="w-6 h-6 text-[#6D4AFF]" />
              <p className="font-display font-semibold text-[15px] text-[#0B0B0F]">
                No remixable apps published yet
              </p>
              <p className="text-[12.5px] text-[#71717A] max-w-[340px]">
                Build an app and turn on <strong>Allow Community Remix</strong> inside the Deploy panel to share it here.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {filteredCommunity.map((app) => (
                <div
                  key={app.appId}
                  className="rounded-2xl border border-black/[0.08] bg-white p-4 flex flex-col justify-between gap-3"
                >
                  <div className="flex items-start gap-3">
                    {app.logoUrl ? (
                      <img
                        src={app.logoUrl}
                        alt={`${app.title} icon`}
                        className="w-10 h-10 rounded-xl border border-black/10 object-cover shrink-0"
                      />
                    ) : (
                      <div
                        className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold shrink-0"
                        style={{ backgroundColor: app.themeColor || '#6D4AFF' }}
                      >
                        {app.title.slice(0, 1).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="font-display font-bold text-[14.5px] text-[#0B0B0F] truncate">
                          {app.seoTitle || app.title}
                        </h3>
                        <span className="text-[10.5px] font-mono text-[#71717A] shrink-0">
                          v{app.version}
                        </span>
                      </div>
                      <p className="text-[12px] text-[#52525B] line-clamp-2 mt-0.5">
                        {app.seoDescription}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={remixingId === app.appId}
                      onClick={() => void handleRemixClick(app.appId)}
                      className="flex-1 h-9 px-3 rounded-xl bg-[#6D4AFF] hover:bg-[#5B35F5] disabled:opacity-60 text-white text-[12.5px] font-semibold inline-flex items-center justify-center gap-1.5"
                    >
                      {remixingId === app.appId ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <GitFork className="w-3.5 h-3.5" />
                      )}
                      <span>Remix App</span>
                    </button>
                    <a
                      href={app.liveUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="h-9 px-3 rounded-xl border border-black/[0.1] bg-white hover:bg-black/[0.03] text-[#0B0B0F] text-[12px] font-medium inline-flex items-center gap-1"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>Open</span>
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
