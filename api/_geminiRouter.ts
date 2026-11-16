import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { getGeminiApiKeyPool } from './_openrouterModels.js';
import { sanitizeSessionTitle } from './_appsStore.js';
import {
  buildCandidateCooldownKey,
  isGatewayCandidateCoolingDown,
  markGatewayCandidateCooldown,
} from './_aiGateways.js';

export const COMPONENT_IDENTIFIERS = [
  'nav_top_header',
  'nav_bottom_tab_bar',
  'nav_side_drawer',
  'search_filter_bar',
  'hero_showcase_banner',
  'vertical_video_feed',
  'social_post_feed',
  'kpi_analytics_grid',
  'catalog_items_grid',
  'booking_schedule_panel',
  'realtime_chat_inbox',
  'composer_upload_modal',
  'shopping_cart_checkout',
  'wallet_transactions_panel',
  'user_profile_account',
  'monetization_upgrade_modal',
  'settings_preferences_panel',
  'notifications_activity_feed',
  'admin_management_table',
] as const;

export const FEATURE_IDENTIFIERS = [
  'db_realtime_sync',
  'social_reactions',
  'comment_drawer_thread',
  'create_publish_flow',
  'live_search_filter',
  'cart_order_pipeline',
  'messaging_send_reply',
  'booking_confirmation',
  'theme_dark_light_toggle',
  'paywall_upgrade_flow',
  'csv_data_export',
  'analytics_metrics_calc',
] as const;

export type ComponentIdentifier = (typeof COMPONENT_IDENTIFIERS)[number];
export type FeatureIdentifier = (typeof FEATURE_IDENTIFIERS)[number];
export type RouterIntentType =
  | 'chat'
  | 'build_app'
  | 'edit_app'
  | 'generate_image'
  | 'generate_music'
  | 'generate_video';

export interface SeedItemSpec {
  id?: string;
  title: string;
  subtitle: string;
  category: string;
  metric?: string;
  badge?: string;
  price?: string;
  imageQuery?: string;
}

export interface CustomTabSpec {
  id: string;
  label: string;
  componentId: ComponentIdentifier;
}

export interface DataColumnSpec {
  name: string;
  type: 'text' | 'number' | 'boolean' | 'timestamp' | 'json';
}

export interface DataTableSpec {
  name: string;
  columns: DataColumnSpec[];
}

export interface GeminiRouteResult {
  intent: RouterIntentType;
  appTitle: string;
  brandTagline: string;
  replyMessage: string;
  primaryColor: string;
  surfaceTheme: 'dark' | 'light' | 'warm' | 'vibrant';
  componentIds: ComponentIdentifier[];
  featureIds: FeatureIdentifier[];
  addComponentIds: ComponentIdentifier[];
  removeComponentIds: ComponentIdentifier[];
  customTabs: CustomTabSpec[];
  seedItems: SeedItemSpec[];
  dataTables: DataTableSpec[];
  planSteps: string[];
  followUpSuggestions: string[];
  mediaPrompt: string;
  modelUsed: string;
}

export interface ActiveModuleManifest {
  appTitle: string;
  brandTagline: string;
  primaryColor: string;
  surfaceTheme: 'dark' | 'light' | 'warm' | 'vibrant';
  componentIds: ComponentIdentifier[];
  featureIds: FeatureIdentifier[];
  customTabs: CustomTabSpec[];
  seedItems: SeedItemSpec[];
  dataTables: DataTableSpec[];
}

const VALID_COMPONENT_SET = new Set<string>(COMPONENT_IDENTIFIERS);
const VALID_FEATURE_SET = new Set<string>(FEATURE_IDENTIFIERS);

