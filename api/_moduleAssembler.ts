import {
  type ActiveModuleManifest,
  type ComponentIdentifier,
  type CustomTabSpec,
  type DataTableSpec,
  type FeatureIdentifier,
  type GeminiRouteResult,
  type SeedItemSpec,
  extractModuleManifestFromHtml,
} from './_geminiRouter.js';
import {
  type ParsedDbTable,
  type SearchImageItem,
  type SearchResultItem,
  sanitizeAndHardenPreviewHtml,
} from './_builderCore.js';

export interface AssembledModuleStep {
  path: string;
  action: string;
  label: string;
}

export interface AssembledAppOutput {
  html: string;
  manifest: ActiveModuleManifest;
  steps: AssembledModuleStep[];
  dbTables: ParsedDbTable[];
  logoDirective: Record<string, string>;
}

const COMPONENT_STEP_LABELS: Record<ComponentIdentifier, string> = {
  nav_top_header: 'Top Header & Brand Bar',
  nav_bottom_tab_bar: 'Adaptive Bottom Navigation',
  nav_side_drawer: 'Responsive Side Drawer',
  search_filter_bar: 'Live Search & Category Filters',
  hero_showcase_banner: 'Featured Showcase Hero',
  vertical_video_feed: 'Vertical Short-Video Feed',
  social_post_feed: 'Social Community Feed',
  kpi_analytics_grid: 'KPI Metrics & Trend Chart',
  catalog_items_grid: 'Interactive Listings Grid',
  booking_schedule_panel: 'Booking & Schedule Manager',
  realtime_chat_inbox: 'Real-Time Chat & Inbox',
  composer_upload_modal: 'Create & Publish Composer',
  shopping_cart_checkout: 'Cart & Checkout Pipeline',
  wallet_transactions_panel: 'Wallet & Ledger Panel',
  user_profile_account: 'User Profile & Saved Items',
  monetization_upgrade_modal: 'Pro Upgrade & Billing Modal',
  settings_preferences_panel: 'App Settings & Theme Controls',
  notifications_activity_feed: 'Activity Notifications Feed',
  admin_management_table: 'Admin Operations Table',
};

