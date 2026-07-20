const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

const apiKey = process.env.HF_API_KEY; 

app.post('/api/gemini', async (req, res) => {
    const { prompt } = req.body;
    
    if (!apiKey) {
        return res.json({ reply: "HF_API_KEY is missing on Render." });
    }

    try {
        const fetch = (await import('node-fetch')).default;
        
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
        
        // التحقق إذا كان هنالك خطأ قادم من Hugging Face مباشرة وطباعته
        if (data.error) {
            console.error("HF API Error:", data.error);
            return res.json({ reply: `HF API Error: ${data.error}` });
        }

        // التعامل مع صيغة الـ Array اللي يرجعها Hugging Face
        if (Array.isArray(data) && data[0] && data[0].generated_text) {
            let replyText = data[0].generated_text.replace(prompt, "").trim();
            res.json({ reply: replyText || "Done!" });
        } else if (data.generated_text) {
            let replyText = data.generated_text.replace(prompt, "").trim();
            res.json({ reply: replyText });
        } else {
            console.error("Unknown HF Response structure:", data);
            res.json({ reply: "Sorry, received an unexpected response structure from Hugging Face." });
        }
    } catch (error) {
        console.error("Fetch Error:", error);
        res.json({ reply: `Fetch Error: ${error.message}` });
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