export function extractModuleManifestFromHtml(
  html: string | undefined | null
): ActiveModuleManifest | null {
  if (!html || typeof html !== 'string') return null;
  const match =
    /<meta\s+name=["']aicraft-modules["']\s+content=["']([^"']+)["']/i.exec(html);
  if (!match?.[1]) return null;
  try {
    const decoded = decodeURIComponent(match[1]);
    const parsed = JSON.parse(decoded) as Partial<ActiveModuleManifest>;
    if (!parsed || !Array.isArray(parsed.componentIds)) return null;
    return {
      appTitle:
        typeof parsed.appTitle === 'string' && parsed.appTitle.trim()
          ? parsed.appTitle.trim()
          : 'AI Craft App',
      brandTagline:
        typeof parsed.brandTagline === 'string' && parsed.brandTagline.trim()
          ? parsed.brandTagline.trim()
          : 'Modular interactive app',
      primaryColor:
        typeof parsed.primaryColor === 'string' &&
        /^#[0-9a-f]{6}$/i.test(parsed.primaryColor.trim())
          ? parsed.primaryColor.trim()
          : '#0D5BFF',
      surfaceTheme:
        parsed.surfaceTheme === 'dark' ||
        parsed.surfaceTheme === 'light' ||
        parsed.surfaceTheme === 'warm' ||
        parsed.surfaceTheme === 'vibrant'
          ? parsed.surfaceTheme
          : 'light',
      componentIds: parsed.componentIds.filter((id): id is ComponentIdentifier =>
        VALID_COMPONENT_SET.has(id)
      ),
      featureIds: Array.isArray(parsed.featureIds)
        ? parsed.featureIds.filter((id): id is FeatureIdentifier =>
            VALID_FEATURE_SET.has(id)
          )
        : ['db_realtime_sync'],
      customTabs: Array.isArray(parsed.customTabs) ? parsed.customTabs : [],
      seedItems: Array.isArray(parsed.seedItems) ? parsed.seedItems : [],
      dataTables: Array.isArray(parsed.dataTables) ? parsed.dataTables : [],
    };
  } catch {
    return null;
  }
}

export class GeminiRouterError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 502, code = 'GEMINI_ROUTER_ERROR') {
    super(message);
    this.name = 'GeminiRouterError';
    this.status = status;
    this.code = code;
  }
}

