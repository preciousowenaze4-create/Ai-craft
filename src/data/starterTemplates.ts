import { BuildMode } from '../types/craft';

export interface StarterTemplate {
  id: string;
  title: string;
  category: string;
  mode: BuildMode;
  description: string;
  accentColor: string;
  prompt: string;
}

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    id: 'tpl-saas-analytics',
    title: 'PulseMetrics SaaS',
    category: 'Dashboard',
    mode: 'web',
    accentColor: '#6D4AFF',
    description: 'Revenue MRR chart, cohort table, live activity feed, and billing settings.',
    prompt:
      'Build a polished SaaS analytics dashboard called PulseMetrics with KPI cards (MRR, Active Users, Churn, Net Retention), an interactive SVG revenue chart with timeframe filter, a searchable customer table backed by AICraft.db, and a clean sidebar.',
  },
  {
    id: 'tpl-habit-streaks',
    title: 'DayStreak Habits',
    category: 'Productivity',
    mode: 'mobile',
    accentColor: '#F59E0B',
    description: 'Daily habit check-ins, streak ring progress, weekly calendar, and reminders.',
    prompt:
      'Build a sleek iOS-style mobile habit tracker called DayStreak with daily check-in cards, animated streak counter, 7-day heatmap strip, add-habit modal, and persistent storage via AICraft.db.',
  },
  {
    id: 'tpl-creator-store',
    title: 'MonoDrop Storefront',
    category: 'E-Commerce',
    mode: 'web',
    accentColor: '#0B0B0F',
    description: 'Editorial product grid, category filters, slide-over cart drawer, and checkout.',
    prompt:
      'Build a modern minimalist digital & merch storefront called MonoDrop with hero drop banner, category filter pills, product cards with quick-add, slide-over shopping cart drawer with quantity controls, and persisted orders in AICraft.db.',
  },
  {
    id: 'tpl-food-delivery',
    title: 'CraveGo Delivery',
    category: 'Food & Local',
    mode: 'mobile',
    accentColor: '#EA580C',
    description: 'Restaurant feed, menu customization, live cart summary, and order status tracker.',
    prompt:
      'Build a mobile food ordering app called CraveGo with cuisine filters, restaurant cards with ratings & ETA, dish detail sheet with add-ons, live cart bar, and a simulated live order progress tracker.',
  },
  {
    id: 'tpl-booking-studio',
    title: 'Calendly Studio',
    category: 'Booking',
    mode: 'web',
    accentColor: '#059669',
    description: 'Service tiers, interactive date/time slot picker, and instant booking confirmation.',
    prompt:
      'Build a clean appointment & studio booking web app with selectable services, interactive monthly calendar and available time slots, guest intake form, and confirmed bookings list stored in AICraft.db.',
  },
  {
    id: 'tpl-arcade-runner',
    title: 'Neon Orbit Arcade',
    category: 'Game',
    mode: 'mobile',
    accentColor: '#EC4899',
    description: 'Touch-friendly 60fps HTML5 canvas game with combos, sound FX, and high scores.',
    prompt:
      'Build an addictive mobile-first 60fps HTML5 canvas arcade dodge-and-collect game called Neon Orbit with smooth touch/keyboard controls, Web Audio synth effects, combo multipliers, and a persistent high-score leaderboard in AICraft.db.',
  },
];
