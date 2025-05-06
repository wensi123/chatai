document.addEventListener('DOMContentLoaded', () => {
    const messageForm = document.getElementById('message-form');
    const userInput = document.getElementById('user-input'); // 现在是 textarea
    const chatbox = document.getElementById('chatbox');
    let botMessageElement = null; // 用于追踪当前正在接收的机器人消息元素
    let es = null; // 用于存储 EventSource 对象，方便关闭

    // --- 提取发送逻辑为一个函数 ---
    async function sendMessage() {
        const messageText = userInput.value.trim();

        if (!messageText) {
            return; // 如果输入为空，则不执行任何操作
        }

        // 1. 在聊天框显示用户消息
        appendMessage(messageText, 'user');
        userInput.value = ''; // 清空输入框
        userInput.focus(); // 让输入框保持焦点
        userInput.style.height = 'auto'; // 重置高度以便重新计算
        userInput.style.height = userInput.scrollHeight + 'px'; // 可选：根据内容调整初始高度

        // 准备显示机器人回复的地方 (初始为空或带打字效果)
        botMessageElement = appendMessage('', 'bot', true); // 添加一个带打字效果的空消息

        // --- 关闭上一个 EventSource (如果存在) ---
        if (es) {
            es.close();
            console.log('Previous EventSource closed.');
        }

        // 2. 使用 EventSource API 连接后端流式端点 (更健壮)
        // 注意：GET 请求通常不携带 body，但可以将消息作为查询参数发送。
        // 如果消息过长或包含特殊字符，POST 配合 fetch 是更好的选择。
        // 这里我们继续使用 fetch POST，但处理逻辑不变。
        try {
            // --- 使用 Fetch API ---
            const response = await fetch('/chat_stream', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ message: messageText }),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: `服务器错误: ${response.status}` }));
                throw new Error(errorData.error || `服务器错误: ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let accumulatedData = '';

            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    console.log('数据流结束 (reader done)');
                    if (botMessageElement) {
                        botMessageElement.classList.remove('typing');
                    }
                    break;
                }

                accumulatedData += decoder.decode(value, { stream: true });
                let lines = accumulatedData.split('\n\n');

                for (let i = 0; i < lines.length - 1; i++) {
                    const line = lines[i];
                    if (line.startsWith('event: end')) {
                        console.log('收到结束信号 (event: end)');
                        if (botMessageElement) {
                            botMessageElement.classList.remove('typing');
                        }
                        // 流可能尚未完全关闭，但我们已收到逻辑结束信号
                        // 可以选择在这里 break 内部循环，但外部循环将继续直到 reader.done
                    } else if (line.startsWith('event: error')) {
                        console.error('收到错误信号:', line);
                        const errorJson = line.substring(line.indexOf('{'), line.lastIndexOf('}') + 1);
                        let errorMessage = '模型生成时出错';
                        try {
                           const errorData = JSON.parse(errorJson);
                           errorMessage = errorData.error || errorMessage;
                        } catch(e) { console.error("解析错误信息失败:", e); }

                        if (botMessageElement) {
                            botMessageElement.classList.remove('typing');
                            botMessageElement.textContent += `\n错误: ${errorMessage}`;
                            botMessageElement.style.color = 'red';
                        } else {
                            appendMessage(`错误: ${errorMessage}`, 'bot', false, true);
                        }
                        // 收到错误后，通常也意味着流结束
                        return; // 或 break 循环

                    } else if (line.startsWith('data:')) {
                        // !! 修改: 移除 trim() 保留 token 中的原始空格
                        const data = line.substring(5).trim(); // 不再 trim()
                        if (botMessageElement) {
                            // 只要收到数据（包括空字符串''），就移除打字效果，防止一直转圈
                            botMessageElement.classList.remove('typing');
                            // 追加数据，CSS 的 white-space: pre-wrap 会处理显示
                            if (data) { // 只有在 data 非空时才追加，避免追加 '' (虽然视觉无影响)
                                botMessageElement.textContent += data;
                                chatbox.scrollTop = chatbox.scrollHeight;
                            }
                        }
                    }
                }
                accumulatedData = lines[lines.length - 1];
            }
            // 处理解码器中可能剩余的最后部分
            const lastChunk = decoder.decode();
            if (lastChunk) {
                 // 也要处理最后一块数据
                let lines = (accumulatedData + lastChunk).split('\n\n');
                 for (let i = 0; i < lines.length; i++) { // 处理所有行，包括最后一个
                    const line = lines[i];
                    if (line.startsWith('data:')) {
                        const data = line.substring(5).trim();
                        if (botMessageElement && data) {
                            botMessageElement.textContent += data;
                            // chatbox.scrollTop = chatbox.scrollHeight;
                        }
                    }
                     // 可以在这里再次检查 end 或 error 事件，虽然理论上应该在循环中处理完了
                }
            }
            if (botMessageElement) {
                chatbox.scrollTop = chatbox.scrollHeight;
                // botMessageElement.classList.remove('typing'); // 确保最后移除 typing
            }

        } catch (error) {
            console.error('聊天请求处理失败:', error);
            if (botMessageElement) {
                botMessageElement.classList.remove('typing');
                botMessageElement.textContent = `抱歉，连接或处理时发生错误: ${error.message}`;
                botMessageElement.style.color = 'red';
            } else {
                appendMessage(`抱歉，发生错误: ${error.message}`, 'bot', false, true);
            }
        } finally {
            botMessageElement = null; // 重置追踪元素
            es = null; // 重置 EventSource 变量
        }
    }


    // --- 监听 textarea 的按键事件 ---
    userInput.addEventListener('keydown', (event) => {
        // 按下 Enter 且没有按下 Shift
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault(); // 阻止默认的换行行为
            sendMessage(); // 发送消息
        }
        // 按下 Shift + Enter 时，浏览器会执行默认行为（换行）
    });

    // --- 监听表单的提交事件（例如点击发送按钮）---
    messageForm.addEventListener('submit', (event) => {
        event.preventDefault(); // 阻止表单的默认提交（页面刷新）
        sendMessage(); // 发送消息
    });

    // --- 可选：让 Textarea 高度自适应 ---
    userInput.addEventListener('input', () => {
        userInput.style.height = 'auto'; // 重置高度
        userInput.style.height = userInput.scrollHeight + 'px'; // 设置为内容的实际高度
    });


    // 辅助函数：在聊天框中添加消息 (基本不变)
    function appendMessage(text, sender, isTypingPlaceholder = false, isError = false) {
        const messageElement = document.createElement('div');
        messageElement.classList.add('message', `${sender}-message`);

        // 使用 textContent 来设置文本，更安全，配合 CSS white-space 处理格式
        messageElement.textContent = text;

        if (sender === 'bot' && isTypingPlaceholder) {
            messageElement.classList.add('typing');
            // 可以给一个最小高度，避免打字时元素高度为0
            messageElement.style.minHeight = '1.5em'; // 或者其他合适的值
        }

        if (isError) {
            messageElement.style.color = 'red';
            messageElement.classList.remove('typing');
        }

        chatbox.appendChild(messageElement);
        // 延迟滚动到底部，确保元素渲染完成
        setTimeout(() => {
            chatbox.scrollTop = chatbox.scrollHeight;
        }, 0);
        return messageElement;
    }
});