import sqlite3
import json
import time
import os

DB_PATH = "/root/agent-hub/data/sessions.db"

def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            title TEXT,
            agent TEXT,
            workspace TEXT,
            created_at REAL,
            updated_at REAL
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            role TEXT,
            content TEXT,
            agent TEXT,
            timestamp REAL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )
    """)
    cols = [r[1] for r in cursor.execute("PRAGMA table_info(messages)")]
    if "model" not in cols:
        cursor.execute("ALTER TABLE messages ADD COLUMN model TEXT")
    if "tokens" not in cols:
        cursor.execute("ALTER TABLE messages ADD COLUMN tokens INTEGER")
    conn.commit()
    conn.close()

def list_sessions():
    init_db()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT id, title, agent, workspace, created_at, updated_at FROM sessions ORDER BY updated_at DESC")
    rows = cursor.fetchall()
    conn.close()
    return [
        {
            "id": r[0],
            "title": r[1],
            "agent": r[2],
            "workspace": r[3],
            "created_at": r[4],
            "updated_at": r[5]
        }
        for r in rows
    ]

def get_session(session_id: str):
    init_db()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT id, title, agent, workspace, created_at, updated_at FROM sessions WHERE id = ?", (session_id,))
    session_row = cursor.fetchone()
    if not session_row:
        conn.close()
        return None
    cursor.execute("SELECT role, content, agent, timestamp, model, tokens FROM messages WHERE session_id = ? ORDER BY id ASC", (session_id,))
    msg_rows = cursor.fetchall()
    conn.close()
    return {
        "id": session_row[0],
        "title": session_row[1],
        "agent": session_row[2],
        "workspace": session_row[3],
        "created_at": session_row[4],
        "updated_at": session_row[5],
        "messages": [
            {
                "role": m[0],
                "content": m[1],
                "agent": m[2],
                "timestamp": m[3],
                "model": m[4],
                "tokens": m[5]
            }
            for m in msg_rows
        ]
    }

def create_session(session_id: str, title: str, agent: str, workspace: str):
    init_db()
    now = time.time()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO sessions (id, title, agent, workspace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        (session_id, title, agent, workspace, now, now)
    )
    conn.commit()
    conn.close()

def add_message(session_id: str, role: str, content: str, agent: str, model: str = None, tokens: int = None):
    init_db()
    now = time.time()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO messages (session_id, role, content, agent, timestamp, model, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (session_id, role, content, agent, now, model, tokens)
    )
    cursor.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now, session_id))
    conn.commit()
    conn.close()

def update_session_title(session_id: str, title: str):
    init_db()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("UPDATE sessions SET title = ? WHERE id = ?", (title, session_id))
    conn.commit()
    conn.close()

def delete_session(session_id: str):
    init_db()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
    cursor.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
    conn.commit()
    conn.close()
