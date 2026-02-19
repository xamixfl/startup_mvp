const supabaseClient = window.APP?.supabase;
const { TABLES } = window.APP || {};
const DEFAULT_AVATAR = 'assets/avatar.png';

let currentUser = null;
let allMeetings = [];
let TOPICS = [];
let currentFilter = 'all';

document.addEventListener('DOMContentLoaded', async () => {
    // Check authentication
    const { data: { user } } = await supabaseClient.auth.getUser();

    if (!user) {
        window.location.href = 'login.html';
        return;
    }

    currentUser = user;

    // Load topics
    TOPICS = await window.fetchTopics();

    // Cleanup expired meetings
    await window.cleanupExpiredMeetings();

    // Load meetings
    await loadMeetings();

    // Setup tabs
    setupTabs();
});

async function loadMeetings() {
    if (!currentUser) return;

    try {
        const container = document.getElementById('meetings-container');
        container.innerHTML = '<div style="text-align: center; padding: 40px; color: #94a3b8;">Загрузка...</div>';

        // Get all meetings where user is the creator
        const { data: ownedMeetings, error: ownedError } = await supabaseClient
            .from('meetings')
            .select('*')
            .eq('creator_id', currentUser.id)
            .order('created_at', { ascending: false });

        if (ownedError) throw ownedError;

        // Get all meetings where user is a participant
        const { data: participantData, error: participantError } = await supabaseClient
            .from(TABLES.participants)
            .select('meeting_id')
            .eq('user_id', currentUser.id);

        if (participantError) throw participantError;

        const participantMeetingIds = (participantData || []).map(p => p.meeting_id);

        let participantMeetings = [];
        if (participantMeetingIds.length > 0) {
            const { data: meetings, error: meetingsError } = await supabaseClient
                .from('meetings')
                .select('*')
                .in('id', participantMeetingIds)
                .order('created_at', { ascending: false });

            if (meetingsError) throw meetingsError;
            participantMeetings = meetings || [];
        }

        // Combine and mark meetings
        allMeetings = [
            ...(ownedMeetings || []).map(m => ({ ...m, role: 'owner' })),
            ...(participantMeetings || []).filter(m => m.creator_id !== currentUser.id).map(m => ({ ...m, role: 'participant' }))
        ];

        // Fetch creator profiles for all meetings
        const creatorIds = [...new Set(allMeetings.map(m => m.creator_id))];
        const creatorProfiles = {};

        for (const creatorId of creatorIds) {
            const { data: profile } = await supabaseClient
                .from(TABLES.profiles)
                .select('id, username, full_name, photo_URL')
                .eq('id', creatorId)
                .single();

            if (profile) {
                creatorProfiles[creatorId] = profile;
            }
        }

        // Attach creator profiles to meetings
        allMeetings = allMeetings.map(m => ({
            ...m,
            creator: creatorProfiles[m.creator_id]
        }));

        renderMeetings(currentFilter);

    } catch (error) {
        console.error('Ошибка загрузки встреч:', error);
        const container = document.getElementById('meetings-container');
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⚠️</div><div class="empty-state-title">Ошибка загрузки</div><div class="empty-state-text">Не удалось загрузить встречи</div></div>';
    }
}

function setupTabs() {
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentFilter = tab.dataset.tab;
            renderMeetings(currentFilter);
        });
    });
}

