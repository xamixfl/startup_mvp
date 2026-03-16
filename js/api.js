// js/api.js - клиент для работы с локальным API

const api = {
  // Базовый метод для запросов
  async request(endpoint, options = {}) {
    const response = await fetch(endpoint, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    });
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    
    return await response.json();
  },

  // Универсальный метод для работы с таблицами
  async query(table, action, data = {}, filters = {}) {
    return this.request('/api/query', {
      method: 'POST',
      body: JSON.stringify({ table, action, data, filters })
    });
  },

  // Получить записи из таблицы
  async get(table, filters = {}) {
    const result = await this.query(table, 'select', {}, filters);
    return result; // всегда массив
  },

  // Получить одну запись
  async getOne(table, id) {
    const result = await this.get(table, { id });
    return result[0] || null;
  },

  // Добавить запись
  async insert(table, data) {
    return this.query(table, 'insert', data);
  },

  // Обновить запись
  async update(table, id, data) {
    return this.query(table, 'update', { id, ...data });
  },

  // Удалить запись
  async delete(table, id) {
    return this.query(table, 'delete', { id });
  },

  // Специальные методы для конкретных таблиц
  async getProfile(userId) {
    return this.request(`/api/profiles/${userId}`);
  },

  async getMeetings() {
    return this.request('/api/meetings');
  },

  // Для встреч созданных пользователем
  async getUserMeetings(userId) {
    return this.get('meetings', { creator_id: userId });
  },

  // Для чатов пользователя
  async getUserChats(userId) {
    return this.get('chat_members', { user_id: userId });
  }
};
