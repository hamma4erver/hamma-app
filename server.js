const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const apiKey = process.env.GROQ_API_KEY;
// كود الأدمن الخاص بك
const ADMIN_SECRET = process.env.ADMIN_SECRET || "1838311070";

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

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

// إدارة الحظر والكتم
const mutedUsers = new Set();
const blockedUsers = new Set();
let onlineUsersCount = 0;

io.on('connection', (socket) => {
    onlineUsersCount++;
    io.emit('update-online', onlineUsersCount);

    socket.on('chat-message', (data) => {
        if (blockedUsers.has(data.user)) {
            return socket.emit('system-msg', 'أنت محظور من إرسال الرسائل.');
        }
        if (mutedUsers.has(data.user)) {
            return socket.emit('system-msg', 'تم كتم صوتك، لا يمكنك الإرسال.');
        }
        io.emit('chat-message', data);
    });

    // 1. حذف رسالة
    socket.on('delete-message', ({ msgId, token }) => {
        if (token !== ADMIN_SECRET) return;
        io.emit('delete-message', msgId);
    });

    // 2. كتم / إلغاء كتم
    socket.on('mute-user', ({ username, token }) => {
        if (token !== ADMIN_SECRET) return socket.emit('system-msg', 'رمز الأدمن غير صحيح!');
        mutedUsers.add(username);
        io.emit('system-msg', `تم كتم: ${username}`);
    });

    socket.on('unmute-user', ({ username, token }) => {
        if (token !== ADMIN_SECRET) return socket.emit('system-msg', 'رمز الأدمن غير صحيح!');
        mutedUsers.delete(username);
        io.emit('system-msg', `تم إلغاء كتم: ${username}`);
    });

    // 3. حظر / إلغاء حظر
    socket.on('block-user', ({ username, token }) => {
        if (token !== ADMIN_SECRET) return socket.emit('system-msg', 'رمز الأدمن غير صحيح!');
        blockedUsers.add(username);
        io.emit('system-msg', `تم حظر: ${username}`);
    });

    socket.on('unblock-user', ({ username, token }) => {
        if (token !== ADMIN_SECRET) return socket.emit('system-msg', 'رمز الأدمن غير صحيح!');
        blockedUsers.delete(username);
        io.emit('system-msg', `تم إلغاء حظر: ${username}`);
    });

    socket.on('disconnect', () => {
        onlineUsersCount = Math.max(0, onlineUsersCount - 1);
        io.emit('update-online', onlineUsersCount);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
