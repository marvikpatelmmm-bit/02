const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Database Setup
const DB_PATH = './jee_study.db';
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to SQLite database.');
        initDatabase();
    }
});

function initDatabase() {
    db.serialize(() => {
        // Users
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            current_streak INTEGER DEFAULT 0
        )`);

        // Tasks
        db.run(`CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            task_name TEXT NOT NULL,
            subject TEXT,
            estimated_minutes INTEGER NOT NULL,
            actual_minutes INTEGER,
            accumulated_minutes INTEGER DEFAULT 0,
            status TEXT DEFAULT 'pending',
            started_at DATETIME,
            completed_at DATETIME,
            task_date DATE NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )`);

        // Attempt to add column if it doesn't exist (Migration for existing dbs)
        db.run("ALTER TABLE tasks ADD COLUMN accumulated_minutes INTEGER DEFAULT 0", (err) => {
            // Ignore error if column exists
        });

        // Daily Summaries
        db.run(`CREATE TABLE IF NOT EXISTS daily_summaries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            summary_date DATE NOT NULL,
            maths_problems INTEGER DEFAULT 0,
            physics_problems INTEGER DEFAULT 0,
            chemistry_problems INTEGER DEFAULT 0,
            topics_covered TEXT,
            total_study_hours REAL DEFAULT 0,
            notes TEXT,
            self_rating INTEGER,
            ended_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id),
            UNIQUE(user_id, summary_date)
        )`);

        // Active Sessions (For Real-time)
        db.run(`CREATE TABLE IF NOT EXISTS active_sessions (
            user_id INTEGER PRIMARY KEY,
            active_task_id INTEGER,
            last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (active_task_id) REFERENCES tasks(id)
        )`);
    });
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: 'jee-secret-key-prod-123',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days
}));

// Auth Middleware
function requireAuth(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    next();
}

// --- API ROUTES ---

// Auth
app.post('/api/register', async (req, res) => {
    const { username, password, name } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.run(`INSERT INTO users (username, password, name) VALUES (?, ?, ?)`, 
            [username, hashedPassword, name], 
            function(err) {
                if (err) return res.status(400).json({ error: 'Username already exists' });
                req.session.userId = this.lastID;
                req.session.name = name;
                res.json({ success: true, user: { id: this.lastID, name } });
            }
        );
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
        if (err || !user) return res.status(400).json({ error: 'User not found' });
        
        const match = await bcrypt.compare(password, user.password);
        if (match) {
            req.session.userId = user.id;
            req.session.name = user.name;
            res.json({ success: true, user: { id: user.id, name: user.name } });
        } else {
            res.status(400).json({ error: 'Invalid password' });
        }
    });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/me', requireAuth, (req, res) => {
    res.json({ id: req.session.userId, name: req.session.name });
});

// Tasks
app.get('/api/tasks/today', requireAuth, (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const showAll = req.query.all === 'true';
    
    let query = `SELECT t.*, u.name as user_name FROM tasks t JOIN users u ON t.user_id = u.id WHERE t.task_date = ?`;
    let params = [today];

    if (!showAll) {
        query += ` AND t.user_id = ?`;
        params.push(req.session.userId);
    }
    
    query += ` ORDER BY t.created_at ASC`;

    db.all(query, params, (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

app.post('/api/tasks/batch', requireAuth, (req, res) => {
    const { tasks } = req.body; // Array of {task_name, subject, estimated_minutes}
    const today = new Date().toISOString().split('T')[0];
    const userId = req.session.userId;
    
    const stmt = db.prepare(`INSERT INTO tasks (user_id, task_name, subject, estimated_minutes, task_date) VALUES (?, ?, ?, ?, ?)`);
    
    db.serialize(() => {
        tasks.forEach(task => {
            stmt.run(userId, task.task_name, task.subject, task.estimated_minutes, today);
        });
        stmt.finalize();
        res.json({ success: true });
    });
});

// Helper to pause active task
function pauseActiveTaskInternal(userId, now, callback) {
    db.get(`SELECT active_task_id FROM active_sessions WHERE user_id = ?`, [userId], (err, session) => {
        if (err || !session) {
            return callback(null);
        }
        
        const activeTaskId = session.active_task_id;
        db.get(`SELECT started_at, accumulated_minutes FROM tasks WHERE id = ?`, [activeTaskId], (err, task) => {
            if (err || !task) return callback(null);
            
            const startTime = new Date(task.started_at);
            const endTime = new Date(now);
            const sessionMinutes = Math.max(0, Math.round((endTime - startTime) / 60000)); // prevent negative
            const totalAccumulated = (task.accumulated_minutes || 0) + sessionMinutes;

            db.run(`UPDATE tasks SET status = 'paused', started_at = NULL, accumulated_minutes = ? WHERE id = ?`, 
                [totalAccumulated, activeTaskId], 
                (err) => {
                    db.run(`DELETE FROM active_sessions WHERE user_id = ?`, [userId], (err) => {
                         callback(null);
                    });
                }
            );
        });
    });
}

app.post('/api/tasks/:id/start', requireAuth, (req, res) => {
    const taskId = req.params.id;
    const userId = req.session.userId;
    const now = new Date().toISOString();

    db.serialize(() => {
        // 1. Pause any ongoing task logic
        pauseActiveTaskInternal(userId, now, () => {
             // 2. Start new task
            db.run(`UPDATE tasks SET status = 'in_progress', started_at = ? WHERE id = ? AND user_id = ?`, 
            [now, taskId, userId], 
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                
                // Create active session
                db.run(`INSERT INTO active_sessions (user_id, active_task_id, last_seen) VALUES (?, ?, ?)`,
                    [userId, taskId, now],
                    (err) => {
                        if (err) return res.status(500).json({ error: err.message });
                        res.json({ success: true, started_at: now });
                    }
                );
            }
        );
        });
    });
});

app.post('/api/tasks/:id/pause', requireAuth, (req, res) => {
    const taskId = req.params.id;
    const userId = req.session.userId;
    const now = new Date().toISOString();

    // Verify this is the active task or just use the generic pause logic
    db.get(`SELECT active_task_id FROM active_sessions WHERE user_id = ?`, [userId], (err, session) => {
        if (!session || session.active_task_id != taskId) {
            return res.status(400).json({ error: 'Task is not currently active' });
        }
        
        pauseActiveTaskInternal(userId, now, () => {
            res.json({ success: true });
        });
    });
});

app.post('/api/tasks/:id/complete', requireAuth, (req, res) => {
    const taskId = req.params.id;
    const userId = req.session.userId;
    const now = new Date().toISOString();

    db.get(`SELECT started_at, estimated_minutes, accumulated_minutes FROM tasks WHERE id = ?`, [taskId], (err, task) => {
        if (err || !task) return res.status(404).json({ error: 'Task not found' });

        let currentSessionMinutes = 0;
        if (task.started_at) {
            const startTime = new Date(task.started_at);
            const endTime = new Date();
            currentSessionMinutes = Math.max(0, Math.round((endTime - startTime) / 60000));
        }
        
        const totalMinutes = (task.accumulated_minutes || 0) + currentSessionMinutes;
        
        // Determine status (grace period of 5 mins)
        const status = totalMinutes <= (task.estimated_minutes + 5) ? 'completed_ontime' : 'completed_delayed';

        db.serialize(() => {
            db.run(`DELETE FROM active_sessions WHERE user_id = ?`, [userId]);
            db.run(`UPDATE tasks SET status = ?, completed_at = ?, actual_minutes = ? WHERE id = ?`, 
                [status, now, totalMinutes, taskId],
                (err) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ success: true, status, actualMinutes: totalMinutes });
                }
            );
        });
    });
});

app.post('/api/summary', requireAuth, (req, res) => {
    const userId = req.session.userId;
    const today = new Date().toISOString().split('T')[0];
    const data = req.body;

    db.run(`INSERT INTO daily_summaries 
        (user_id, summary_date, maths_problems, physics_problems, chemistry_problems, topics_covered, total_study_hours, notes, self_rating)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, today, data.maths, data.physics, data.chemistry, data.topics, data.hours, data.notes, data.rating],
        function(err) {
            if (err) return res.status(500).json({ error: 'Summary already submitted for today' });
            
            // Update streak (simplified logic)
            db.run(`UPDATE users SET current_streak = current_streak + 1 WHERE id = ?`, [userId]);
            res.json({ success: true });
        }
    );
});