function buildRouterSystemInstruction(params: {
  mode: 'mobile' | 'web';
  requestedMediaKind?: 'image' | 'music' | 'video' | null;
  hasPreviousApp: boolean;
  previousManifest: ActiveModuleManifest | null;
  webSearchContext?: string;
  timeContext?: string;
}): string {
  const {
    mode,
    requestedMediaKind,
    hasPreviousApp,
    previousManifest,
    webSearchContext,
    timeContext,
  } = params;

  const componentCatalogDesc = [
    '- nav_top_header: Top brand header bar with action trigger and status pill',
    '- nav_bottom_tab_bar: Responsive bottom tab bar (iOS/Android/Desktop adaptive)',
    '- nav_side_drawer: Collapsible slide-out navigation drawer / sidebar',
    '- search_filter_bar: Live text search input and clickable category filter chips',
    '- hero_showcase_banner: Featured hero banner with primary CTA and visual artwork',
    '- vertical_video_feed: Full-screen vertical swipeable short-video / reel feed with sound, likes, comments & bookmarks (for TikTok/Reels/Shorts)',
    '- social_post_feed: Interactive social/community posts feed with images, likes, saves & replies',
    '- kpi_analytics_grid: Business KPI metric tiles plus responsive revenue/activity chart',
    '- catalog_items_grid: Product/property/menu/listing cards grid with tap-to-inspect detail drawer',
    '- booking_schedule_panel: Interactive appointment/booking/reservation scheduler persisted to DB',
    '- realtime_chat_inbox: Multi-thread chat messenger inbox and live reply view',
    '- composer_upload_modal: Floating "+" or "New" modal to publish posts, products, videos, or records live into DB',
    '- shopping_cart_checkout: Slide-up shopping cart with quantity +/- controls, subtotal & order placement',
    '- wallet_transactions_panel: Wallet balance card, send/top-up controls & live transaction ledger',
    '- user_profile_account: Account profile header, stats, saved items tab & editable profile bio',
    '- monetization_upgrade_modal: Pro / Creator subscription upgrade modal with plan comparison',
    '- settings_preferences_panel: Theme toggle, notification switches & persisted app preferences',
    '- notifications_activity_feed: Activity alerts stream with mark-read controls',
    '- admin_management_table: Structured searchable management table with inline status toggles',
  ].join('\n');

  const featureCatalogDesc = [
    '- db_realtime_sync: Live database persistence via local reactive store',
    '- social_reactions: Stateful like & bookmark counters persisted per item',
    '- comment_drawer_thread: Slide-up comment drawer persisted per post/video',
    '- create_publish_flow: Working create/post/add record modal updating UI immediately',
    '- live_search_filter: Real-time keyword search and category filtering',
    '- cart_order_pipeline: Add to cart, quantity updates, and live order creation',
    '- messaging_send_reply: Real-time thread messaging with live reply persistence',
    '- booking_confirmation: Date/time slot booking persistence',
    '- theme_dark_light_toggle: Interactive dark/light surface switcher',
    '- paywall_upgrade_flow: Upgrade tier & subscription status persistence',
    '- csv_data_export: Download records as CSV file',
    '- analytics_metrics_calc: Live KPI aggregation over stored database records',
  ].join('\n');

  return [
    'You are the AI backend intent router and module classifier for this application.',
    'Configure yourself strictly as an intent router and module classifier.',
    'CRITICAL RULES:',
    '1. DO NOT generate, write, or return HTML, CSS, JavaScript, TypeScript, JSX, SQL, or source code of ANY kind in ANY field.',
    '2. Respond ONLY with a valid JSON object matching the configured responseSchema.',
    '3. Classify the incoming user message into one exact `intent`:',
    requestedMediaKind
      ? `   - Note: The user explicitly selected a ${requestedMediaKind} model. Unless they are strictly chatting/asking a general question with no generation prompt, classify intent as "generate_${requestedMediaKind}".`
      : '   - "chat": greetings, casual conversation, questions about facts/capabilities, or asking how something works.',
    '   - "build_app": user wants to build or create a new mobile app, web app, website, tool, dashboard, storefront, game, social app, or platform.',
    hasPreviousApp
      ? '   - "edit_app": user wants to modify, add, fix, or remove parts of the existing app (including screenshot feedback).'
      : '   - "edit_app": use only when modifying an existing app.',
    '   - "generate_image": user asks directly for a generated image/photo/artwork (outside building an app).',
    '   - "generate_music": user asks directly to compose/generate a song, beat, audio, or soundtrack.',
    '   - "generate_video": user asks directly to generate a video clip.',
    '4. For "build_app" or "edit_app": select the required UI module identifiers (`componentIds`) and functional feature identifiers (`featureIds`) strictly from the registered catalogs below.',
    '5. When `intent` is "edit_app" and active `previousModules` are provided:',
    '   - Put ONLY specifically requested removals into `removeComponentIds` and additions into `addComponentIds`.',
    '   - Preserve existing modules (`componentIds`) unless explicitly asked to replace or remove them.',
    '6. Keep `appTitle` concise (2-4 words matching the brand/domain; NEVER "Friendly Greeting").',
    '7. Populate `seedItems`, `customTabs`, and `dataTables` with domain-authentic content tailored specifically to the user request and live search context (never generic lorem ipsum, never HTML tags).',
    '8. Keep `replyMessage` concise, clear, and conversational (explain the classified modules or answer the chat prompt—never include code snippets).',
    '',
    `Target platform mode: ${mode}`,
    timeContext ? `Time context: ${timeContext}` : '',
    previousManifest
      ? `Active assembled app manifest (${previousManifest.appTitle}): componentIds=${JSON.stringify(
          previousManifest.componentIds
        )}, featureIds=${JSON.stringify(
          previousManifest.featureIds
        )}, surfaceTheme=${previousManifest.surfaceTheme}, primaryColor=${previousManifest.primaryColor}`
      : 'No active app built yet.',
    webSearchContext ? `Live web/image search context:\n${webSearchContext}` : '',
    '',
    'Registered UI Component Identifiers (`componentIds`):',
    componentCatalogDesc,
    '',
    'Registered Functional Feature Identifiers (`featureIds`):',
    featureCatalogDesc,
  ]
    .filter(Boolean)
    .join('\n');
}

