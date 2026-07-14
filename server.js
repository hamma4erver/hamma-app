const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// تحديد المجلد العام للملفات (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // استقبال الميساج وإعادة إرساله للجميع مع تحديد الـ senderId
    socket.on('chat-message', (data) => {
        // نضمنوا إن الـ senderId هو الـ socket.id الصحيح متاع اللي بعث
        data.senderId = socket.id; 
        io.emit('chat-message', data);
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
    });
});

// تشغيل السيرفر على البورت المحدد أو 3000
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