// Stats & Leaderboard
app.get('/api/leaderboard', requireAuth, (req, res) => {
    // Aggregating over ALL TIME
    const query = `
        SELECT 
            u.id, u.name, 
            u.current_streak,
            COUNT(DISTINCT t.id) as total_tasks,
            COALESCE(SUM(ds.total_study_hours), 0) as total_hours,
            COALESCE(SUM(ds.maths_problems + ds.physics_problems + ds.chemistry_problems), 0) as total_problems
        FROM users u
        LEFT JOIN tasks t ON u.id = t.user_id AND t.status LIKE 'completed%'
        LEFT JOIN daily_summaries ds ON u.id = ds.user_id
        GROUP BY u.id
        ORDER BY total_hours DESC, total_problems DESC
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/profile', requireAuth, (req, res) => {
    const userId = req.session.userId;
    
    const query = `
        SELECT 
            u.name, u.username, u.current_streak, u.created_at,
            (SELECT COUNT(*) FROM tasks WHERE user_id = u.id AND status LIKE 'completed%') as total_tasks_completed,
            COALESCE(SUM(ds.total_study_hours), 0) as total_hours,
            COALESCE(SUM(ds.maths_problems), 0) as total_maths,
            COALESCE(SUM(ds.physics_problems), 0) as total_physics,
            COALESCE(SUM(ds.chemistry_problems), 0) as total_chemistry
        FROM users u
        LEFT JOIN daily_summaries ds ON u.id = ds.user_id
        WHERE u.id = ?
        GROUP BY u.id
    `;
    
    db.get(query, [userId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row);
    });
});

// SSE Stream
app.get('/api/stream', requireAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendUpdate = () => {
        const query = `
            SELECT 
                u.id, u.name, 
                t.task_name, t.subject, t.started_at, t.estimated_minutes, t.accumulated_minutes,
                (SELECT COUNT(*) FROM tasks WHERE user_id = u.id AND status LIKE 'completed%' AND task_date = DATE('now')) as completed_today
            FROM users u
            LEFT JOIN active_sessions as_sess ON u.id = as_sess.user_id
            LEFT JOIN tasks t ON as_sess.active_task_id = t.id
        `;
        
        db.all(query, [], (err, rows) => {
            if (!err) {
                res.write(`data: ${JSON.stringify(rows)}\n\n`);
            }
        });
    };

    // Send immediately
    sendUpdate();

    // Send every 5 seconds
    const interval = setInterval(sendUpdate, 5000);

    req.on('close', () => {
        clearInterval(interval);
    });
});

// Serve Frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/leaderboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'leaderboard.html'));
});

app.get('/profile', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});