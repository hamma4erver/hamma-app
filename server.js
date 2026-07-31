const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const admin = require('firebase-admin');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const apiKey = process.env.GROQ_API_KEY;

// ==================================================
// تهيئة Firebase Admin SDK
// FIREBASE_SERVICE_ACCOUNT لازم يكون JSON كامل (نص واحد) فمتغيرات البيئة
// ==================================================
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT is missing! Admin actions will fail.");
} else {
    admin.initializeApp({
        credential: admin.credential.cert(
            JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
        )
    });
}

const db = admin.apps.length ? admin.firestore() : null;

// ==================================================
// تتحقق من التوكن وترجع true/false إذا المستخدم admin أو moderator
// ==================================================
async function verifyAdmin(idToken) {
    if (!idToken || !db) return { ok: false };
    try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        const userDoc = await db.collection('users').doc(decoded.uid).get();
        const role = userDoc.exists ? userDoc.data().role : null;
        const isOwner = decoded.name === "Hamma" || decoded.name === "Hamma Admin";
        const isAllowed = role === "admin" || role === "moderator" || isOwner;
        return { ok: isAllowed, uid: decoded.uid, name: decoded.name };
    } catch (e) {
        console.error("Token verification failed:", e.message);
        return { ok: false };
    }
}

// مسار الذكاء الاصطناعي
app.post('/api/gemini', async (req, res) => {
    const { prompt } = req.body;
    if (!apiKey) return res.json({ reply: "GROQ_API_KEY is missing on Render." });

    try {
        const apiResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: "llama-3.1-8b-instant",
                messages: [{ role: "user", content: prompt }]
            })
        });

        const data = await apiResponse.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
            res.json({ reply: data.choices[0].message.content });
        } else if (data.error) {
            res.json({ reply: `Groq Error: ${data.error.message}` });
        } else {
            res.json({ reply: "Received an invalid response structure." });
        }
    } catch (error) {
        res.json({ reply: `Fetch Error: ${error.message}` });
    }
});

// ==================================================
// إدارة الكتم (مؤقت بمدة) والحظر (كامل)
// ==================================================
const mutedUsers = new Map();     // username -> expiresAt (timestamp ms)
const muteTimers = new Map();     // username -> setTimeout handle
const blockedUsers = new Set();   // username -> banned permanently
const socketUsers = new Map();    // socket.id -> username
let onlineUsersCount = 0;

function getStatusLists() {
    // ننضف أي كتم منتهي قبل ما نبعث الحالة
    const now = Date.now();
    for (const [user, expiresAt] of mutedUsers.entries()) {
        if (expiresAt <= now) mutedUsers.delete(user);
    }
    return {
        muted: [...mutedUsers.entries()].map(([username, expiresAt]) => ({ username, expiresAt })),
        banned: [...blockedUsers]
    };
}

function broadcastStatusLists() {
    io.emit('status-lists', getStatusLists());
}

function scheduleAutoUnmute(username, ms) {
    if (muteTimers.has(username)) clearTimeout(muteTimers.get(username));
    const timer = setTimeout(() => {
        mutedUsers.delete(username);
        muteTimers.delete(username);
        io.emit('system-msg', { text: `انتهت مدة كتم: ${username}`, kind: 'info' });
        broadcastStatusLists();
    }, ms);
    muteTimers.set(username, timer);
}

// يطرد أي سوكت مسجل بهذا الاسم (يستعمل عند الحظر)
function kickUserSockets(username, reason) {
    for (const [socketId, uname] of socketUsers.entries()) {
        if (uname === username) {
            const s = io.sockets.sockets.get(socketId);
            if (s) {
                s.emit('you-are-banned', { reason });
                s.disconnect(true);
            }
            socketUsers.delete(socketId);
        }
    }
}

