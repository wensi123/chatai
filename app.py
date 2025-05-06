import os
import threading
import time # 保留用于可能的细微延迟调整
from flask import Flask, render_template, request, Response, jsonify
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM, TextIteratorStreamer

# ---- 配置 ----
# 模型加载路径 (相对于 app.py)
MODEL_PATH = "./huggingface_model"
# 检查模型路径是否存在
if not os.path.exists(MODEL_PATH) or not os.path.isdir(MODEL_PATH):
    print(f"错误：模型路径 '{MODEL_PATH}' 不存在或不是一个目录。")
    print("请确保你已经下载模型并将其放在正确的路径下。")
    exit() # 如果模型路径无效，则退出程序

# ---- 模型和 Tokenizer 加载 (在应用启动时执行一次) ----
print("正在加载模型和 Tokenizer...")
start_time = time.time()
try:
    # 确定设备 (优先使用 GPU)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"使用的设备: {device}")

    # 加载 Tokenizer
    # trust_remote_code=True 对于某些模型（如 Qwen 架构）是必需的
    tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH, trust_remote_code=True)
    print("Tokenizer 加载完成.")

    # 加载模型
    # 使用 float16 或 bfloat16 可以减少内存占用并加速 (如果GPU支持)
    # 如果在 CPU 上或遇到精度问题，可以尝试移除 torch_dtype
    model_dtype = torch.float16 if torch.cuda.is_available() else torch.float32 # 或者 bfloat16
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_PATH,
        torch_dtype=model_dtype,
        trust_remote_code=True,
        device_map='auto'# 使用 accelerate 自动分配设备 (需要安装 accelerate)
        # 如果不使用 device_map='auto'，则需要手动 .to(device)
    )
    # model = model.to(device) # 如果没有使用 device_map='auto'

    # 如果模型支持，可以将其设置为评估模式
    model.eval()

    print(f"模型加载完成. 耗时: {time.time() - start_time:.2f} 秒")

except Exception as e:
    print(f"加载模型或 Tokenizer 时出错: {e}")
    # 你可能希望在这里记录更详细的错误或采取其他措施
    exit() # 无法加载模型，退出

# ---- Flask 应用初始化 ----
app = Flask(__name__)

# ---- 路由定义 ----
@app.route('/')
def index():
    """渲染主页面 index.html"""
    return render_template('index.html')

@app.route('/chat_stream', methods=['POST'])
def chat_api_streaming():
    """接收用户消息并以流式方式返回真实模型生成的回复"""
    try:
        data = request.json
        user_message = data.get('message')
        print(f"--- New Request ---") # 标记新请求开始
        print(f"Received message: {user_message}") # 确认收到消息

        if not user_message:
            print("Error: No message provided by client.")
            return Response("event: error\ndata: {\"error\": \"No message provided\"}\n\n", mimetype='text/event-stream', status=400)

        # ---- 使用 TextIteratorStreamer 实现流式生成 ----
        streamer = TextIteratorStreamer(tokenizer, skip_prompt=True, skip_special_tokens=True)

        # ---- 关键：检查输入格式 ----
        # 再次确认 DeepSeek/Qwen 的聊天模板。错误的模板是无声失败的最常见原因。
        # 尝试使用 apply_chat_template (如果你的 transformers 版本和 tokenizer 支持)
        messages = [{"role": "user", "content": user_message}]
        try:
            # 尝试使用模板功能
            formatted_input = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
            print(f"Using apply_chat_template. Formatted Input:\n{formatted_input}")
        except Exception as template_error:
            # 如果模板功能失败，回退到手动格式化（确保这个格式正确！）
            print(f"apply_chat_template failed ({template_error}), falling back to manual format.")
            # 这个手动格式可能需要根据你的具体模型版本调整
            formatted_input = f"<|im_start|>user\n{user_message}<|im_end|>\n<|im_start|>assistant\n"
            print(f"Using manual format. Formatted Input:\n{formatted_input}")

        inputs = tokenizer(formatted_input, return_tensors="pt").to(model.device)
        print(f"Input token IDs shape: {inputs['input_ids'].shape}") # 确认输入编码成功

        generation_kwargs = dict(
            inputs,
            streamer=streamer,
            max_new_tokens=512,
            do_sample=True,
            temperature=0.7,
            top_p=0.9,
            eos_token_id=tokenizer.eos_token_id,
            pad_token_id=tokenizer.pad_token_id if tokenizer.pad_token_id else tokenizer.eos_token_id
        )
        print("Generation kwargs prepared. Starting generation thread...")

        # 在单独的线程中运行模型生成
        thread = threading.Thread(target=model.generate, kwargs=generation_kwargs)
        thread.start()
        print("Generation thread started.")

        # 定义生成器函数
        def generate_sse():
            print("generate_sse: Entered generator function.") # 确认生成器函数被调用
            tokens_yielded = 0
            try:
                for new_text in streamer:
                    tokens_yielded += 1
                    # print(f"generate_sse: Yielding token chunk: '{new_text}'") # !! 关键：确认 streamer 是否有输出
                    yield f"data: {new_text}\n\n"

                print(f"generate_sse: Streamer finished. Total token chunks yielded: {tokens_yielded}") # 确认 streamer 循环结束
                # 检查线程是否还在运行（理论上 generate 结束后线程就该结束了）
                thread.join(timeout=1) # 等待线程结束，设置超时以防万一
                if thread.is_alive():
                    print("generate_sse: Warning - Generation thread still alive after streamer finished?")

                print("generate_sse: Sending end event.")
                yield "event: end\ndata: {}\n\n"

            except Exception as e:
                print(f"generate_sse: Error during streaming: {e}")
                yield f"event: error\ndata: {{\"error\": \"模型生成时出错: {str(e)}\"}}\n\n"
            finally:
                print("generate_sse: Exiting generator function.") # 确认生成器函数结束

        print("Returning SSE Response object.")
        return Response(generate_sse(), mimetype='text/event-stream')

    except Exception as e:
        print(f"Error in chat_api_streaming (outside generator): {e}")
        # 打印完整的错误堆栈跟踪，方便调试
        import traceback
        traceback.print_exc()
        return Response(f"event: error\ndata: {{\"error\": \"服务器内部错误: {str(e)}\"}}\n\n", mimetype='text/event-stream', status=500)

# ... (Flask app run bleibt gleich)
if __name__ == '__main__':
    app.run(debug=False, host='0.0.0.0', port=5000, use_reloader=False, threaded=True)