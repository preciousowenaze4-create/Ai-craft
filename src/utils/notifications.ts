export interface CompletionNotificationInput {
  title: string;
  body: string;
  tag: string;
  projectId: string;
  kind?: 'chat' | 'build' | 'media';
}

export function getNotificationPermissionState(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return 'unsupported';
  }
  return Notification.permission;
}

export async function requestAppNotificationPermission(): Promise<boolean> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return false;
  }
  if (Notification.permission === 'granted') {
    return true;
  }
  if (Notification.permission === 'denied') {
    return false;
  }
  try {
    const result = await Notification.requestPermission();
    return result === 'granted';
  } catch {
    return false;
  }
}

export async function sendAppCompletionNotification(
  input: CompletionNotificationInput
): Promise<boolean> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return false;
  }
  if (Notification.permission !== 'granted') {
    return false;
  }

  const options: NotificationOptions = {
    body: input.body,
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    tag: input.tag,
    data: {
      projectId: input.projectId,
      kind: input.kind || 'build',
      url: '/',
    },
  };

  try {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      const registration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 1200)),
      ]);
      if (registration && typeof registration.showNotification === 'function') {
        await registration.showNotification(input.title, options);
        return true;
      }
    }
  } catch {
    // Fall back cleanly to window Notification constructor
  }

  try {
    const note = new Notification(input.title, options);
    note.onclick = () => {
      try {
        window.focus();
        note.close();
      } catch {
        // ignore focus error
      }
    };
    return true;
  } catch {
    return false;
  }
}