io.on('connection', (socket) => {
    onlineUsersCount++;
    io.emit('update-online', onlineUsersCount);

    // نبعث الحالة الحالية للمستخدم الجديد فور ما يتصل
    socket.emit('status-lists', getStatusLists());

    // العميل يسجل اسمه فور ما يدخل للشات، باش نقدر نطبق الحظر عليه لحظيًا
    socket.on('register-user', ({ username }) => {
        if (!username) return;
        if (blockedUsers.has(username)) {
            socket.emit('you-are-banned', { reason: 'أنت محظور من هذه المحادثة.' });
            socket.disconnect(true);
            return;
        }
        socketUsers.set(socket.id, username);
    });

    socket.on('chat-message', (data) => {
        if (blockedUsers.has(data.user)) {
            return socket.emit('system-msg', { text: 'أنت محظور من إرسال الرسائل.', kind: 'error' });
        }
        const expiresAt = mutedUsers.get(data.user);
        if (expiresAt && expiresAt > Date.now()) {
            const remaining = Math.ceil((expiresAt - Date.now()) / 60000);
            return socket.emit('system-msg', { text: `تم كتم صوتك، حاول بعد ${remaining} دقيقة.`, kind: 'error' });
        }
        io.emit('chat-message', data);
    });

    // 1. حذف رسالة
    socket.on('delete-message', async ({ msgId, idToken }) => {
        const { ok } = await verifyAdmin(idToken);
        if (!ok) return socket.emit('system-msg', { text: 'ليست لديك صلاحية الحذف.', kind: 'error' });
        io.emit('delete-message', msgId);
    });

    // 2. كتم بمدة محددة (بالدقائق: 5 / 15 / 30 / 60)
    socket.on('mute-user', async ({ username, idToken, minutes }) => {
        const { ok } = await verifyAdmin(idToken);
        if (!ok) return socket.emit('system-msg', { text: 'ليست لديك صلاحية الكتم.', kind: 'error' });

        const allowedDurations = [5, 15, 30, 60];
        const duration = allowedDurations.includes(Number(minutes)) ? Number(minutes) : 5;
        const ms = duration * 60 * 1000;
        const expiresAt = Date.now() + ms;

        mutedUsers.set(username, expiresAt);
        scheduleAutoUnmute(username, ms);

        io.emit('system-msg', { text: `🔇 تم كتم ${username} لمدة ${duration} دقيقة.`, kind: 'mute' });
        broadcastStatusLists();
    });

    socket.on('unmute-user', async ({ username, idToken }) => {
        const { ok } = await verifyAdmin(idToken);
        if (!ok) return socket.emit('system-msg', { text: 'ليست لديك صلاحية الكتم.', kind: 'error' });

        mutedUsers.delete(username);
        if (muteTimers.has(username)) {
            clearTimeout(muteTimers.get(username));
            muteTimers.delete(username);
        }
        io.emit('system-msg', { text: `🔊 تم إلغاء كتم ${username}.`, kind: 'info' });
        broadcastStatusLists();
    });

    // 3. حظر كامل / إلغاء حظر
    socket.on('block-user', async ({ username, idToken }) => {
        const { ok } = await verifyAdmin(idToken);
        if (!ok) return socket.emit('system-msg', { text: 'ليست لديك صلاحية الحظر.', kind: 'error' });

        blockedUsers.add(username);
        io.emit('system-msg', { text: `🚫 تم حظر ${username} من المحادثة.`, kind: 'ban' });
        kickUserSockets(username, 'تم حظرك من طرف الإدارة.');
        broadcastStatusLists();
    });

    socket.on('unblock-user', async ({ username, idToken }) => {
        const { ok } = await verifyAdmin(idToken);
        if (!ok) return socket.emit('system-msg', { text: 'ليست لديك صلاحية الحظر.', kind: 'error' });

        blockedUsers.delete(username);
        io.emit('system-msg', { text: `✅ تم إلغاء حظر ${username}.`, kind: 'info' });
        broadcastStatusLists();
    });

    socket.on('disconnect', () => {
        socketUsers.delete(socket.id);
        onlineUsersCount = Math.max(0, onlineUsersCount - 1);
        io.emit('update-online', onlineUsersCount);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
