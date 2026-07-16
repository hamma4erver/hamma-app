const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// إعداد الذكاء الاصطناعي بمفتاح الـ API الخاص بك
const genAI = new GoogleGenerativeAI("AQ.Ab8RN6JjVM4eHQlS8WydqMXFXRl7HlZoT3od-uCzDha4ro9wlg");
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// إعدادات Middleware لقراءة الـ JSON والملفات الثابتة
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// مسار استقبال الأسئلة وإرسالها لـ Gemini
app.post('/api/gemini', async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!prompt) {
            return res.status(400).json({ error: "Prompt is required" });
        }
        
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        res.json({ reply: responseText });
    } catch (error) {
        console.error("Gemini Error:", error);
        res.status(500).json({ error: "Failed to get response from Gemini" });
    }
});

// إدارة اتصالات الشات العام عبر Socket.io
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('chat-message', (data) => {
        io.emit('chat-message', data);
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
    });
});

server.listen(PORT, () => {
    console.log(`Hamma Chat server is running on http://localhost:${PORT}`);
});