function escapeHtml(input: string): string {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mergeManifestForRoute(params: {
  route: GeminiRouteResult;
  previousHtml?: string;
}): ActiveModuleManifest {
  const { route, previousHtml } = params;
  const prev = extractModuleManifestFromHtml(previousHtml);

  let componentIds: ComponentIdentifier[] = [];
  if (route.intent === 'edit_app' && prev) {
    const removeSet = new Set(route.removeComponentIds);
    componentIds = prev.componentIds.filter((id) => !removeSet.has(id));
    for (const added of [...route.addComponentIds, ...route.componentIds]) {
      if (!removeSet.has(added) && !componentIds.includes(added)) {
        componentIds.push(added);
      }
    }
  } else {
    componentIds = [...route.componentIds];
  }

  if (componentIds.length === 0) {
    componentIds = ['nav_top_header', 'catalog_items_grid', 'nav_bottom_tab_bar'];
  }

  const featureSet = new Set<FeatureIdentifier>(route.featureIds);
  if (prev && route.intent === 'edit_app') {
    for (const f of prev.featureIds) featureSet.add(f);
  }
  featureSet.add('db_realtime_sync');

  const dataTables: DataTableSpec[] =
    route.dataTables.length > 0
      ? route.dataTables
      : prev?.dataTables.length
        ? prev.dataTables
        : [
            {
              name: 'items',
              columns: [
                { name: 'title', type: 'text' },
                { name: 'subtitle', type: 'text' },
                { name: 'category', type: 'text' },
                { name: 'likes', type: 'number' },
                { name: 'saved', type: 'boolean' },
              ],
            },
            {
              name: 'comments',
              columns: [
                { name: 'item_id', type: 'text' },
                { name: 'author', type: 'text' },
                { name: 'text', type: 'text' },
                { name: 'created_at', type: 'timestamp' },
              ],
            },
          ];

  const seedItems: SeedItemSpec[] =
    route.seedItems.length > 0
      ? route.seedItems
      : prev?.seedItems.length
        ? prev.seedItems
        : [
            {
              title: `${route.appTitle} Highlight`,
              subtitle: route.brandTagline,
              category: 'Featured',
              metric: 'Live',
              badge: 'Active',
            },
            {
              title: 'Quick Start Workspace',
              subtitle: 'Tap + to add new entries saved directly to real-time storage.',
              category: 'Workspace',
              metric: '100%',
              badge: 'Synced',
            },
          ];

  const primaryContentModule: ComponentIdentifier =
    componentIds.find((id) =>
      [
        'vertical_video_feed',
        'social_post_feed',
        'catalog_items_grid',
        'kpi_analytics_grid',
        'realtime_chat_inbox',
        'booking_schedule_panel',
        'wallet_transactions_panel',
        'admin_management_table',
      ].includes(id)
    ) || 'catalog_items_grid';

  const defaultTabs: CustomTabSpec[] = [];
  defaultTabs.push({ id: 'home', label: 'Home', componentId: primaryContentModule });
  if (componentIds.includes('search_filter_bar')) {
    defaultTabs.push({ id: 'explore', label: 'Explore', componentId: 'search_filter_bar' });
  }
  if (componentIds.includes('realtime_chat_inbox') && primaryContentModule !== 'realtime_chat_inbox') {
    defaultTabs.push({ id: 'chat', label: 'Inbox', componentId: 'realtime_chat_inbox' });
  }
  if (componentIds.includes('kpi_analytics_grid') && primaryContentModule !== 'kpi_analytics_grid') {
    defaultTabs.push({ id: 'metrics', label: 'Stats', componentId: 'kpi_analytics_grid' });
  }
  if (componentIds.includes('booking_schedule_panel') && primaryContentModule !== 'booking_schedule_panel') {
    defaultTabs.push({ id: 'bookings', label: 'Book', componentId: 'booking_schedule_panel' });
  }
  if (componentIds.includes('wallet_transactions_panel') && primaryContentModule !== 'wallet_transactions_panel') {
    defaultTabs.push({ id: 'wallet', label: 'Wallet', componentId: 'wallet_transactions_panel' });
  }
  if (componentIds.includes('user_profile_account')) {
    defaultTabs.push({ id: 'profile', label: 'Profile', componentId: 'user_profile_account' });
  } else if (componentIds.includes('settings_preferences_panel')) {
    defaultTabs.push({ id: 'settings', label: 'Settings', componentId: 'settings_preferences_panel' });
  }

  const removeSet = new Set(route.removeComponentIds);
  const customTabs =
    route.customTabs.length > 0
      ? route.customTabs.filter((t) => !removeSet.has(t.componentId))
      : defaultTabs.slice(0, 5);

  return {
    appTitle: route.appTitle,
    brandTagline: route.brandTagline,
    primaryColor: route.primaryColor,
    surfaceTheme: route.surfaceTheme,
    componentIds,
    featureIds: Array.from(featureSet),
    customTabs: customTabs.length > 0 ? customTabs : defaultTabs.slice(0, 4),
    seedItems,
    dataTables,
  };
}

export function assembleModularInterface(params: {
  route: GeminiRouteResult;
  previousHtml?: string;
  mode: 'mobile' | 'web';
  searchData?: {
    results: SearchResultItem[];
    images: SearchImageItem[];
  };
}): AssembledAppOutput {
  const manifest = mergeManifestForRoute({
    route: params.route,
    previousHtml: params.previousHtml,
  });

  const images = (params.searchData?.images ?? [])
    .map((i) => i.imageUrl)
    .filter((u) => /^https:\/\//i.test(u));

  const dark = manifest.surfaceTheme === 'dark';
  const warm = manifest.surfaceTheme === 'warm';
  const vibrant = manifest.surfaceTheme === 'vibrant';
  const accent = manifest.primaryColor || '#0D5BFF';

  const bg = dark ? '#0B0B10' : warm ? '#FFFBF2' : vibrant ? '#F7F5FF' : '#F8FAFC';
  const card = dark ? '#16161F' : '#FFFFFF';
  const fg = dark ? '#F4F4F5' : '#0F172A';
  const muted = dark ? '#A1A1AA' : '#64748B';
  const border = dark ? 'rgba(255,255,255,0.1)' : 'rgba(15,23,42,0.09)';

  const encodedManifest = encodeURIComponent(JSON.stringify(manifest));
  const safeAppStateJson = JSON.stringify({
    manifest,
    images,
  }).replace(/</g, '\\u003c');

  const hasComponent = (id: ComponentIdentifier) => manifest.componentIds.includes(id);

  const steps: AssembledModuleStep[] = [
    { path: 'database/schema.js', action: 'Provisioning', label: 'Real-time database' },
    ...manifest.componentIds.map((id) => ({
      path: `components/${id}.js`,
      action: 'Assembling',
      label: COMPONENT_STEP_LABELS[id] || id,
    })),
    { path: 'app.js', action: 'Wiring', label: 'Interactive runtime & DB sync' },
    { path: 'styles.css', action: 'Styling', label: 'Responsive Android, Desktop & TV shell' },
    { path: 'index.html', action: 'Finalizing', label: 'Complete modular interface' },
  ];

  const dbTables: ParsedDbTable[] = manifest.dataTables.map((t) => ({
    name: t.name,
    columns: t.columns.map((c) => ({ name: c.name, type: c.type })),
  }));

  const rawHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta name="aicraft-modules" content="${encodedManifest}" />
  <title>${escapeHtml(manifest.appTitle)}</title>
  <script>
    (function(){
      var ua = navigator.userAgent || '';
      document.documentElement.dataset.platform = /Android/i.test(ua)
        ? 'android'
        : /iPhone|iPad|iPod/i.test(ua)
          ? 'ios'
          : 'desktop';
    })();
  </script>
  <style>
    :root {
      --bg: ${bg};
      --card: ${card};
      --fg: ${fg};
      --muted: ${muted};
      --border: ${border};
      --accent: ${accent};
    }
    html.theme-dark {
      --bg: #0B0B10;
      --card: #16161F;
      --fg: #F4F4F5;
      --muted: #A1A1AA;
      --border: rgba(255,255,255,0.1);
    }
    html.theme-light {
      --bg: #F8FAFC;
      --card: #FFFFFF;
      --fg: #0F172A;
      --muted: #64748B;
      --border: rgba(15,23,42,0.09);
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      min-height: 100dvh;
      background: var(--bg);
      color: var(--fg);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .app-shell {
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      max-width: 1120px;
      margin: 0 auto;
    }
    .top-bar {
      position: sticky;
      top: 0;
      z-index: 30;
      background: var(--card);
      border-bottom: 1px solid var(--border);
      padding: max(12px, env(safe-area-inset-top)) 16px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .brand-row {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .brand-mark {
      width: 34px;
      height: 34px;
      border-radius: 10px;
      background: var(--accent);
      color: #fff;
      font-weight: 800;
      display: grid;
      place-items: center;
      flex-shrink: 0;
    }
    .brand-title {
      font-weight: 700;
      font-size: 16px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .brand-sub {
      font-size: 11.5px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .top-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .btn {
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--fg);
      border-radius: 10px;
      padding: 8px 12px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    .main-area {
      flex: 1;
      padding: 16px;
      padding-bottom: 92px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 14px;
    }
    .hero {
      border-radius: 18px;
      padding: 18px;
      color: #fff;
      background: linear-gradient(135deg, var(--accent), #1E1B4B);
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .search-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .input {
      width: 100%;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--fg);
      border-radius: 12px;
      padding: 10px 12px;
      font-size: 14px;
      outline: none;
    }
    .chips { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 2px; }
    .chip {
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--muted);
      border-radius: 999px;
      padding: 6px 12px;
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
    }
    .chip.active {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(1, minmax(0, 1fr));
      gap: 12px;
    }
    @media (min-width: 640px) {
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (min-width: 1024px) {
      .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    @media (min-width: 768px) {
      .kpi-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    }
    .item-img {
      width: 100%;
      aspect-ratio: 16 / 10;
      object-fit: cover;
      border-radius: 12px;
      margin-bottom: 10px;
      background: rgba(127,127,127,0.12);
    }
    .reel-card {
      position: relative;
      border-radius: 18px;
      overflow: hidden;
      min-height: 360px;
      background: linear-gradient(160deg, #111827, var(--accent));
      color: #fff;
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      padding: 18px;
    }
    .reel-bg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      opacity: 0.55;
    }
    .reel-overlay {
      position: relative;
      z-index: 2;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 12px;
    }
    .reel-actions {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .bottom-nav {
      position: fixed;
      left: 50%;
      transform: translateX(-50%);
      bottom: 0;
      width: 100%;
      max-width: 1120px;
      background: var(--card);
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: space-around;
      padding: 8px 6px max(10px, env(safe-area-inset-bottom));
      z-index: 40;
    }
    html[data-platform="android"] .bottom-nav {
      padding-bottom: max(18px, calc(env(safe-area-inset-bottom, 0px) + 14px));
    }
    .nav-btn {
      border: 0;
      background: transparent;
      color: var(--muted);
      font-size: 11.5px;
      font-weight: 600;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      padding: 4px 10px;
      cursor: pointer;
    }
    .nav-btn.active { color: var(--accent); }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.55);
      display: none;
      align-items: flex-end;
      justify-content: center;
      z-index: 60;
      padding: 12px;
    }
    .modal-backdrop.open { display: flex; }
    .modal-card {
      width: 100%;
      max-width: 520px;
      background: var(--card);
      color: var(--fg);
      border-radius: 18px;
      padding: 18px;
      border: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-height: 85dvh;
      overflow-y: auto;
    }
    .badge {
      display: inline-block;
      font-size: 11px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 999px;
      background: rgba(13,91,255,0.12);
      color: var(--accent);
    }
    .toast {
      position: fixed;
      top: 68px;
      left: 50%;
      transform: translateX(-50%);
      background: #0F172A;
      color: #fff;
      padding: 8px 14px;
      border-radius: 999px;
      font-size: 12.5px;
      font-weight: 600;
      z-index: 80;
      display: none;
    }
    @media (min-width: 1920px) {
      html { font-size: 18px; }
    }
  </style>
</head>
<body>
  <div class="app-shell">
    ${
      hasComponent('nav_top_header')
        ? `<header class="top-bar">
      <div class="brand-row">
        <div class="brand-mark">${escapeHtml((manifest.appTitle || 'A').slice(0, 1).toUpperCase())}</div>
        <div style="min-width:0">
          <div class="brand-title">${escapeHtml(manifest.appTitle)}</div>
          <div class="brand-sub">${escapeHtml(manifest.brandTagline)}</div>
        </div>
      </div>
      <div class="top-actions">
        ${
          hasComponent('composer_upload_modal')
            ? `<button class="btn btn-primary" id="btn-open-compose" type="button">+ Create</button>`
            : ''
        }
        ${
          hasComponent('shopping_cart_checkout')
            ? `<button class="btn" id="btn-open-cart" type="button">Cart (<span id="cart-count">0</span>)</button>`
            : ''
        }
        ${
          hasComponent('monetization_upgrade_modal')
            ? `<button class="btn" id="btn-open-upgrade" type="button">Pro</button>`
            : ''
        }
      </div>
    </header>`
        : ''
    }

    <main class="main-area" id="main-area"></main>

    ${
      hasComponent('nav_bottom_tab_bar')
        ? `<nav class="bottom-nav" data-bottom-nav="true" id="bottom-nav"></nav>`
        : ''
    }
  </div>

  <div class="toast" id="app-toast"></div>

  <div class="modal-backdrop" id="compose-modal">
    <div class="modal-card">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <strong style="font-size:16px;">Create New Entry</strong>
        <button class="btn" id="btn-close-compose" type="button">Close</button>
      </div>
      <input class="input" id="compose-title" placeholder="Title or headline..." />
      <input class="input" id="compose-category" placeholder="Category (e.g. Featured, Music, Design)..." />
      <input class="input" id="compose-subtitle" placeholder="Details or description..." />
      <button class="btn btn-primary" id="btn-submit-compose" type="button">Publish Live</button>
    </div>
  </div>

  <div class="modal-backdrop" id="comments-modal">
    <div class="modal-card">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <strong style="font-size:16px;">Comments</strong>
        <button class="btn" id="btn-close-comments" type="button">Close</button>
      </div>
      <div id="comments-list" style="display:flex;flex-direction:column;gap:8px;"></div>
      <div style="display:flex;gap:8px;">
        <input class="input" id="comment-input" placeholder="Write a comment..." />
        <button class="btn btn-primary" id="btn-submit-comment" type="button">Send</button>
      </div>
    </div>
  </div>

  <div class="modal-backdrop" id="cart-modal">
    <div class="modal-card">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <strong style="font-size:16px;">Cart & Checkout</strong>
        <button class="btn" id="btn-close-cart" type="button">Close</button>
      </div>
      <div id="cart-items" style="display:flex;flex-direction:column;gap:8px;"></div>
      <button class="btn btn-primary" id="btn-place-order" type="button">Place Order</button>
    </div>
  </div>

  <div class="modal-backdrop" id="upgrade-modal">
    <div class="modal-card">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <strong style="font-size:16px;">${escapeHtml(manifest.appTitle)} Pro</strong>
        <button class="btn" id="btn-close-upgrade" type="button">Close</button>
      </div>
      <p style="margin:0;color:var(--muted);font-size:13.5px;">Unlock unlimited creation, analytics export, and priority cloud sync.</p>
      <button class="btn btn-primary" id="btn-activate-pro" type="button">Activate Pro Plan</button>
    </div>
  </div>

  <script>
    (function(){
      var BOOT = ${safeAppStateJson};
      var manifest = BOOT.manifest;
      var images = BOOT.images || [];
      var hasComp = function(id){ return manifest.componentIds.indexOf(id) !== -1; };
      var db = window.AICraft && window.AICraft.db;
      var primaryTable = (manifest.dataTables[0] && manifest.dataTables[0].name) || 'items';

      function readRows(tbl) {
        try {
          var raw = localStorage.getItem('aicraft_mod_' + tbl);
          var parsed = raw ? JSON.parse(raw) : [];
          return Array.isArray(parsed) ? parsed : [];
        } catch(e){ return []; }
      }
      function writeRows(tbl, rows) {
        var list = Array.isArray(rows) ? rows : [];
        try { localStorage.setItem('aicraft_mod_' + tbl, JSON.stringify(list)); } catch(e){}
        if (db && typeof db.list === 'function' && typeof db.insert === 'function') {
          try {
            db.list(tbl).then(function(existing){
              if ((!existing || existing.length === 0) && list.length > 0) {
                for (var i = list.length - 1; i >= 0; i -= 1) {
                  db.insert(tbl, list[i]);
                }
              }
            }).catch(function(){});
          } catch(e){}
        }
      }
      function showToast(msg) {
        var el = document.getElementById('app-toast');
        if (!el) return;
        el.textContent = msg;
        el.style.display = 'block';
        clearTimeout(window.__toastTimer);
        window.__toastTimer = setTimeout(function(){ el.style.display = 'none'; }, 2200);
      }
      function esc(s) {
        return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      }

      if (readRows(primaryTable).length === 0) {
        var seeded = (manifest.seedItems || []).map(function(item, idx){
          return {
            id: item.id || ('row_' + (idx + 1)),
            title: item.title,
            subtitle: item.subtitle,
            category: item.category || 'Featured',
            metric: item.metric || '',
            badge: item.badge || '',
            price: item.price || '$19',
            imageUrl: images[idx % Math.max(1, images.length)] || '',
            likes: (idx + 1) * 14,
            saved: false
          };
        });
        writeRows(primaryTable, seeded);
      }

      if (readRows('messages').length === 0 && hasComp('realtime_chat_inbox')) {
        writeRows('messages', [
          { id: 'm1', author: 'Team', text: 'Welcome to ' + manifest.appTitle + '! Everything syncs live.', createdAt: 'Just now' }
        ]);
      }

      if (readRows('bookings').length === 0 && hasComp('booking_schedule_panel')) {
        writeRows('bookings', [
          { id: 'b1', service: manifest.appTitle + ' Session', slot: 'Tomorrow · 10:00 AM', status: 'Confirmed' }
        ]);
      }

      var state = {
        activeTab: (manifest.customTabs[0] && manifest.customTabs[0].id) || 'home',
        search: '',
        category: 'All',
        activeCommentItemId: null,
        cart: readRows('cart'),
        theme: localStorage.getItem('aicraft_theme_pref') || ''
      };
      if (state.theme === 'dark') document.documentElement.classList.add('theme-dark');
      if (state.theme === 'light') document.documentElement.classList.add('theme-light');

      function updateCartCount() {
        var cc = document.getElementById('cart-count');
        if (cc) cc.textContent = String(state.cart.length);
      }

      function renderNav() {
        var nav = document.getElementById('bottom-nav');
        if (!nav) return;
        var tabs = manifest.customTabs || [];
        nav.innerHTML = tabs.map(function(t){
          var active = state.activeTab === t.id;
          return '<button class="nav-btn' + (active ? ' active' : '') + '" data-tab="' + esc(t.id) + '" type="button"><span>●</span><span>' + esc(t.label) + '</span></button>';
        }).join('');
        var btns = nav.querySelectorAll('[data-tab]');
        for (var i = 0; i < btns.length; i += 1) {
          btns[i].addEventListener('click', function(){
            state.activeTab = this.getAttribute('data-tab');
            renderApp();
          });
        }
      }

      function renderApp() {
        updateCartCount();
        renderNav();
        var main = document.getElementById('main-area');
        if (!main) return;
        var rows = readRows(primaryTable);
        var currentTabSpec = (manifest.customTabs || []).find(function(t){ return t.id === state.activeTab; });
        var targetComp = currentTabSpec ? currentTabSpec.componentId : null;

        var categories = ['All'];
        rows.forEach(function(r){
          if (r.category && categories.indexOf(r.category) === -1) categories.push(r.category);
        });

        var filtered = rows.filter(function(r){
          var matchCat = state.category === 'All' || r.category === state.category;
          var q = state.search.trim().toLowerCase();
          var matchQ = !q || (String(r.title || '') + ' ' + String(r.subtitle || '') + ' ' + String(r.category || '')).toLowerCase().indexOf(q) !== -1;
          return matchCat && matchQ;
        });

        var htmlParts = [];

        if (hasComp('hero_showcase_banner') && (!targetComp || targetComp === (manifest.customTabs[0] && manifest.customTabs[0].componentId))) {
          htmlParts.push(
            '<section class="hero">' +
              '<div style="font-size:12px;opacity:0.85;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;">' + esc(manifest.appTitle) + '</div>' +
              '<div style="font-size:21px;font-weight:800;line-height:1.2;">' + esc(manifest.brandTagline) + '</div>' +
              '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;">' +
                (hasComp('composer_upload_modal') ? '<button class="btn" id="hero-compose-btn" type="button">+ Add New</button>' : '') +
                '<span class="badge" style="background:rgba(255,255,255,0.2);color:#fff;">' + rows.length + ' Live Records</span>' +
              '</div>' +
            '</section>'
          );
        }

        if (hasComp('search_filter_bar') || targetComp === 'search_filter_bar') {
          htmlParts.push(
            '<section class="card">' +
              '<div class="search-row">' +
                '<input class="input" id="search-input" value="' + esc(state.search) + '" placeholder="Search ' + esc(manifest.appTitle) + '..." />' +
              '</div>' +
              '<div class="chips" style="margin-top:10px;">' +
                categories.map(function(cat){
                  return '<button class="chip' + (state.category === cat ? ' active' : '') + '" data-cat="' + esc(cat) + '" type="button">' + esc(cat) + '</button>';
                }).join('') +
              '</div>' +
            '</section>'
          );
        }

        if (targetComp === 'kpi_analytics_grid' || (hasComp('kpi_analytics_grid') && state.activeTab === (manifest.customTabs[0] && manifest.customTabs[0].id))) {
          var totalLikes = rows.reduce(function(acc, r){ return acc + (Number(r.likes) || 0); }, 0);
          var savedCount = rows.filter(function(r){ return Boolean(r.saved); }).length;
          htmlParts.push(
            '<section class="kpi-grid">' +
              '<div class="card"><div style="font-size:12px;color:var(--muted);">Total Entries</div><div style="font-size:22px;font-weight:800;margin-top:4px;">' + rows.length + '</div></div>' +
              '<div class="card"><div style="font-size:12px;color:var(--muted);">Interactions</div><div style="font-size:22px;font-weight:800;margin-top:4px;">' + totalLikes + '</div></div>' +
              '<div class="card"><div style="font-size:12px;color:var(--muted);">Saved Items</div><div style="font-size:22px;font-weight:800;margin-top:4px;">' + savedCount + '</div></div>' +
              '<div class="card"><div style="font-size:12px;color:var(--muted);">Active Modules</div><div style="font-size:22px;font-weight:800;margin-top:4px;">' + manifest.componentIds.length + '</div></div>' +
            '</section>'
          );
        }

        if (targetComp === 'realtime_chat_inbox' || (hasComp('realtime_chat_inbox') && state.activeTab === 'chat')) {
          var msgs = readRows('messages');
          htmlParts.push(
            '<section class="card" style="display:flex;flex-direction:column;gap:10px;">' +
              '<strong>Messages</strong>' +
              msgs.map(function(m){
                return '<div style="padding:10px;border-radius:12px;background:var(--bg);border:1px solid var(--border);"><div style="font-size:12px;font-weight:700;">' + esc(m.author) + ' · <span style="color:var(--muted);font-weight:400;">' + esc(m.createdAt) + '</span></div><div style="margin-top:4px;font-size:14px;">' + esc(m.text) + '</div></div>';
              }).join('') +
              '<div style="display:flex;gap:8px;"><input class="input" id="chat-msg-input" placeholder="Send a message..." /><button class="btn btn-primary" id="btn-send-chat" type="button">Send</button></div>' +
            '</section>'
          );
        } else if (targetComp === 'wallet_transactions_panel' || (hasComp('wallet_transactions_panel') && state.activeTab === 'wallet')) {
          var txns = readRows('transactions');
          if (txns.length === 0) {
            txns = [{ id: 'tx_1', label: 'Opening Balance', amount: 1250, type: 'credit', date: 'Today' }];
            writeRows('transactions', txns);
          }
          var balance = txns.reduce(function(sum, t){ return sum + (t.type === 'debit' ? -Number(t.amount || 0) : Number(t.amount || 0)); }, 0);
          htmlParts.push(
            '<section class="card" style="display:flex;flex-direction:column;gap:12px;">' +
              '<div style="display:flex;justify-content:space-between;align-items:center;"><div><div style="font-size:12px;color:var(--muted);">Available Balance</div><div style="font-size:26px;font-weight:800;">$' + balance.toLocaleString() + '</div></div><button class="btn btn-primary" id="btn-wallet-topup" type="button">+ Top Up $100</button></div>' +
              txns.map(function(tx){
                return '<div style="padding:10px;border:1px solid var(--border);border-radius:12px;display:flex;justify-content:space-between;align-items:center;"><div><strong>' + esc(tx.label) + '</strong><div style="font-size:12px;color:var(--muted);">' + esc(tx.date) + '</div></div><strong style="color:' + (tx.type === 'debit' ? '#EF4444' : '#10B981') + ';">' + (tx.type === 'debit' ? '-' : '+') + '$' + Number(tx.amount || 0).toLocaleString() + '</strong></div>';
              }).join('') +
            '</section>'
          );
        } else if (targetComp === 'notifications_activity_feed' || (hasComp('notifications_activity_feed') && state.activeTab === 'alerts')) {
          var alerts = readRows('notifications');
          if (alerts.length === 0) {
            alerts = [
              { id: 'n_1', text: manifest.appTitle + ' workspace initialized and synced.', read: false, time: 'Just now' }
            ];
            writeRows('notifications', alerts);
          }
          htmlParts.push(
            '<section class="card" style="display:flex;flex-direction:column;gap:10px;">' +
              '<strong>Notifications</strong>' +
              alerts.map(function(a){
                return '<div style="padding:10px;border:1px solid var(--border);border-radius:12px;display:flex;justify-content:space-between;align-items:center;gap:8px;"><div><div style="font-size:13.5px;">' + esc(a.text) + '</div><div style="font-size:11.5px;color:var(--muted);">' + esc(a.time) + '</div></div><span class="badge">' + (a.read ? 'Read' : 'New') + '</span></div>';
              }).join('') +
            '</section>'
          );
        } else if (targetComp === 'admin_management_table' || (hasComp('admin_management_table') && state.activeTab === 'admin')) {
          htmlParts.push(
            '<section class="card" style="display:flex;flex-direction:column;gap:10px;overflow-x:auto;">' +
              '<div style="display:flex;justify-content:space-between;align-items:center;"><strong>Operations Table</strong><button class="btn" id="btn-export-csv" type="button">Export CSV</button></div>' +
              filtered.map(function(r){
                return '<div style="padding:10px;border:1px solid var(--border);border-radius:12px;display:flex;justify-content:space-between;align-items:center;gap:10px;"><div style="min-width:0;"><strong>' + esc(r.title) + '</strong><div style="font-size:12px;color:var(--muted);">' + esc(r.category) + ' · ' + esc(r.subtitle) + '</div></div><span class="badge">' + esc(r.badge || 'Active') + '</span></div>';
              }).join('') +
            '</section>'
          );
        } else if (targetComp === 'booking_schedule_panel' || (hasComp('booking_schedule_panel') && state.activeTab === 'bookings')) {
          var bookings = readRows('bookings');
          htmlParts.push(
            '<section class="card" style="display:flex;flex-direction:column;gap:10px;">' +
              '<strong>Schedule & Bookings</strong>' +
              '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
                '<input class="input" id="booking-service" placeholder="Service or appointment title..." />' +
                '<button class="btn btn-primary" id="btn-add-booking" type="button">Confirm Booking</button>' +
              '</div>' +
              bookings.map(function(b){
                return '<div style="padding:10px;border-radius:12px;border:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;"><div><div style="font-weight:700;font-size:14px;">' + esc(b.service) + '</div><div style="font-size:12px;color:var(--muted);">' + esc(b.slot) + '</div></div><span class="badge">' + esc(b.status) + '</span></div>';
              }).join('') +
            '</section>'
          );
        } else if (targetComp === 'user_profile_account' || targetComp === 'settings_preferences_panel') {
          var savedRows = rows.filter(function(r){ return Boolean(r.saved); });
          htmlParts.push(
            '<section class="card" style="display:flex;flex-direction:column;gap:12px;">' +
              '<div style="display:flex;justify-content:space-between;align-items:center;">' +
                '<div><strong style="font-size:16px;">Account & Preferences</strong><div style="font-size:12.5px;color:var(--muted);">' + savedRows.length + ' saved · Synced in real time</div></div>' +
                '<button class="btn" id="btn-toggle-theme" type="button">Switch Theme</button>' +
              '</div>' +
              (savedRows.length > 0 ? savedRows.map(function(s){
                return '<div style="padding:10px;border:1px solid var(--border);border-radius:12px;"><strong>' + esc(s.title) + '</strong><div style="font-size:12.5px;color:var(--muted);">' + esc(s.subtitle) + '</div></div>';
              }).join('') : '<div style="color:var(--muted);font-size:13px;">Bookmark items from the feed to see them saved here.</div>') +
            '</section>'
          );
        } else if (hasComp('vertical_video_feed') && (!targetComp || targetComp === 'vertical_video_feed')) {
          htmlParts.push(
            '<section class="grid">' +
              filtered.map(function(item){
                return '<article class="reel-card">' +
                  (item.imageUrl ? '<img class="reel-bg" src="' + esc(item.imageUrl) + '" alt="' + esc(item.title) + '" />' : '') +
                  '<div class="reel-overlay">' +
                    '<div style="min-width:0;">' +
                      '<span class="badge" style="background:rgba(255,255,255,0.22);color:#fff;">' + esc(item.category) + '</span>' +
                      '<h3 style="margin:8px 0 4px;font-size:17px;">' + esc(item.title) + '</h3>' +
                      '<p style="margin:0;font-size:13px;opacity:0.9;">' + esc(item.subtitle) + '</p>' +
                    '</div>' +
                    '<div class="reel-actions">' +
                      '<button class="btn" data-like="' + esc(item.id) + '" type="button">♥ ' + Number(item.likes || 0) + '</button>' +
                      '<button class="btn" data-comment="' + esc(item.id) + '" type="button">💬 Reply</button>' +
                      '<button class="btn" data-save="' + esc(item.id) + '" type="button">' + (item.saved ? '★ Saved' : '☆ Save') + '</button>' +
                    '</div>' +
                  '</div>' +
                '</article>';
              }).join('') +
            '</section>'
          );
        } else {
          htmlParts.push(
            '<section class="grid">' +
              filtered.map(function(item){
                return '<article class="card">' +
                  (item.imageUrl ? '<img class="item-img" src="' + esc(item.imageUrl) + '" alt="' + esc(item.title) + '" />' : '') +
                  '<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;"><span class="badge">' + esc(item.category) + '</span>' + (item.price ? '<strong style="font-size:13px;">' + esc(item.price) + '</strong>' : '') + '</div>' +
                  '<h3 style="margin:8px 0 4px;font-size:15.5px;">' + esc(item.title) + '</h3>' +
                  '<p style="margin:0 0 10px;color:var(--muted);font-size:13px;line-height:1.4;">' + esc(item.subtitle) + '</p>' +
                  '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
                    '<button class="btn" data-like="' + esc(item.id) + '" type="button">♥ ' + Number(item.likes || 0) + '</button>' +
                    '<button class="btn" data-comment="' + esc(item.id) + '" type="button">Comments</button>' +
                    '<button class="btn" data-save="' + esc(item.id) + '" type="button">' + (item.saved ? 'Saved' : 'Save') + '</button>' +
                    (hasComp('shopping_cart_checkout') ? '<button class="btn btn-primary" data-cart="' + esc(item.id) + '" type="button">Add</button>' : '') +
                  '</div>' +
                '</article>';
              }).join('') +
            '</section>'
          );
        }

        main.innerHTML = htmlParts.join('');
        bindDynamicEvents();
      }

      function bindDynamicEvents() {
        var searchInput = document.getElementById('search-input');
        if (searchInput) {
          searchInput.addEventListener('input', function(){
            state.search = this.value;
            renderApp();
            var refocused = document.getElementById('search-input');
            if (refocused) {
              refocused.focus();
              refocused.setSelectionRange(state.search.length, state.search.length);
            }
          });
        }
        var heroCompose = document.getElementById('hero-compose-btn');
        if (heroCompose) heroCompose.addEventListener('click', function(){ document.getElementById('compose-modal').classList.add('open'); });

        var walletTopUp = document.getElementById('btn-wallet-topup');
        if (walletTopUp) walletTopUp.addEventListener('click', function(){
          var txns = readRows('transactions');
          txns.unshift({ id: 'tx_' + Date.now(), label: 'Instant Top-Up', amount: 100, type: 'credit', date: 'Now' });
          writeRows('transactions', txns);
          showToast('Added $100');
          renderApp();
        });

        var exportCsv = document.getElementById('btn-export-csv');
        if (exportCsv) exportCsv.addEventListener('click', function(){
          var rows = readRows(primaryTable);
          var csv = 'title,category,subtitle\\n' + rows.map(function(r){
            return [r.title, r.category, r.subtitle].map(function(v){ return '"' + String(v || '').replace(/"/g, '""') + '"'; }).join(',');
          }).join('\\n');
          var blob = new Blob([csv], { type: 'text/csv' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'export.csv';
          a.click();
          showToast('Exported CSV');
        });

        var catBtns = document.querySelectorAll('[data-cat]');
        for (var c = 0; c < catBtns.length; c += 1) {
          catBtns[c].addEventListener('click', function(){
            state.category = this.getAttribute('data-cat');
            renderApp();
          });
        }

        var likeBtns = document.querySelectorAll('[data-like]');
        for (var l = 0; l < likeBtns.length; l += 1) {
          likeBtns[l].addEventListener('click', function(){
            var id = this.getAttribute('data-like');
            var rows = readRows(primaryTable).map(function(r){
              return r.id === id ? Object.assign({}, r, { likes: (Number(r.likes) || 0) + 1 }) : r;
            });
            writeRows(primaryTable, rows);
            renderApp();
          });
        }

        var saveBtns = document.querySelectorAll('[data-save]');
        for (var s = 0; s < saveBtns.length; s += 1) {
          saveBtns[s].addEventListener('click', function(){
            var id = this.getAttribute('data-save');
            var rows = readRows(primaryTable).map(function(r){
              return r.id === id ? Object.assign({}, r, { saved: !r.saved }) : r;
            });
            writeRows(primaryTable, rows);
            renderApp();
          });
        }

        var commentBtns = document.querySelectorAll('[data-comment]');
        for (var m = 0; m < commentBtns.length; m += 1) {
          commentBtns[m].addEventListener('click', function(){
            state.activeCommentItemId = this.getAttribute('data-comment');
            renderCommentsModal();
            document.getElementById('comments-modal').classList.add('open');
          });
        }

        var cartBtns = document.querySelectorAll('[data-cart]');
        for (var k = 0; k < cartBtns.length; k += 1) {
          cartBtns[k].addEventListener('click', function(){
            var id = this.getAttribute('data-cart');
            var found = readRows(primaryTable).find(function(r){ return r.id === id; });
            if (found) {
              state.cart.push(found);
              writeRows('cart', state.cart);
              showToast('Added to cart');
              updateCartCount();
            }
          });
        }

        var sendChat = document.getElementById('btn-send-chat');
        if (sendChat) {
          sendChat.addEventListener('click', function(){
            var inp = document.getElementById('chat-msg-input');
            var text = inp && inp.value.trim();
            if (!text) return;
            var msgs = readRows('messages');
            msgs.push({ id: 'm_' + Date.now(), author: 'You', text: text, createdAt: 'Now' });
            writeRows('messages', msgs);
            renderApp();
          });
        }

        var addBooking = document.getElementById('btn-add-booking');
        if (addBooking) {
          addBooking.addEventListener('click', function(){
            var inp = document.getElementById('booking-service');
            var service = (inp && inp.value.trim()) || (manifest.appTitle + ' Appointment');
            var list = readRows('bookings');
            list.unshift({ id: 'b_' + Date.now(), service: service, slot: 'Scheduled · Today', status: 'Confirmed' });
            writeRows('bookings', list);
            showToast('Booking saved');
            renderApp();
          });
        }

        var toggleTheme = document.getElementById('btn-toggle-theme');
        if (toggleTheme) {
          toggleTheme.addEventListener('click', function(){
            var isDark = document.documentElement.classList.contains('theme-dark');
            var next = isDark ? 'light' : 'dark';
            document.documentElement.classList.remove('theme-dark', 'theme-light');
            document.documentElement.classList.add('theme-' + next);
            localStorage.setItem('aicraft_theme_pref', next);
          });
        }
      }

      function renderCommentsModal() {
        var box = document.getElementById('comments-list');
        if (!box) return;
        var all = readRows('comments').filter(function(c){ return c.itemId === state.activeCommentItemId; });
        box.innerHTML = all.length > 0
          ? all.map(function(c){ return '<div style="padding:8px 10px;border-radius:10px;background:var(--bg);border:1px solid var(--border);font-size:13px;"><strong>' + esc(c.author) + ':</strong> ' + esc(c.text) + '</div>'; }).join('')
          : '<div style="color:var(--muted);font-size:13px;">No comments yet. Be the first!</div>';
      }

      var openCompose = document.getElementById('btn-open-compose');
      if (openCompose) openCompose.addEventListener('click', function(){ document.getElementById('compose-modal').classList.add('open'); });
      var closeCompose = document.getElementById('btn-close-compose');
      if (closeCompose) closeCompose.addEventListener('click', function(){ document.getElementById('compose-modal').classList.remove('open'); });
      var submitCompose = document.getElementById('btn-submit-compose');
      if (submitCompose) submitCompose.addEventListener('click', function(){
        var title = document.getElementById('compose-title').value.trim();
        var cat = document.getElementById('compose-category').value.trim() || 'Featured';
        var sub = document.getElementById('compose-subtitle').value.trim() || 'Created just now';
        if (!title) return;
        var rows = readRows(primaryTable);
        rows.unshift({
          id: 'row_' + Date.now(),
          title: title,
          category: cat,
          subtitle: sub,
          price: '$24',
          imageUrl: images[rows.length % Math.max(1, images.length)] || '',
          likes: 0,
          saved: false
        });
        writeRows(primaryTable, rows);
        document.getElementById('compose-title').value = '';
        document.getElementById('compose-subtitle').value = '';
        document.getElementById('compose-modal').classList.remove('open');
        showToast('Published live');
        renderApp();
      });

      var closeComments = document.getElementById('btn-close-comments');
      if (closeComments) closeComments.addEventListener('click', function(){ document.getElementById('comments-modal').classList.remove('open'); });
      var submitComment = document.getElementById('btn-submit-comment');
      if (submitComment) submitComment.addEventListener('click', function(){
        var inp = document.getElementById('comment-input');
        var text = inp.value.trim();
        if (!text || !state.activeCommentItemId) return;
        var all = readRows('comments');
        all.push({ id: 'c_' + Date.now(), itemId: state.activeCommentItemId, author: 'You', text: text });
        writeRows('comments', all);
        inp.value = '';
        renderCommentsModal();
      });

      var openCart = document.getElementById('btn-open-cart');
      if (openCart) openCart.addEventListener('click', function(){
        var box = document.getElementById('cart-items');
        if (box) {
          box.innerHTML = state.cart.length > 0
            ? state.cart.map(function(i){ return '<div style="padding:8px;border:1px solid var(--border);border-radius:10px;display:flex;justify-content:space-between;"><span>' + esc(i.title) + '</span><strong>' + esc(i.price || '$19') + '</strong></div>'; }).join('')
            : '<div style="color:var(--muted);font-size:13px;">Your cart is empty.</div>';
        }
        document.getElementById('cart-modal').classList.add('open');
      });
      var closeCart = document.getElementById('btn-close-cart');
      if (closeCart) closeCart.addEventListener('click', function(){ document.getElementById('cart-modal').classList.remove('open'); });
      var placeOrder = document.getElementById('btn-place-order');
      if (placeOrder) placeOrder.addEventListener('click', function(){
        if (state.cart.length === 0) return;
        var orders = readRows('orders');
        orders.unshift({ id: 'ord_' + Date.now(), count: state.cart.length, createdAt: new Date().toISOString() });
        writeRows('orders', orders);
        state.cart = [];
        writeRows('cart', []);
        document.getElementById('cart-modal').classList.remove('open');
        showToast('Order placed!');
        renderApp();
      });

      var openUpgrade = document.getElementById('btn-open-upgrade');
      if (openUpgrade) openUpgrade.addEventListener('click', function(){ document.getElementById('upgrade-modal').classList.add('open'); });
      var closeUpgrade = document.getElementById('btn-close-upgrade');
      if (closeUpgrade) closeUpgrade.addEventListener('click', function(){ document.getElementById('upgrade-modal').classList.remove('open'); });
      var activatePro = document.getElementById('btn-activate-pro');
      if (activatePro) activatePro.addEventListener('click', function(){
        localStorage.setItem('aicraft_pro_active', 'true');
        document.getElementById('upgrade-modal').classList.remove('open');
        showToast('Pro Plan Activated!');
      });

      renderApp();
    })();
  </script>
</body>
</html>`;

  return {
    html: sanitizeAndHardenPreviewHtml(rawHtml),
    manifest,
    steps,
    dbTables,
    logoDirective: {
      name: manifest.appTitle,
      shortName: manifest.appTitle.slice(0, 12),
      themeColor: manifest.primaryColor,
      bgColor: manifest.primaryColor,
      accentColor: manifest.primaryColor,
      motif: 'spark',
    },
  };
}
