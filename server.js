const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenAI } = require('@google/generative-ai');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

// تثبيت الـ API Key من الـ Environment Variables
const aiKey = process.env.GEMINI_API_KEY; 
let aiModel = null;

if (aiKey) {
    const ai = new GoogleGenAI({ apiKey: aiKey });
    aiModel = ai.getGenerativeModel({ model: "gemini-1.5-flash" });
} else {
    console.warn("Warning: GEMINI_API_KEY is not defined in environment variables.");
}

// الـ Route الخاص بالـ AI واللي تضرب في الـ undefined
app.post('/api/gemini', async (req, res) => {
    const { prompt } = req.body;
    
    if (!aiModel) {
        return res.json({ reply: "AI Service is not configured. Please check your API Key on Render." });
    }

    try {
        const result = await aiModel.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        
        // تأكيد إرسال خاصية 'reply' ليتطابق مع الـ index.html
        res.json({ reply: text });
    } catch (error) {
        console.error("AI Error:", error);
        res.json({ reply: "Sorry, I am having trouble processing that right now." });
    }
});

// إعدادات الـ Socket.io للشات العام
io.on('connection', (socket) => {
    socket.on('chat-message', (data) => {
        io.emit('chat-message', data);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
