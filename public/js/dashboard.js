// --- STATE ---
let activeTaskId = null;
let activeTaskStartTime = null;
let activeTaskAccumulated = 0;
let activeTaskDuration = 0; // minutes
let timerInterval = null;
let currentUser = null;
let showGlobalTasks = false;

// --- INIT ---
document.addEventListener('DOMContentLoaded', async () => {
    await checkAuth();
    loadTasks();
    initSSE();
    loadLeaderboard();
});

async function checkAuth() {
    try {
        const res = await fetch('/api/me');
        if (res.status === 401) window.location.href = '/';
        currentUser = await res.json();
        document.getElementById('userGreeting').textContent = `Hi, ${currentUser.name}`;
    } catch (e) {
        window.location.href = '/';
    }
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/';
});

function toggleTaskView() {
    showGlobalTasks = document.getElementById('globalTaskToggle').checked;
    const planBtn = document.getElementById('planBtn');
    if (showGlobalTasks) {
        planBtn.style.display = 'none';
    } else {
        planBtn.style.display = 'flex';
    }
    loadTasks();
}

// --- TASKS ---
async function loadTasks() {
    const endpoint = showGlobalTasks ? '/api/tasks/today?all=true' : '/api/tasks/today';
    const res = await fetch(endpoint);
    const tasks = await res.json();
    const list = document.getElementById('taskList');
    list.innerHTML = '';

    let hasActiveForMe = false;

    if (tasks.length === 0) {
        list.innerHTML = `<div style="text-align: center; color: var(--text-secondary); padding: 20px;">No tasks found.</div>`;
        return;
    }

    tasks.forEach(task => {
        const isMyTask = task.user_id === currentUser.id;
        
        if (isMyTask && task.status === 'in_progress') {
            setupActiveTask(task);
            hasActiveForMe = true;
        }

        const div = document.createElement('div');
        div.className = `task-card ${task.subject ? task.subject.toLowerCase() : ''} ${task.status}`;
        
        // Logic for Action Button
        let actionBtn = '';
        if (isMyTask) {
            if (task.status === 'pending' || task.status === 'paused') {
                actionBtn = `<button class="btn btn-primary" style="font-size:0.8rem; padding:6px 12px;" onclick="startTask(${task.id})"><i class="fas fa-play"></i> ${task.status === 'paused' ? 'Resume' : 'Start'}</button>`;
            } else if (task.status === 'in_progress') {
                actionBtn = `<span style="color: var(--accent-blue); font-weight: bold; font-size: 0.8rem;"><i class="fas fa-spinner fa-spin"></i> Focusing</span>`;
            } else if (task.status.includes('completed')) {
                const totalMins = task.actual_minutes || 0;
                actionBtn = `<span style="font-size: 0.8rem; color: var(--success-green);"><i class="fas fa-check"></i> Done (${totalMins}m)</span>`;
            }
        } else {
            // Viewing other's task
            actionBtn = `<span style="font-size: 0.75rem; color: var(--text-secondary);"><i class="fas fa-user"></i> ${task.user_name}</span>`;
        }

        const subjectLabel = task.subject || 'General';
        
        div.innerHTML = `
            <div class="task-info">
                <span class="subject-tag">${subjectLabel}</span>
                <h4>${task.task_name}</h4>
                <div class="task-meta"><i class="far fa-clock"></i> ${task.estimated_minutes} mins ${task.status === 'paused' ? '(Paused)' : ''}</div>
            </div>
            <div style="display:flex; flex-direction:column; align-items:flex-end; gap:5px;">
                ${actionBtn}
            </div>
        `;
        list.appendChild(div);
    });

    if (!hasActiveForMe) clearActiveTaskUI();
}

// --- TIMER LOGIC ---
function setupActiveTask(task) {
    activeTaskId = task.id;
    activeTaskStartTime = new Date(task.started_at);
    activeTaskDuration = task.estimated_minutes;
    activeTaskAccumulated = task.accumulated_minutes || 0;

    document.getElementById('noActiveTask').style.display = 'none';
    document.getElementById('activeTaskDisplay').style.display = 'block';
    
    // Update labels and styling
    const subjectEl = document.getElementById('currentSubject');
    subjectEl.textContent = task.subject;
    // Reset classes and add specific subject class
    subjectEl.className = 'subject-tag'; 
    document.getElementById('activeTaskDisplay').className = `active-task-container ${task.subject.toLowerCase()}`;
    
    document.getElementById('currentTaskName').textContent = task.task_name;

    if (timerInterval) clearInterval(timerInterval);
    updateTimer();
    timerInterval = setInterval(updateTimer, 1000);
}