function renderMeetings(filter) {
    const container = document.getElementById('meetings-container');

    let filteredMeetings = allMeetings;

    if (filter === 'owner') {
        filteredMeetings = allMeetings.filter(m => m.role === 'owner');
    } else if (filter === 'participant') {
        filteredMeetings = allMeetings.filter(m => m.role === 'participant');
    }

    if (filteredMeetings.length === 0) {
        let emptyMessage = 'Вы пока не участвуете ни в одной встрече';
        let emptyIcon = '📭';

        if (filter === 'owner') {
            emptyMessage = 'Вы пока не создали ни одной встречи';
            emptyIcon = '📝';
        } else if (filter === 'participant') {
            emptyMessage = 'Вы пока не присоединились ни к одной встрече';
            emptyIcon = '👥';
        }

        container.style.display = 'block';
        container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">${emptyIcon}</div>
        <div class="empty-state-title">${emptyMessage}</div>
        <div class="empty-state-text">Найдите интересные встречи в ленте</div>
        <a href="index.html" class="btn-create">Перейти к ленте</a>
      </div>
    `;
        return;
    }

    container.style.display = 'grid';
    container.innerHTML = '';

    filteredMeetings.forEach(meeting => {
        const card = createMeetingCard(meeting);
        container.appendChild(card);
    });
}

function createMeetingCard(meeting) {
    const topic = TOPICS.find(t => t.id === meeting.topic) || TOPICS[0];
    const card = document.createElement('div');
    card.className = 'meeting-card';

    const creatorName = meeting.creator?.full_name || meeting.creator?.username || 'Организатор';
    const creatorAvatar = meeting.creator?.photo_URL && meeting.creator?.photo_URL !== 'user'
        ? meeting.creator.photo_URL
        : DEFAULT_AVATAR;

    const statusBadge = meeting.role === 'owner'
        ? '<div class="status-badge status-owner">Организатор</div>'
        : '<div class="status-badge status-participant">Участник</div>';

    const topicName = topic ? topic.name.replace(/^(\S+)\s/, '') : 'Встреча';
    const topicColor = topic?.color || '#3b82f6';

    // Menu items based on role
    const menuItems = meeting.role === 'owner'
        ? `<button class="meeting-menu-item" onclick="event.stopPropagation(); window.editMeeting('${meeting.id}')">✏️ Редактировать</button>
           <button class="meeting-menu-item danger" onclick="event.stopPropagation(); window.deleteMeeting('${meeting.id}')">🗑️ Удалить встречу</button>`
        : `<button class="meeting-menu-item" onclick="event.stopPropagation(); window.leaveMeeting('${meeting.id}')">Покинуть</button>`;

    card.innerHTML = `
    ${statusBadge}
    ${meeting.role === 'owner' ? `<button class="meeting-menu-btn" data-meeting-id="${meeting.id}">⋮</button>` : ''}
    <div class="meeting-tag" style="background: ${topicColor}20; color: ${topicColor};">
      #${topicName}
    </div>
    <div class="meeting-title">${meeting.title || 'Без названия'}</div>
    <div class="meeting-info">
      <span>👥 ${meeting.current_slots || 0}/${meeting.max_slots || 0}</span>
      <span>📍 ${meeting.location || 'Город не указан'}</span>
    </div>
    <div class="meeting-creator">
      <div class="creator-avatar">
        <img src="${creatorAvatar}" alt="${creatorName}">
      </div>
      <div class="creator-name">${creatorName}</div>
    </div>
    ${meeting.role === 'owner' ? `<div class="meeting-menu" data-meeting-id="${meeting.id}">${menuItems}</div>` : ''}
  `;

    // Setup click handler for card
    card.onclick = (e) => {
        // Don't navigate if clicking menu button or menu items
        if (e.target.closest('.meeting-menu-btn') || e.target.closest('.meeting-menu')) {
            return;
        }
        window.location.href = `meeting.html?id=${meeting.id}`;
    };

    // Setup menu button
    const menuBtn = card.querySelector('.meeting-menu-btn');
    if (menuBtn) {
        menuBtn.onclick = (e) => {
            e.stopPropagation();
            toggleMeetingMenu(meeting.id, card);
        };
    }

    return card;
}

function toggleMeetingMenu(meetingId, cardElement) {
    const menu = cardElement.querySelector(`[data-meeting-id="${meetingId}"].meeting-menu`);
    if (!menu) return;

    // Close other menus
    document.querySelectorAll('.meeting-menu.open').forEach(m => {
        if (m !== menu) m.classList.remove('open');
    });

    menu.classList.toggle('open');
}

// Close menus when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.meeting-menu') && !e.target.closest('.meeting-menu-btn')) {
        document.querySelectorAll('.meeting-menu.open').forEach(m => {
            m.classList.remove('open');
        });
    }
});

// Edit meeting function
window.editMeeting = function (meetingId) {
    if (!currentUser) {
        alert('Вы должны быть авторизованы');
        return;
    }
    window.location.href = `create-meeting.html?edit=${meetingId}`;
};

// Delete meeting function
window.deleteMeeting = async function (meetingId) {
    if (!currentUser) {
        alert('Вы должны быть авторизованы');
        return;
    }

    if (!confirm('Вы уверены, что хотите удалить эту встречу?')) {
        return;
    }

    try {
        const { error } = await supabaseClient
            .from('meetings')
            .delete()
            .eq('id', meetingId)
            .eq('creator_id', currentUser.id);

        if (error) throw error;

        // Reload meetings
        await loadMeetings();
    } catch (error) {
        console.error('Ошибка удаления встречи:', error);
        alert('Ошибка при удалении встречи');
    }
};

// Leave meeting function
window.leaveMeeting = async function (meetingId) {
    if (!currentUser) {
        alert('Вы должны быть авторизованы');
        return;
    }

    if (!confirm('Вы уверены, что хотите покинуть эту встречу?')) {
        return;
    }

    try {
        const { error } = await supabaseClient
            .from(TABLES.participants)
            .delete()
            .eq('meeting_id', meetingId)
            .eq('user_id', currentUser.id);

        if (error) throw error;

        // Update meeting slots
        const { data: meeting } = await supabaseClient
            .from('meetings')
            .select('current_slots')
            .eq('id', meetingId)
            .single();

        if (meeting) {
            await supabaseClient
                .from('meetings')
                .update({ current_slots: Math.max(0, (meeting.current_slots || 1) - 1) })
                .eq('id', meetingId);
        }

        // Reload meetings
        await loadMeetings();
    } catch (error) {
        console.error('Ошибка выхода из встречи:', error);
        alert('Ошибка при выходе из встречи');
    }
}
