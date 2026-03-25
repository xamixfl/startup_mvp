// DB table names used by the frontend local API client.

window.APP = window.APP || {};
window.APP.TABLES = {
  profiles: 'profiles',
  meetings: 'meetings',
  // Meeting participants are stored in "table-connector" on your current schema.
  participants: 'table-connector',
  cities: 'cities',
  topics: 'topics',
  chats: 'chats',
  chat_members: 'chat_members',
  chat_messages: 'chat_messages',
  reports: 'reports',
  bans: 'bans',
  ban_appeals: 'ban_appeals',
  notifications: 'notifications'
};