const ROUTER_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    intent: {
      type: Type.STRING,
      description:
        'Exact intent class: chat | build_app | edit_app | generate_image | generate_music | generate_video',
    },
    appTitle: {
      type: Type.STRING,
      description: 'Short 2-4 word brand/app title.',
    },
    brandTagline: {
      type: Type.STRING,
      description: 'Short 4-8 word product tagline.',
    },
    replyMessage: {
      type: Type.STRING,
      description:
        'Plain conversational response or concise summary of assembled modules. Must NOT contain source code.',
    },
    primaryColor: {
      type: Type.STRING,
      description: 'Hex accent color like #0D5BFF or #FF2D55.',
    },
    surfaceTheme: {
      type: Type.STRING,
      description: 'Surface theme: dark | light | warm | vibrant',
    },
    componentIds: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Ordered list of required canonical UI component identifiers.',
    },
    featureIds: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Ordered list of required canonical feature identifiers.',
    },
    addComponentIds: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Identifiers to add during edit_app.',
    },
    removeComponentIds: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Identifiers to remove during edit_app.',
    },
    customTabs: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          label: { type: Type.STRING },
          componentId: { type: Type.STRING },
        },
        required: ['id', 'label', 'componentId'],
      },
      description: 'Up to 5 bottom/nav tabs mapped to componentIds.',
    },
    seedItems: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          subtitle: { type: Type.STRING },
          category: { type: Type.STRING },
          metric: { type: Type.STRING },
          badge: { type: Type.STRING },
          price: { type: Type.STRING },
          imageQuery: { type: Type.STRING },
        },
        required: ['title', 'subtitle', 'category'],
      },
      description: '4-6 domain-authentic initial records for feeds/grids/tables.',
    },
    dataTables: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          columns: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                type: { type: Type.STRING },
              },
              required: ['name', 'type'],
            },
          },
        },
        required: ['name', 'columns'],
      },
      description: 'Structured database table identifiers and columns.',
    },
    planSteps: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: '3-5 concise architecture/assembly step descriptions.',
    },
    followUpSuggestions: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: '2-3 relevant next enhancements the user can tap.',
    },
    mediaPrompt: {
      type: Type.STRING,
      description: 'Cleaned generation prompt for image/music/video intents.',
    },
  },
  required: [
    'intent',
    'appTitle',
    'replyMessage',
    'componentIds',
    'featureIds',
    'planSteps',
  ],
};

function normalizeIntent(raw: unknown, hasPreviousApp: boolean): RouterIntentType {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (s === 'chat') return 'chat';
  if (s === 'build_app') return 'build_app';
  if (s === 'edit_app') return hasPreviousApp ? 'edit_app' : 'build_app';
  if (s === 'generate_image') return 'generate_image';
  if (s === 'generate_music') return 'generate_music';
  if (s === 'generate_video') return 'generate_video';
  return 'chat';
}

