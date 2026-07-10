const sendBtn = document.getElementById('send-btn');
const messageInput = document.getElementById('message-input');

// الحصول على اسم المستخدم عند فتح الصفحة
const currentUsername = getUsername();

// حدث عند الضغط على زر الإرسال
sendBtn.addEventListener('click', () => {
    const text = messageInput.value.trim();
    if (text !== "") {
        sendMessageToServer(currentUsername, text);
        messageInput.value = ""; // تفريغ الخانة بعد الإرسال
    }
});

// إمكانية الإرسال بالضغط على زر Enter في الكيبورد
messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        sendBtn.click();
    }
});