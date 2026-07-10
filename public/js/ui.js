const messagesContainer = document.getElementById('messages');

function displayNewMessage(username, message) {
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('message');
    msgDiv.innerHTML = `<strong>${username}:</strong> ${message}`;
    messagesContainer.appendChild(msgDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight; // النزول لآخر ميساج تلقائياً
}