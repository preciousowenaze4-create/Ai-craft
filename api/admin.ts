import {
  ModerationActionType,
  applyOwnerModerationAction,
  authenticateRequestForModeration,
  listAllRealSignedInUsers,
} from './_moderation.js';

const VALID_ACTIONS: ModerationActionType[] = [
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

  const users = await listAllRealSignedInUsers();
  return Response.json(
    {
      ok: true,
      users,
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
  };

  const action =
    typeof body.action === 'string'
      ? (body.action.trim().toLowerCase() as ModerationActionType)
      : ('' as ModerationActionType);

  if (!VALID_ACTIONS.includes(action)) {
    return Response.json(
      { error: 'Invalid moderation action.' },
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