function sanitizeComponentList(list: unknown): ComponentIdentifier[] {
  if (!Array.isArray(list)) return [];
  const out: ComponentIdentifier[] = [];
  for (const item of list) {
    if (typeof item === 'string' && VALID_COMPONENT_SET.has(item.trim())) {
      const id = item.trim() as ComponentIdentifier;
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

function sanitizeFeatureList(list: unknown): FeatureIdentifier[] {
  if (!Array.isArray(list)) return [];
  const out: FeatureIdentifier[] = [];
  for (const item of list) {
    if (typeof item === 'string' && VALID_FEATURE_SET.has(item.trim())) {
      const id = item.trim() as FeatureIdentifier;
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

function stripAnyCodeFromText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<!doctype\b[\s\S]*/gi, '')
    .replace(/<\/?(?:html|head|body|script|style|div|section|button)\b[^>]*>/gi, '')
    .trim();
}

export async function routeMessageWithGemini(params: {
  message: string;
  mode: 'mobile' | 'web';
  requestedMediaKind?: 'image' | 'music' | 'video' | null;
  history?: Array<{ role: string; text: string }>;
  previousHtml?: string;
  attachmentName?: string | null;
  attachmentDataUrl?: string | null;
  attachmentMimeType?: string | null;
  attachmentText?: string | null;
  webSearchContext?: string;
  timeContext?: string;
}): Promise<GeminiRouteResult> {
  const keys = getGeminiApiKeyPool();
  if (keys.length === 0) {
    throw new GeminiRouterError(
      'GEMINI_API_KEY is not configured. Please add your Gemini API key in Settings > Secrets.',
      400,
      'GEMINI_API_KEY_MISSING'
    );
  }

  const ready: string[] = [];
  const cooling: string[] = [];
  for (const key of keys) {
    const ck = buildCandidateCooldownKey('gemini', key, 'gemini-4-hydrogen');
    if (isGatewayCandidateCoolingDown(ck)) cooling.push(key);
    else ready.push(key);
  }
  const orderedKeys = [...ready, ...cooling];

  const previousManifest = extractModuleManifestFromHtml(params.previousHtml);
  const hasPreviousApp = Boolean(
    params.previousHtml && params.previousHtml.trim().length > 150
  );

  const systemInstruction = buildRouterSystemInstruction({
    mode: params.mode,
    requestedMediaKind: params.requestedMediaKind,
    hasPreviousApp,
    previousManifest,
    webSearchContext: params.webSearchContext,
    timeContext: params.timeContext,
  });

  const historyText = (params.history ?? [])
    .slice(-6)
    .filter((item) => typeof item?.text === 'string' && item.text.trim().length > 0)
    .map((item) => `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.text.slice(0, 500)}`)
    .join('\n');

  const promptBlocks: string[] = [];
  if (historyText) {
    promptBlocks.push(`Recent conversation:\n${historyText}`);
  }
  if (params.attachmentText) {
    promptBlocks.push(
      `Attached file (${params.attachmentName || 'reference'}):\n${params.attachmentText.slice(0, 6000)}`
    );
  } else if (params.attachmentDataUrl) {
    promptBlocks.push(
      `Attached image/screenshot (${params.attachmentName || 'screenshot.png'}). Classify any UI additions/removals shown or described.`
    );
  }
  promptBlocks.push(`Incoming user message:\n${params.message}`);
  const combinedPrompt = promptBlocks.join('\n\n');

  let contents:
    | string
    | {
        parts: Array<
          | { inlineData: { mimeType: string; data: string } }
          | { text: string }
        >;
      } = combinedPrompt;

  if (params.attachmentDataUrl) {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i.exec(
      params.attachmentDataUrl
    );
    if (match) {
      contents = {
        parts: [
          {
            inlineData: {
              mimeType: params.attachmentMimeType || match[1],
              data: match[2],
            },
          },
          { text: combinedPrompt },
        ],
      };
    }
  }

  let lastError: Error | null = null;

  for (const apiKey of orderedKeys) {
    const cooldownKey = buildCandidateCooldownKey(
      'gemini',
      apiKey,
      'gemini-4-hydrogen'
    );
    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: ROUTER_RESPONSE_SCHEMA,
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.MEDIUM,
          },
        },
      });

      const rawText = (response.text ?? '').trim();
      if (!rawText) {
        throw new GeminiRouterError(
          'Gemini router returned an empty response.',
          502,
          'GEMINI_EMPTY_RESPONSE'
        );
      }

      let parsed: Record<string, unknown>;
      try {
        const cleanedJson = rawText
          .replace(/^```json\s*/i, '')
          .replace(/^```\s*/i, '')
          .replace(/\s*```$/i, '')
          .trim();
        parsed = JSON.parse(cleanedJson) as Record<string, unknown>;
      } catch {
        throw new GeminiRouterError(
          'Gemini router returned invalid JSON.',
          502,
          'GEMINI_INVALID_JSON'
        );
      }

      const intent = normalizeIntent(parsed.intent, hasPreviousApp);
      let componentIds = sanitizeComponentList(parsed.componentIds);
      const addComponentIds = sanitizeComponentList(parsed.addComponentIds);
      const removeComponentIds = sanitizeComponentList(parsed.removeComponentIds);
      let featureIds = sanitizeFeatureList(parsed.featureIds);

      if ((intent === 'build_app' || intent === 'edit_app') && componentIds.length === 0) {
        componentIds = previousManifest?.componentIds?.length
          ? [...previousManifest.componentIds]
          : [
              'nav_top_header',
              'hero_showcase_banner',
              'catalog_items_grid',
              'composer_upload_modal',
              'user_profile_account',
              'nav_bottom_tab_bar',
            ];
      }
      if ((intent === 'build_app' || intent === 'edit_app') && featureIds.length === 0) {
        featureIds = ['db_realtime_sync', 'create_publish_flow', 'live_search_filter'];
      }

      const rawTitle =
        typeof parsed.appTitle === 'string'
          ? sanitizeSessionTitle(parsed.appTitle)
          : '';
      const appTitle =
        rawTitle && !/friendly greeting/i.test(rawTitle)
          ? rawTitle
          : previousManifest?.appTitle || 'AI Craft App';

      const brandTagline =
        typeof parsed.brandTagline === 'string' && parsed.brandTagline.trim()
          ? stripAnyCodeFromText(parsed.brandTagline).slice(0, 90)
          : `${appTitle} · Real-time modular workspace`;

      const replyMessage =
        typeof parsed.replyMessage === 'string' && parsed.replyMessage.trim()
          ? stripAnyCodeFromText(parsed.replyMessage)
          : intent === 'chat'
            ? 'How can I help you route or build today?'
            : `Classified ${componentIds.length} UI modules and ${featureIds.length} features for ${appTitle}.`;

      const primaryColor =
        typeof parsed.primaryColor === 'string' &&
        /^#[0-9a-f]{6}$/i.test(parsed.primaryColor.trim())
          ? parsed.primaryColor.trim()
          : previousManifest?.primaryColor || '#0D5BFF';

      const rawTheme =
        typeof parsed.surfaceTheme === 'string'
          ? parsed.surfaceTheme.trim().toLowerCase()
          : '';
      const surfaceTheme =
        rawTheme === 'dark' ||
        rawTheme === 'light' ||
        rawTheme === 'warm' ||
        rawTheme === 'vibrant'
          ? rawTheme
          : previousManifest?.surfaceTheme || 'light';

      const customTabs: CustomTabSpec[] = Array.isArray(parsed.customTabs)
        ? parsed.customTabs
            .filter(
              (t): t is CustomTabSpec =>
                Boolean(
                  t &&
                    typeof t === 'object' &&
                    typeof (t as CustomTabSpec).label === 'string' &&
                    VALID_COMPONENT_SET.has((t as CustomTabSpec).componentId)
                )
            )
            .slice(0, 5)
            .map((t, idx) => ({
              id:
                typeof t.id === 'string' && t.id.trim()
                  ? t.id.trim().replace(/[^a-z0-9_-]/gi, '')
                  : `tab_${idx + 1}`,
              label: stripAnyCodeFromText(t.label).slice(0, 20) || 'Tab',
              componentId: t.componentId,
            }))
        : [];

      const seedItems: SeedItemSpec[] = Array.isArray(parsed.seedItems)
        ? parsed.seedItems
            .filter(
              (item): item is SeedItemSpec =>
                Boolean(
                  item &&
                    typeof item === 'object' &&
                    typeof (item as SeedItemSpec).title === 'string'
                )
            )
            .slice(0, 8)
            .map((item, idx) => ({
              id: `item_${idx + 1}`,
              title: stripAnyCodeFromText(item.title).slice(0, 80),
              subtitle: stripAnyCodeFromText(String(item.subtitle || '')).slice(0, 140),
              category: stripAnyCodeFromText(String(item.category || 'Featured')).slice(0, 32),
              metric: item.metric ? stripAnyCodeFromText(String(item.metric)).slice(0, 32) : undefined,
              badge: item.badge ? stripAnyCodeFromText(String(item.badge)).slice(0, 24) : undefined,
              price: item.price ? stripAnyCodeFromText(String(item.price)).slice(0, 24) : undefined,
              imageQuery: item.imageQuery
                ? stripAnyCodeFromText(String(item.imageQuery)).slice(0, 80)
                : undefined,
            }))
        : [];

      const dataTables: DataTableSpec[] = Array.isArray(parsed.dataTables)
        ? parsed.dataTables
            .filter(
              (tbl): tbl is DataTableSpec =>
                Boolean(
                  tbl &&
                    typeof tbl === 'object' &&
                    typeof (tbl as DataTableSpec).name === 'string' &&
                    Array.isArray((tbl as DataTableSpec).columns)
                )
            )
            .slice(0, 8)
            .map((tbl) => ({
              name: tbl.name
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9_]+/g, '_')
                .replace(/^_+|_+$/g, '') || 'items',
              columns: tbl.columns
                .filter((c) => c && typeof c.name === 'string')
                .slice(0, 10)
                .map((c) => {
                  const colType = String(c.type || 'text').toLowerCase();
                  return {
                    name:
                      c.name
                        .trim()
                        .toLowerCase()
                        .replace(/[^a-z0-9_]+/g, '_') || 'value',
                    type:
                      colType === 'number' ||
                      colType === 'boolean' ||
                      colType === 'timestamp' ||
                      colType === 'json'
                        ? colType
                        : 'text',
                  };
                }),
            }))
        : [];

      const planSteps = Array.isArray(parsed.planSteps)
        ? parsed.planSteps
            .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
            .map((s) => stripAnyCodeFromText(s).slice(0, 110))
            .slice(0, 6)
        : [];

      const followUpSuggestions = Array.isArray(parsed.followUpSuggestions)
        ? parsed.followUpSuggestions
            .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
            .map((s) => stripAnyCodeFromText(s).slice(0, 90))
            .slice(0, 3)
        : [];

      const mediaPrompt =
        typeof parsed.mediaPrompt === 'string' && parsed.mediaPrompt.trim()
          ? stripAnyCodeFromText(parsed.mediaPrompt).slice(0, 400)
          : params.message;

      return {
        intent,
        appTitle,
        brandTagline,
        replyMessage,
        primaryColor,
        surfaceTheme,
        componentIds,
        featureIds,
        addComponentIds,
        removeComponentIds,
        customTabs,
        seedItems,
        dataTables,
        planSteps,
        followUpSuggestions,
        mediaPrompt,
        modelUsed: 'google/gemini-4-hydrogen',
      };
    } catch (err) {
      if (err instanceof GeminiRouterError && err.code === 'GEMINI_API_KEY_MISSING') {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (/429|quota|rate.?limit|resource_exhausted|too many requests|exceeded/i.test(msg)) {
        markGatewayCandidateCooldown(cooldownKey, 75_000);
        lastError = new GeminiRouterError(
          'Gemini API rate limit or quota reached. Check your GEMINI_API_KEY quota in Settings > Secrets.',
          429,
          'RESOURCE_EXHAUSTED'
        );
      } else if (/api key not valid|invalid api key|permission_denied|unauthorized|401|403/i.test(msg)) {
        markGatewayCandidateCooldown(cooldownKey, 120_000);
        lastError = new GeminiRouterError(
          'Gemini API key was rejected. Please verify GEMINI_API_KEY in Settings > Secrets.',
          403,
          'API_KEY_INVALID'
        );
      } else {
        lastError = err instanceof Error ? err : new Error(msg);
      }
    }
  }

  throw (
    lastError ??
    new GeminiRouterError(
      'Unable to route request via Gemini API right now.',
      502,
      'GEMINI_ROUTER_FAILED'
    )
  );
}
