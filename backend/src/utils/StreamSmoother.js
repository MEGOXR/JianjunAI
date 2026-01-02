/**
 * StreamSmoother
 * 用于平滑流式输出的工具类，模拟打字机效果
 * 解决 LLM 返回的不均匀数据块导致的视觉跳跃问题
 */
class StreamSmoother {
    /**
     * @param {function} onChar - 回调函数，每输出一个字符/小块时调用 (char) => void
     * @param {object} options - 配置选项
     */
    constructor(onChar, options = {}) {
        this.onChar = onChar;
        this.buffer = []; // 字符缓冲队列
        this.timer = null;
        this.isFlushing = false;
        this.flushResolve = null; // 用于 flush 的 Promise resolve

        this.options = {
            minDelay: 20,    // 最小打字间隔 (ms)
            maxDelay: 50,    // 最大打字间隔 (ms)
            chunkSize: 1,    // 每次输出的字符数
            ...options
        };
    }

    /**
     * 接收新的文本块
     * @param {string} text - 新收到的文本
     */
    push(text) {
        if (!text) return;

        // 将文本拆分为字符推入缓冲
        const chars = text.split('');
        this.buffer.push(...chars);

        // 确保处理循环在运行
        this._startProcessing();
    }

    /**
     * 开始处理循环
     * @private
     */
    _startProcessing() {
        if (this.timer || this.isPaused) return; // 已经在运行或被暂停

        const processNext = () => {
            // 如果缓冲为空
            if (this.buffer.length === 0) {
                this.timer = null;

                // 如果正在 flushing 且有等待的 promise，解决它
                if (this.isFlushing && this.flushResolve) {
                    this.flushResolve();
                    this.flushResolve = null;
                    this.isFlushing = false;
                }
                return;
            }

            // 取出下一个字符/块
            const chunk = this.buffer.splice(0, this.options.chunkSize).join('');

            // 输出
            if (this.onChar) {
                this.onChar(chunk);
            }

            // 计算下一次延迟
            let delay = this.isFlushing
                ? 5
                : Math.floor(Math.random() * (this.options.maxDelay - this.options.minDelay + 1)) + this.options.minDelay;

            if (!this.isFlushing && /[，。！？：；\n]/.test(chunk)) {
                delay += 100;
            }

            this.timer = setTimeout(processNext, delay);
        };

        processNext();
    }

    /**
     * 立即输出剩余所有缓冲 (用于对话结束时)
     * @returns {Promise<void>}
     */
    flush() {
        this.isFlushing = true;

        return new Promise((resolve) => {
            if (this.buffer.length === 0) {
                this.isFlushing = false;
                resolve();
                return;
            }

            this.flushResolve = resolve;

            // 如果没在运行，启动它
            if (!this.timer) {
                this._startProcessing();
            }
        });
    }

    /**
     * 暂停输出 (用于等待异步操作)
     */
    pause() {
        this.isPaused = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    /**
     * 恢复输出
     */
    resume() {
        this.isPaused = false;
        this._startProcessing();
    }

    /**
     * 强制清空 (出错或中断时)
     */
    clear() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.buffer = [];
        this.isFlushing = false;
        this.isPaused = false;
        if (this.flushResolve) {
            this.flushResolve();
            this.flushResolve = null;
        }
    }
}

module.exports = StreamSmoother;
