import {
  ModerationActionType,
  applyOwnerModerationAction,
  authenticateRequestForModeration,
  listAllRealSignedInUsers,
} from './_moderation.js';
import {
  getGeminiApiUsageSnapshot,
  updateOrResetGeminiQuota,
} from './_geminiUsage.js';

const VALID_MODERATION_ACTIONS: ModerationActionType[] = [
  'ban',
  'unban',
  'verify',
  'unverify',
  'restrict',
  'unrestrict',
];

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateRequestForModeration(request);
  if (!auth.user) {
    return Response.json(
      { error: 'Authentication required.' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  if (!auth.isOwner) {
    return Response.json(
      { error: 'Forbidden.' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const [users, geminiUsage] = await Promise.all([
    listAllRealSignedInUsers(),
    getGeminiApiUsageSnapshot(),
  ]);
  return Response.json(
    {
      ok: true,
      users,
      geminiUsage,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateRequestForModeration(request);
  if (!auth.user) {
    return Response.json(
      { error: 'Authentication required.' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  if (!auth.isOwner) {
    return Response.json(
      { error: 'Forbidden.' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    userId?: string;
    email?: string;
    action?: string;
    reason?: string;
    dailyRequestsLimit?: number;
    dailyTokensLimit?: number;
    overallTokensLimit?: number;
  };

  const rawAction =
    typeof body.action === 'string' ? body.action.trim().toLowerCase() : '';

  if (rawAction === 'reset_quota' || rawAction === 'set_quota_limit') {
    const geminiUsage = await updateOrResetGeminiQuota({
      resetUsagePool: rawAction === 'reset_quota',
      dailyRequestsLimit: body.dailyRequestsLimit,
      dailyTokensLimit: body.dailyTokensLimit,
      overallTokensLimit: body.overallTokensLimit,
    });
    return Response.json(
      {
        ok: true,
        geminiUsage,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const action = rawAction as ModerationActionType;

  if (!VALID_MODERATION_ACTIONS.includes(action)) {
    return Response.json(
      { error: 'Invalid admin action.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const result = await applyOwnerModerationAction({
    actorEmail: auth.user.email || '',
    targetUserId: body.userId,
    targetEmail: body.email,
    action,
    reason: body.reason,
  });

  if (result.ok === false) {
    return Response.json(
      { error: result.error },
      { status: result.status, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  return Response.json(
    {
      ok: true,
      user: result.user,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
