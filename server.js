const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// هذي تخليه يقرأ ملفات الـ CSS والـ HTML
app.use(express.static('public'));

io.on('connection', (socket) => {
    console.log('مستخدم جديد اتصل: ' + socket.id);

    // هنا السيرفر يستقبل الرسالة ويبعثها للناس الكل
    socket.on('message', (msg) => {
        // نبعثوا الرسالة للناس الكل (المرسل والمستقبلين)
        // ومستعملين اسم 'message' كيف ما هو موجود في index.html
        io.emit('message', { name: "User " + socket.id.substring(0, 4), text: msg });
    });

    socket.on('disconnect', () => {
        console.log('مستخدم خرج');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('السيرفر يخدم على البورت: ' + PORT);
});