function updateTimer() {
    if (!activeTaskStartTime) return;
    const now = new Date();
    const diffMs = now - activeTaskStartTime;
    const sessionSeconds = Math.floor(diffMs / 1000);
    
    // Total elapsed = Accumulated + Current Session
    const totalSeconds = (activeTaskAccumulated * 60) + sessionSeconds;
    
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    document.getElementById('timer').textContent = 
        `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

    // Progress bar
    const totalEstSeconds = activeTaskDuration * 60;
    const pct = Math.min((totalSeconds / totalEstSeconds) * 100, 100);
    document.getElementById('timerProgress').style.width = `${pct}%`;
}

function clearActiveTaskUI() {
    activeTaskId = null;
    activeTaskStartTime = null;
    if (timerInterval) clearInterval(timerInterval);
    document.getElementById('noActiveTask').style.display = 'flex';
    document.getElementById('activeTaskDisplay').style.display = 'none';
}

async function startTask(id) {
    await fetch(`/api/tasks/${id}/start`, { method: 'POST' });
    loadTasks(); 
}

async function pauseTask() {
    if (!activeTaskId) return;
    await fetch(`/api/tasks/${activeTaskId}/pause`, { method: 'POST' });
    loadTasks();
}

async function completeTask() {
    if (!activeTaskId) return;
    await fetch(`/api/tasks/${activeTaskId}/complete`, { method: 'POST' });
    loadTasks();
}

// --- PLANNING MODAL ---
function openPlanModal() {
    document.getElementById('planModal').classList.add('show');
    const container = document.getElementById('planRows');
    if (container.children.length === 0) addPlanRow();
}

function addPlanRow() {
    const row = document.createElement('div');
    row.className = 'task-row';
    row.innerHTML = `
        <input type="text" placeholder="Task Name" class="p-name">
        <select class="p-subject">
            <option value="Maths">Maths</option>
            <option value="Physics">Physics</option>
            <option value="Chemistry">Chemistry</option>
        </select>
        <input type="number" placeholder="Mins" class="p-time" value="60">
        <button class="remove-row" onclick="this.parentElement.remove()"><i class="fas fa-times"></i></button>
    `;
    document.getElementById('planRows').appendChild(row);
}

async function savePlan() {
    const rows = document.querySelectorAll('.task-row');
    const tasks = [];
    rows.forEach(row => {
        const name = row.querySelector('.p-name').value;
        const subject = row.querySelector('.p-subject').value;
        const mins = row.querySelector('.p-time').value;
        if (name && mins) {
            tasks.push({ task_name: name, subject: subject, estimated_minutes: mins });
        }
    });

    await fetch('/api/tasks/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks })
    });
    
    closeModal('planModal');
    loadTasks();
}

// --- END DAY ---
function openEndDayModal() {
    document.getElementById('endDayModal').classList.add('show');
}

async function submitSummary() {
    const data = {
        maths: document.getElementById('sumMath').value || 0,
        physics: document.getElementById('sumPhy').value || 0,
        chemistry: document.getElementById('sumChem').value || 0,
        topics: document.getElementById('sumTopics').value,
        hours: document.getElementById('sumHours').value || 0,
        notes: document.getElementById('sumNotes').value,
        rating: document.getElementById('sumRating').value
    };

    const res = await fetch('/api/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });

    if (res.ok) {
        alert('Good job today! Get some rest.');
        closeModal('endDayModal');
    } else {
        alert('Error saving summary.');
    }
}

function closeModal(id) {
    document.getElementById(id).classList.remove('show');
}

// --- REALTIME (SSE) ---
function initSSE() {
    const evtSource = new EventSource('/api/stream');
    evtSource.onmessage = (event) => {
        const users = JSON.parse(event.data);
        renderFeed(users);
    };
}

function renderFeed(users) {
    const container = document.getElementById('liveFeed');
    container.innerHTML = '';
    
    users.forEach(user => {
        const div = document.createElement('div');
        const isActive = !!user.task_name;
        
        div.className = `user-card ${isActive ? 'active-user' : ''}`;
        
        let statusHtml = '';
        if (isActive) {
            const startedAt = new Date(user.started_at);
            const now = new Date();
            const sessionMins = Math.max(0, (now - startedAt) / 60000);
            const totalMins = (user.accumulated_minutes || 0) + sessionMins;
            const estMins = user.estimated_minutes;
            const pct = Math.min((totalMins / estMins) * 100, 100);
            
            statusHtml = `
                <div style="width: 100%">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span style="font-weight: bold; color: var(--accent-blue);">${user.task_name}</span>
                        <span style="font-size: 0.7rem; color: var(--text-secondary); text-transform: uppercase;">${user.subject}</span>
                    </div>
                    
                    <div class="feed-progress-bg">
                        <div class="feed-progress-fill" style="width: ${pct}%"></div>
                    </div>
                    <div style="font-size: 0.75rem; text-align: right; color: var(--text-secondary); margin-top: 2px;">
                        ${Math.round(totalMins)}/${estMins} min
                    </div>
                </div>
            `;
        } else {
            statusHtml = `<div style="color: var(--text-secondary); font-style: italic; font-size: 0.9rem;"> Taking a break</div>`;
        }

        div.innerHTML = `
            <div class="status-dot" style="background: ${isActive ? 'var(--success-green)' : '#555'}; margin-top: 5px;"></div>
            <div style="flex-grow: 1;">
                <div style="display:flex; justify-content:space-between; margin-bottom: 5px;">
                    <strong>${user.name}</strong>
                    <span style="font-size: 0.7rem; background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px;">✅ ${user.completed_today}</span>
                </div>
                ${statusHtml}
            </div>
        `;
        container.appendChild(div);
    });
}

// --- LEADERBOARD MINI ---
async function loadLeaderboard() {
    const res = await fetch('/api/leaderboard');
    const data = await res.json();
    const list = document.getElementById('leaderboardList');
    list.innerHTML = '';
    
    // Show Top 3 in mini view
    data.slice(0, 3).forEach((u, i) => {
        const div = document.createElement('div');
        div.style.padding = '10px 0';
        div.style.borderBottom = '1px solid var(--border-glass)';
        div.innerHTML = `
            <div style="display:flex; justify-content:space-between; font-size: 0.9rem;">
                <div style="display:flex; gap: 8px;">
                    <span style="font-weight: bold; width: 20px;">#${i+1}</span>
                    <span>${u.name}</span>
                </div>
                <span style="color: var(--accent-pink); font-weight: bold;">🔥 ${u.current_streak}</span>
            </div>
        `;
        list.appendChild(div);
    });
}