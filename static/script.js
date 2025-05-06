document.addEventListener('DOMContentLoaded', () => {
    const messageForm = document.getElementById('message-form');
    const userInput = document.getElementById('user-input');
    const chatbox = document.getElementById('chatbox');
    let botMessageElement = null; // 用于追踪当前正在接收的机器人消息元素

    messageForm.addEventListener('submit', async (event) => {
        event.preventDefault(); // 阻止表单默认提交行为
        const messageText = userInput.value.trim();

        if (!messageText) {
            return; // 如果输入为空，则不执行任何操作
        }

        // 1. 在聊天框显示用户消息
        appendMessage(messageText, 'user');
        userInput.value = ''; // 清空输入框
        userInput.focus(); // 让输入框保持焦点

        // 准备显示机器人回复的地方 (初始为空或带打字效果)
        botMessageElement = appendMessage('', 'bot', true); // 添加一个带打字效果的空消息

        // 2. 向后端发送消息 (使用流式端点)
        try {
            const response = await fetch('/chat_stream', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ message: messageText }),
            });

            if (!response.ok) {
                // 如果 HTTP 状态码不是 2xx，则抛出错误
                const errorData = await response.json(); // 尝试解析错误信息
                throw new Error(errorData.error || `服务器错误: ${response.status}`);
            }

            // 3. 处理流式响应 (Server-Sent Events)
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let accumulatedData = ''; // 用于处理可能被分割的 SSE 消息

            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    console.log('数据流结束');
                    if (botMessageElement) {
                        botMessageElement.classList.remove('typing'); // 数据流结束，移除打字效果
                    }
                    break; // 退出循环
                }

                // 解码收到的数据块
                accumulatedData += decoder.decode(value, { stream: true });

                // 按行处理 SSE 消息 (以 \n\n 分隔)
                let lines = accumulatedData.split('\n\n');

                for (let i = 0; i < lines.length - 1; i++) { // 处理除了最后一个（可能不完整）之外的所有消息
                    const line = lines[i];
                    if (line.startsWith('event: end')) {
                         console.log('收到结束信号');
                         if (botMessageElement) {
                            botMessageElement.classList.remove('typing');
                         }
                         // 可以选择在这里彻底结束，即使reader.read()还没done
                         // reader.cancel(); // 主动关闭流
                         // return;
                    } else if (line.startsWith('data:')) {
                        const data = line.substring(5).trim(); // 提取 'data:' 后面的内容
                        if (botMessageElement) {
                            botMessageElement.classList.remove('typing'); // 收到数据就移除打字效果
                            botMessageElement.textContent += data; // 将收到的文本追加到机器人消息元素
                            chatbox.scrollTop = chatbox.scrollHeight; // 滚动到底部
                        }
                    }
                }
                // 保留下次处理可能不完整的最后一部分
                accumulatedData = lines[lines.length - 1];
            }
            // 确保 TextDecoder 处理完最后的数据块
            const lastChunk = decoder.decode(undefined);
             if (lastChunk && lastChunk.startsWith('data:')) {
                 const data = lastChunk.substring(5).trim();
                 if (botMessageElement) {
                     botMessageElement.textContent += data;
                     chatbox.scrollTop = chatbox.scrollHeight;
                 }
             }
             if (botMessageElement) {
                 botMessageElement.classList.remove('typing');
             }


        } catch (error) {
            console.error('聊天请求失败:', error);
            if (botMessageElement) {
                botMessageElement.classList.remove('typing');
                botMessageElement.textContent = `抱歉，发生错误: ${error.message}`;
                botMessageElement.style.color = 'red';
            } else {
                // 调用 appendMessage 显示错误，不需要 typing 效果 (第四个参数为 true 表示 isError)
                appendMessage(`抱歉，发生错误: ${error.message}`, 'bot', false, true);
            }
        } finally {
             // 无论成功或失败，重置追踪元素
            botMessageElement = null;
        }
    });

    // 辅助函数：在聊天框中添加消息
    function appendMessage(text, sender, isTypingPlaceholder = false, isError = false) { // 添加 isTypingPlaceholder 参数
        const messageElement = document.createElement('div');
    
        // sender 现在总是 'user' 或 'bot'，所以这里是安全的
        messageElement.classList.add('message', `${sender}-message`);
    
        messageElement.textContent = text;
    
        // 根据需要添加 typing 类
        if (sender === 'bot' && isTypingPlaceholder) {
            messageElement.classList.add('typing');
        }
    
        if (isError) { // 处理错误样式 (如果需要，可以和 typing 状态分开处理)
            messageElement.style.color = 'red';
            messageElement.classList.remove('typing'); // 出错时移除打字效果
        }
    
        chatbox.appendChild(messageElement);
        chatbox.scrollTop = chatbox.scrollHeight; // 自动滚动到底部
        return messageElement; // 返回创建的元素，方便后续更新
    }
});