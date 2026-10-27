export type AppNotificationKind = 'message' | 'call-join';

export interface AppNotification {
  id: string;
  kind: AppNotificationKind;
  groupId: string;
  groupName: string;
  actorName: string;
  createdAt: string;
  read: boolean;
}

export type NotificationAction =
  | { type: 'add'; notification: AppNotification }
  | { type: 'read-all' }
  | { type: 'read'; id: string }
  | { type: 'clear' };

const MAX_NOTIFICATIONS = 100;

export function notificationsReducer(state: AppNotification[], action: NotificationAction): AppNotification[] {
  switch (action.type) {
    case 'add':
      if (state.some((notification) => notification.id === action.notification.id)) return state;
      return [action.notification, ...state].slice(0, MAX_NOTIFICATIONS);
    case 'read-all':
      if (state.every((notification) => notification.read)) return state;
      return state.map((notification) => notification.read ? notification : { ...notification, read: true });
    case 'read':
      if (!state.some((notification) => notification.id === action.id && !notification.read)) return state;
      return state.map((notification) => notification.id === action.id ? { ...notification, read: true } : notification);
    case 'clear':
      return state.length ? [] : state;
  }
}
