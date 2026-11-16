import { Ban, RefreshCw } from 'lucide-react';

interface BannedOverlayProps {
  message?: string | null;
  onRetrySignIn: () => void;
}

export function BannedOverlay({ message, onRetrySignIn }: BannedOverlayProps) {
  return (
    <div className="fixed inset-0 z-[100] h-dvh w-full bg-white flex flex-col items-center justify-center px-6 text-center select-none">
      <div className="w-full max-w-[360px] rounded-[24px] border border-red-200/80 bg-[#FFFDFD] p-6 shadow-[0_20px_50px_rgba(185,28,28,0.10)] flex flex-col items-center">
        <span className="w-14 h-14 rounded-2xl bg-red-50 border border-red-200 text-red-600 flex items-center justify-center mb-4">
          <Ban className="w-7 h-7" />
        </span>

        <h1 className="font-display font-bold text-[21px] tracking-[-0.02em] text-[#0B0B0F]">
          Account Suspended
        </h1>

        <p className="mt-2 text-[14px] leading-relaxed text-[#52525B]">
          {message ||
            'Your account has been banned by the app owner and cannot access AI Craft right now.'}
        </p>

        <button
          type="button"
          onClick={onRetrySignIn}
          className="mt-6 w-full h-[46px] rounded-full bg-[#0B0B0F] hover:bg-black/85 active:scale-[0.98] text-white font-semibold text-[14px] inline-flex items-center justify-center gap-2 transition-all"
        >
          <RefreshCw className="w-4 h-4" />
          <span>Back to Sign In</span>
        </button>
      </div>
    </div>
  );
}
