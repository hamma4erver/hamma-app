const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

// توا الـ Variable في Render تولي تسميها HF_API_KEY
const apiKey = process.env.HF_API_KEY; 

app.post('/api/gemini', async (req, res) => {
    const { prompt } = req.body;
    
    if (!apiKey) {
        return res.json({ reply: "HF_API_KEY is missing on Render." });
    }

    try {
        const fetch = (await import('node-fetch')).default;
        
        // استدعاء موديل Meta Llama 3 القوي والمجاني بالكامل بدون كارت بنكية
        const apiResponse = await fetch("https://api-inference.huggingface.co/models/meta-llama/Meta-Llama-3-8B-Instruct", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                inputs: prompt,
                parameters: { max_new_tokens: 500 }
            })
        });

        const data = await apiResponse.json();
        
        if (data && data[0] && data[0].generated_text) {
            // تنظيف النص المسترجع وإرساله للشات
            let replyText = data[0].generated_text.replace(prompt, "").trim();
            res.json({ reply: replyText || "I'm here!" });
        } else {
            res.json({ reply: "Sorry, Hamma AI is busy right now." });
        }
    } catch (error) {
        console.error("HF Error:", error);
        res.json({ reply: "An error occurred with the AI service." });
    }
});

io.on('connection', (socket) => {
    socket.on('chat-message', (data) => {
        io.emit('chat-message', data);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
