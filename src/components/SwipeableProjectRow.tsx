import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Loader2, Pencil, Trash2, X } from 'lucide-react';
import { CraftProject, MODE_THEMES } from '../types/craft';

interface SwipeableProjectRowProps {
  project: CraftProject;
  isWorking: boolean;
  isSwipedOpen: boolean;
  onSwipeOpenChange: (projectId: string, open: boolean) => void;
  onOpen: (project: CraftProject) => void;
  onRename: (projectId: string, nextTitle: string) => void;
  onDelete: (projectId: string) => void;
}

const ACTION_REVEAL_WIDTH = 108;
const SWIPE_SNAP_THRESHOLD = 42;

export function SwipeableProjectRow({
  project,
  isWorking,
  isSwipedOpen,
  onSwipeOpenChange,
  onOpen,
  onRename,
  onDelete,
}: SwipeableProjectRowProps) {
  const [dragOffset, setDragOffset] = useState<number>(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(project.title);
  const editInputRef = useRef<HTMLInputElement | null>(null);

  const gestureRef = useRef<{
    active: boolean;
    pointerId: number | null;
    startX: number;
    startY: number;
    baseOffset: number;
    axisLocked: 'x' | 'y' | null;
    movedHorizontally: boolean;
  }>({
    active: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    baseOffset: 0,
    axisLocked: null,
    movedHorizontally: false,
  });

  const suppressNextClickRef = useRef(false);

  useEffect(() => {
    if (!isDragging) {
      setDragOffset(isSwipedOpen ? -ACTION_REVEAL_WIDTH : 0);
    }
  }, [isSwipedOpen, isDragging]);

  useEffect(() => {
    setDraftTitle(project.title);
  }, [project.title]);

  useEffect(() => {
    if (isEditing) {
      const id = window.setTimeout(() => {
        editInputRef.current?.focus();
        editInputRef.current?.select();
      }, 20);
      return () => window.clearTimeout(id);
    }
  }, [isEditing]);

  const firstTurn = project.turns[0];
  const latestTurn = project.turns[project.turns.length - 1];
  const hasAppBuilt = project.turns.some((t) => Boolean(t.previewHtml));

  const commitRename = () => {
    const cleaned = draftTitle.trim();
    if (cleaned && cleaned !== project.title) {
      onRename(project.id, cleaned);
    } else {
      setDraftTitle(project.title);
    }
    setIsEditing(false);
  };

  const cancelRename = () => {
    setDraftTitle(project.title);
    setIsEditing(false);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isEditing) return;
    // Only track primary mouse button or touch/pen
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    gestureRef.current = {
      active: true,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseOffset: isSwipedOpen ? -ACTION_REVEAL_WIDTH : 0,
      axisLocked: null,
      movedHorizontally: false,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g.active || g.pointerId !== e.pointerId || isEditing) return;

    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;

    if (!g.axisLocked) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        g.axisLocked = 'y';
        g.active = false;
        return;
      }
      g.axisLocked = 'x';
      g.movedHorizontally = true;
      setIsDragging(true);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // ignore pointer capture error
      }
    }

    if (g.axisLocked === 'x') {
      const next = Math.max(-ACTION_REVEAL_WIDTH - 12, Math.min(0, g.baseOffset + dx));
      setDragOffset(next);
    }
  };

  const finishGesture = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g.active || g.pointerId !== e.pointerId) return;

    const wasHorizontal = g.movedHorizontally;
    g.active = false;
    g.pointerId = null;

    if (wasHorizontal) {
      suppressNextClickRef.current = true;
      window.setTimeout(() => {
        suppressNextClickRef.current = false;
      }, 120);

      const shouldOpen = dragOffset <= -SWIPE_SNAP_THRESHOLD;
      setIsDragging(false);
      setDragOffset(shouldOpen ? -ACTION_REVEAL_WIDTH : 0);
      onSwipeOpenChange(project.id, shouldOpen);
    } else {
      setIsDragging(false);
    }
  };

  const handleCardClick = () => {
    if (isEditing) return;
    if (suppressNextClickRef.current) return;
    if (isSwipedOpen) {
      onSwipeOpenChange(project.id, false);
      return;
    }
    onOpen(project);
  };

  const revealVisible = isSwipedOpen || dragOffset < -6;

  return (
    <li className="relative overflow-hidden rounded-2xl">
      {/* Swipe-left action tray (hidden behind card until swiped left) */}
      <div
        aria-hidden={!isSwipedOpen}
        className={`absolute inset-y-0 right-0 flex items-center justify-end gap-2 pr-1.5 transition-opacity duration-150 ${
          revealVisible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        style={{ width: `${ACTION_REVEAL_WIDTH}px` }}
      >
        <button
          type="button"
          tabIndex={isSwipedOpen ? 0 : -1}
          aria-label={`Rename ${project.title}`}
          onClick={(e) => {
            e.stopPropagation();
            onSwipeOpenChange(project.id, false);
            setIsEditing(true);
          }}
          className="w-11 h-11 rounded-xl border border-black/[0.08] bg-[#F4F4F6] text-[#111118] hover:bg-[#E4E4E7] active:scale-95 transition-all flex items-center justify-center shrink-0"
        >
          <Pencil className="w-4 h-4" />
        </button>

        <button
          type="button"
          tabIndex={isSwipedOpen ? 0 : -1}
          aria-label={`Delete ${project.title}`}
          onClick={(e) => {
            e.stopPropagation();
            onSwipeOpenChange(project.id, false);
            onDelete(project.id);
          }}
          className="w-11 h-11 rounded-xl bg-[#EF4444] text-white hover:bg-[#DC2626] active:scale-95 transition-all flex items-center justify-center shrink-0 shadow-[0_3px_10px_rgba(239,68,68,0.25)]"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {/* Foreground Project Card (clean & unchanged when not swiped) */}
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishGesture}
        onPointerCancel={finishGesture}
        style={{
          transform: `translate3d(${dragOffset}px, 0, 0)`,
          transition: isDragging
            ? 'none'
            : 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)',
          touchAction: 'pan-y',
        }}
        className="relative z-10 w-full rounded-2xl border border-black/[0.08] bg-white shadow-[0_4px_16px_rgba(15,15,30,0.03)] select-none"
      >
        {isEditing ? (
          <div className="p-3.5 flex items-center gap-2">
            <input
              ref={editInputRef}
              type="text"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitRename();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelRename();
                }
              }}
              maxLength={60}
              aria-label="Edit app name"
              className="flex-1 min-w-0 h-10 px-3 rounded-xl border border-black/15 bg-[#FAFAFC] text-sm font-semibold text-[#0B0B0F] focus:outline-none focus:ring-2 focus:ring-[#7A68F6]"
            />
            <button
              type="button"
              onClick={commitRename}
              aria-label="Save name"
              className="w-10 h-10 rounded-xl bg-[#0B0B0F] text-white hover:bg-black/85 active:scale-95 transition-all flex items-center justify-center shrink-0"
            >
              <Check className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={cancelRename}
              aria-label="Cancel rename"
              className="w-10 h-10 rounded-xl border border-black/10 bg-white text-[#52525B] hover:text-[#0B0B0F] active:scale-95 transition-all flex items-center justify-center shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleCardClick}
            className="w-full text-left p-4 rounded-2xl hover:bg-black/[0.015] active:scale-[0.99] transition-all flex items-center justify-between gap-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-xs text-[#71717A] flex-wrap">
                <span className="font-semibold text-[#0B0B0F]">{project.title}</span>
                <span aria-hidden="true">·</span>
                <span>{MODE_THEMES[project.mode].label}</span>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">{project.createdAt}</span>
                {isWorking ? (
                  <span
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium"
                    style={{
                      backgroundColor: MODE_THEMES[project.mode].accentSoft,
                      color: MODE_THEMES[project.mode].accentColor,
                    }}
                  >
                    <Loader2 className="w-3 h-3 animate-spin" />
                    <span>
                      {latestTurn?.phase === 'building' ? 'Building' : 'Thinking'}
                    </span>
                  </span>
                ) : latestTurn?.phase === 'paused' ? (
                  <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[11px] font-medium">
                    Paused
                  </span>
                ) : hasAppBuilt ? (
                  <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-medium">
                    Ready
                  </span>
                ) : null}
              </div>
              {firstTurn && (
                <p className="mt-1.5 text-sm text-[#27272F] truncate">
                  {firstTurn.userMessage}
                </p>
              )}
            </div>
            <ChevronRight className="w-4 h-4 text-[#71717A] shrink-0" />
          </button>
        )}
      </div>
    </li>
  );
}
